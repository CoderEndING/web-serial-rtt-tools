import { UsbLease } from '../core/usb-device.js';
import { withTimeout } from '../rtt/dap-webusb.js';
export const ADC_EP = 0x8c;
export function decodeAdcPacket(bytes, token){
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'ADC1' ||
      bytes[4] !== 1 || ![1, 2].includes(bytes[5]) || bytes[7] !== 26 ||
      bytes[6] > 19 || bytes.length !== 16 + 26 * bytes[6] || v.getUint32(8, true) !== token ||
      (bytes[5] === 2 ? bytes[6] !== 0 : bytes[6] === 0)) throw Error('ADC Bulk 数据包格式或任务代数错误');
  const rows = [];
  for (let i = 0; i < bytes[6]; i++){
    const off = 16 + 26 * i, len = bytes[off + 23];
    if (len > 2 || (!bytes[off + 22] && len !== 2)) throw Error('ADC Bulk 样本长度错误');
    rows.push({ seq: v.getUint32(off, true), epoch: v.getUint32(off + 4, true),
      cycle: v.getUint32(off + 8, true), timeMs: v.getUint32(off + 12, true),
      skipped: v.getUint32(off + 16, true), slot: bytes[off + 20], step: bytes[off + 21],
      err: bytes[off + 22], data: bytes.slice(off + 24, off + 24 + len) });
  }
  return { rows, done: bytes[5] === 2, fault: v.getUint32(12, true) };
}
/** One native read: END completes it, no abandoned reads or whole-device reset. */
export class AdcTransport {
  constructor(device){ this.lease = new UsbLease(device, 'analog'); this.device = this.lease.device; this.rows = []; this.done = false; this.error = null; }
  static async request(hidDevice){
    if (!globalThis.navigator?.usb) throw Error('ADC Bulk 需要桌面版 Chrome/Edge WebUSB');
    const same = d => d.vendorId === hidDevice.vendorId && d.productId === hidDevice.productId &&
      (!hidDevice.serialNumber || d.serialNumber === hidDevice.serialNumber);
    const devices = (await navigator.usb.getDevices()).filter(same);
    const device = devices.length === 1 ? devices[0] : await navigator.usb.requestDevice({
      filters: [{ vendorId: hidDevice.vendorId, productId: hidDevice.productId,
        ...(hidDevice.serialNumber ? { serialNumber: hidDevice.serialNumber } : {}) }] });
    if (!same(device)) throw Error('HID 和 ADC 数据端点不是同一台探针');
    const t = new AdcTransport(device);
    try {
      await t.lease.open();
      const iface = device.configuration.interfaces.find(i => i.alternates.some(a =>
        a.endpoints.some(e => e.endpointNumber === 12 && e.direction === 'in' && e.type === 'bulk')));
      if (!iface) throw Error('固件没有独立 ADC Bulk IN 0x8C，请更新固件');
      await t.lease.claim(iface.interfaceNumber, [ADC_EP]);
      return t;
    } catch (e){
      try { await t.lease.close(); } catch (cleanup){ t.lease.abandon(); e.message += `；USB 清理失败：${cleanup.message}`; }
      throw e;
    }
  }
  start(token){
    if (this.pending) throw Error('上一轮 ADC USB 读取尚未结束');
    this.rows = []; this.done = false; this.error = null; this.lastSeq = null;
    this.pending = this._pump(token).catch(e => { this.error = e; }).finally(() => { this.pending = null; });
  }
  async _pump(token){
    while (!this.done){
      const r = await this.device.transferIn(12, 512);
      if (r.status !== 'ok' || !r.data?.byteLength) throw Error(`ADC Bulk 读取失败：${r.status}`);
      const p = decodeAdcPacket(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength), token);
      for (const row of p.rows){
        if (this.lastSeq !== null && row.seq !== ((this.lastSeq + 1) >>> 0)) throw Error('ADC Bulk 序号不连续，采集已停止');
        this.lastSeq = row.seq;
      }
      if (this.rows.length + p.rows.length > 2048) throw Error('网页 ADC 结果缓冲满');
      this.rows.push(...p.rows); this.done = p.done;
      // Keep reading through END even on a producer fault, so cleanup can retire USB.
      if (p.fault) this.error = Error(`ADC 采集故障：${p.fault}（缓冲满时不会静默覆盖）`);
    }
  }
  async read(){ if (this.error) throw this.error; return this.rows.shift() || null; }
  async drain(){
    if (this.pending) await withTimeout(this.pending, 3000, '等待 ADC END 数据包');
    if (!this.done && !this.error) throw Error('ADC 数据流停止未确认');
  }
  async close(){ if (this.pending) throw Error('ADC 仍有挂起 USB 读取，请先停止或拔插探针'); await this.lease.close(); }
}
