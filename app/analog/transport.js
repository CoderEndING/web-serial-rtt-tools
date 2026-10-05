import { UsbLease } from '../core/usb-device.js';
import { withTimeout } from '../rtt/dap-webusb.js';
export const ADC_EP=0x8b, ADC_BLOCK_BYTES=4096;
export function decodeAdcPacket(bytes,token){
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length<32 || String.fromCharCode(...bytes.subarray(0,4))!=='ADS2' ||
    bytes[4]!==2 || ![1,2].includes(bytes[5]) || ![8,10,12,16].includes(bytes[6]) ||
    bytes[7]!==0 || v.getUint32(8,true)!==token || bytes[26]!==6 || bytes[27]!==2)
    throw Error('ADC DMA 数据包格式或任务代数错误');
  const count=v.getUint16(24,true),rate=v.getUint32(20,true);
  if(count>2031 || bytes.length!==32+2*count || (bytes[5]===2?count!==0:!count) ||
    (count && (!rate || rate>2000000))) throw Error('ADC DMA 数据长度或速率无效');
  const codes=new Uint16Array(count);
  for(let i=0;i<count;i++){
    codes[i]=v.getUint16(32+2*i,true);
    if(codes[i]>=2**bytes[6])throw Error('ADC DMA 码值超出位宽');
  }
  return {codes,bits:bytes[6],rate,seq:v.getUint32(12,true),first:v.getUint32(16,true),
    fault:v.getUint32(28,true),done:bytes[5]===2};
}
export class AdcTransport {
  constructor(device){this.lease=new UsbLease(device,'analog');this.device=this.lease.device;this.done=false;}
  static async request(hidDevice){
    if(!globalThis.navigator?.usb)throw Error('ADC 需要桌面 Chrome/Edge WebUSB');
    const same=d=>d.vendorId===hidDevice.vendorId&&d.productId===hidDevice.productId&&
      (!hidDevice.serialNumber||d.serialNumber===hidDevice.serialNumber);
    const devices=(await navigator.usb.getDevices()).filter(same);
    const device=devices.length===1?devices[0]:await navigator.usb.requestDevice({filters:[{
      vendorId:hidDevice.vendorId,productId:hidDevice.productId,
      ...(hidDevice.serialNumber?{serialNumber:hidDevice.serialNumber}:{})}]});
    if(!same(device))throw Error('HID 和 ADC 不是同一台探针');
    const t=new AdcTransport(device);
    try{
      await t.lease.open();
      const iface=t.device.configuration.interfaces.find(i=>i.alternates.some(a=>
        a.endpoints.some(e=>e.endpointNumber===11&&e.direction==='in'&&e.type==='bulk')&&
        a.endpoints.some(e=>e.endpointNumber===11&&e.direction==='out'&&e.type==='bulk')));
      if(!iface)throw Error('当前板卡没有 SPI/ADC 共享数据接口');
      await t.lease.claim(iface.interfaceNumber,[0x0b,ADC_EP]);return t;
    }catch(e){try{await t.lease.close();}catch(cleanup){t.lease.abandon();e.message+=`；USB 清理失败：${cleanup.message}`;}throw e;}
  }
  async retireSpiOut(){
    // Only called when HID CAPS reports disabled SPI with exactly one OUT still armed.
    const native=Promise.resolve().then(()=>this.device.transferOut(11,new Uint8Array()));
    this.flush=native.finally(()=>{this.flush=null;});this.flush.catch(()=>{});
    const r=await withTimeout(this.flush,2000,'退场 SPI OUT');
    if(r.status!=='ok')throw Error('SPI OUT 退场失败');
  }
  start(token,{bits,onBlock,onFault}={}){
    if(this.pending)throw Error('上一轮 ADC USB 读取尚未结束');
    this.token=token;this.expectedBits=bits;this.onBlock=onBlock;this.onFault=onFault;
    this.done=false;this.error=null;this.seq=0;this.index=0;this.rate=null;
    this._launch();
  }
  _launch(){this.pending=this._pump().catch(e=>{this.error??=e;this.onFault?.(e);}).finally(()=>{this.pending=null;});}
  async _pump(){
    while(!this.done){
      const r=await this.device.transferIn(11,ADC_BLOCK_BYTES);
      if(r.status!=='ok'||!r.data?.byteLength)throw Error(`ADC USB 读取失败：${r.status}`);
      try{
        const p=decodeAdcPacket(new Uint8Array(r.data.buffer,r.data.byteOffset,r.data.byteLength),this.token);
        if(p.bits!==this.expectedBits || p.seq!==this.seq || p.first!==this.index ||
          (this.rate!==null&&p.rate!==this.rate))throw Error('ADC DMA 数据块不连续或配置变化');
        this.seq=(this.seq+1)>>>0;this.index=(this.index+p.codes.length)>>>0;
        if(p.codes.length)this.rate=p.rate;
        this.done=p.done;
        if(p.fault)throw Error(`ADC 已停止：${p.fault===5?'DMA 缓冲满':`硬件故障 ${p.fault}`}，未静默覆盖`);
        if(!this.error&&p.codes.length)this.onBlock?.(p);
      }catch(e){
        if(!this.error){this.error=e;this.onFault?.(e);}
        // Continue reading to END, including after a malformed block. Match END by
        // token even after a sequence fault; never abandon a native USB request.
        try{const p=decodeAdcPacket(new Uint8Array(r.data.buffer,r.data.byteOffset,r.data.byteLength),this.token);if(p.done)this.done=true;}catch{}
      }
    }
  }
  async drain(){
    if(!this.pending&&!this.done){this.onBlock=null;this._launch();}
    if(this.pending)await withTimeout(this.pending,3000,'等待 ADC END');
    if(!this.done)throw Error('ADC 数据流停止未确认');
  }
  async close(){if(this.pending||this.flush)throw Error('ADC USB 请求尚未退出，请先停止或拔插探针');await this.lease.close();}
}
