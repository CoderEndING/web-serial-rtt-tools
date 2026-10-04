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
  constructor(device, owner, { timeoutMs = 5000 } = {}){
    this.entry = entryFor(device);
    this.device = this.entry.device;
    this.owner = owner;
    this.timeoutMs = timeoutMs;
    this.claims = new Map();
  }
  _run(fn){
    const e = this.entry;
    const p = e.chain.then(() => {
      if (e.unsettled) throw new Error('上一次 USB 生命周期操作仍未退出，请等待或拔插探针');
      return fn();
    });
    e.chain = p.catch(() => {});
    return p;
  }
  async _io(fn){
    let timer, timedOut = false;
    const native = Promise.resolve().then(fn);
    native.then(() => { if (timedOut) this.entry.unsettled = false; }, () => { if (timedOut) this.entry.unsettled = false; });
    try {
      return await Promise.race([native, new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true; this.entry.unsettled = true; this.entry.fault = true;
          reject(new Error('USB 生命周期操作超时，请断开其它功能后重试恢复'));
        }, this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async _open(){
    const d = this.device;
    const others = [...this.entry.clients].filter(c => c !== this);
    // Failed setup may have no caller left to retry cleanup. Recover only after all
    // live peers have released; abandoned native requests still require a reset.
    if (others.length && others.every(c => c.abandoned)){
      if (!d.opened) await this._io(() => d.open());
      await this._reset();
    }
    if (this.entry.fault) throw new Error('USB 生命周期状态未确认，需要独占复位恢复');
    // Reserve before open, so cleanup cannot close a handle during setup.
    this.entry.clients.add(this);
    this.abandoned = false;
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
    const others = [...this.entry.clients].filter(c => c !== this && !c.abandoned);
    if (others.length) throw new Error(`USB 整设备复位需要先断开 ${others.map(c => c.owner).join('、')}`);
    await resetGuard?.(this.owner, this.device);
    await this._io(() => this.device.reset());
    this.entry.fault = false;
    this.entry.interfaces.clear();
    this.claims.clear();
    for (const c of this.entry.clients) if (c.abandoned){ c.claims.clear(); this.entry.clients.delete(c); }
  }
  abandon(){ this.abandoned = true; }
  reset(){ return this._run(() => this._reset()); }
  close({ dirty = false } = {}){
    return this._run(async () => {
      if (dirty || this.entry.fault) await this._reset(); // Failure retains the lease and native requests.
      for (const iface of [...this.claims.keys()]) await this._release(iface);
      if (this.entry.clients.size <= 1) await this._io(() => this.device.close());
      this.entry.clients.delete(this);
    });
  }
}
