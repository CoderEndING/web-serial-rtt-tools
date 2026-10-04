/** Shared device/interface lifecycle. transferIn/Out deliberately bypass this queue. */
const byDevice = new WeakMap();
const bySerial = new Map();
let resetGuard = null;
export function setUsbResetGuard(fn){ resetGuard = fn; }
function entryFor(device){
  let e = byDevice.get(device);
  if (e) return e;
  // No serial number means no safe way to merge two distinct device objects.
  const key = device.serialNumber ? `${device.vendorId}:${device.productId}:${device.serialNumber}` : null;
  e = (key && bySerial.get(key)) || { device, clients: new Set(), interfaces: new Map(), chain: Promise.resolve() };
  byDevice.set(device, e);
  if (key) bySerial.set(key, e);
  return e;
}
export function usbDeviceInUse(device){ return !!entryFor(device).clients.size; }

export class UsbLease {
  constructor(device, owner){
    this.entry = entryFor(device);
    this.device = this.entry.device;
    this.owner = owner;
    this.claims = new Map();
  }
  _run(fn){
    const e = this.entry;
    const p = e.chain.then(fn);
    e.chain = p.catch(() => {});
    return p;
  }
  async _io(fn){
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('USB 生命周期操作超时，请断开其它功能后重试恢复')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async _open(){
    const d = this.device;
    // Reserve before open, so cleanup cannot close a handle during setup.
    this.entry.clients.add(this);
    if (!d.opened) await this._io(() => d.open());
    if (d.configuration === null) await this._io(() => d.selectConfiguration(1));
  }
  open(){ return this._run(() => this._open()); }
  claim(iface, endpoints){
    return this._run(async () => {
      await this._open();
      const e = this.entry;
      for (const c of e.clients){
        if (c === this) continue;
        for (const eps of c.claims.values()) if (endpoints.some(ep => eps.has(ep)))
          throw new Error(`USB 端点正在被 ${c.owner} 使用`);
      }
      let owners = e.interfaces.get(iface);
      if (!owners){
        await this._io(() => this.device.claimInterface(iface));
        owners = new Set(); e.interfaces.set(iface, owners);
      }
      owners.add(this);
      this.claims.set(iface, new Set(endpoints));
    });
  }
  async _release(iface){
    const owners = this.entry.interfaces.get(iface);
    if (!owners?.has(this)) return;
    if (owners.size === 1 && this.device.opened)
      await this._io(() => this.device.releaseInterface(iface));
    owners.delete(this);
    if (!owners.size) this.entry.interfaces.delete(iface);
    this.claims.delete(iface);
  }
  release(iface){ return this._run(() => this._release(iface)); }
  async _reset(){
    const others = [...this.entry.clients].filter(c => c !== this);
    if (others.length) throw new Error(`USB 整设备复位需要先断开 ${others.map(c => c.owner).join('、')}`);
    await resetGuard?.(this.owner, this.device);
    await this._io(() => this.device.reset());
    this.entry.interfaces.clear();
    this.claims.clear();
  }
  reset(){ return this._run(() => this._reset()); }
  close({ dirty = false } = {}){
    return this._run(async () => {
      if (dirty) await this._reset(); // Failure retains the lease and native requests.
      for (const iface of [...this.claims.keys()]) await this._release(iface);
      if (this.entry.clients.size <= 1) await this._io(() => this.device.close());
      this.entry.clients.delete(this);
    });
  }
}
