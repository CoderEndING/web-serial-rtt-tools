/* WebUSB reader for ADC. USB requests and replenishment run away from the UI thread. */
let device = null, iface = null, active = false;

function reply(id, value){ self.postMessage({ id, ...value }); }
function sameDevice(d, wanted){
  return d.vendorId === wanted.vendorId && d.productId === wanted.productId &&
    (!wanted.serialNumber || d.serialNumber === wanted.serialNumber);
}
function findInterface(d, wanted){
  const config = d.configurations.find(c => c.configurationValue === 1) || d.configurations[0];
  const entry = config?.interfaces.find(i => i.alternates.some(a =>
    a.endpoints.some(e => e.endpointNumber === 11 && e.direction === 'in' && e.type === 'bulk') &&
    a.endpoints.some(e => e.endpointNumber === 11 && e.direction === 'out' && e.type === 'bulk')));
  if (!entry) throw Error('当前板卡没有 SPI/ADC 共享数据接口');
  if (wanted.interfaceNumber != null && entry.interfaceNumber !== wanted.interfaceNumber)
    throw Error('ADC USB 接口描述与页面保留的接口不一致');
  return entry.interfaceNumber;
}
async function openUsb(wanted){
  if (!navigator.usb?.getDevices){
    const e = Error('当前浏览器的 Dedicated Worker 未开放 WebUSB'); e.code = 'WORKER_USB_UNSUPPORTED'; throw e;
  }
  const matches = (await navigator.usb.getDevices()).filter(d => sameDevice(d, wanted));
  if (matches.length !== 1) throw Error(matches.length ? 'Worker 找到多台同 VID/PID 探针' : 'Worker 看不到已授权的探针');
  const d = matches[0], number = findInterface(d, wanted);
  try {
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    await d.claimInterface(number);
  } catch (error){
    try { if (d.opened) await d.close(); } catch {}
    throw error;
  }
  device = d; iface = number;
  navigator.usb.addEventListener?.('disconnect', event => {
    if (sameDevice(event.device,wanted)) self.postMessage({ event:'fault', message:'探针 USB 已断开' });
  });
  return { interfaceNumber: number };
}
function read(){
  const started=performance.now();
  try { return Promise.resolve(device.transferIn(11,4096)).then(result => ({ result,started,at:performance.now() }), error => ({ error,started,at:performance.now() })); }
  catch(error){ return Promise.resolve({ error,started,at:performance.now() }); }
}
function isEnd(view, token){
  return view.byteLength >= 32 && view.getUint8(0) === 0x41 && view.getUint8(1) === 0x44 &&
    view.getUint8(2) === 0x53 && view.getUint8(3) === 0x32 && view.getUint8(5) === 2 &&
    view.getUint32(8,true) === token;
}
async function pump({ token, inFlight }){
  if (active) throw Error('上一轮 ADC Worker 读取尚未退场');
  active = true;
  const queue = Array.from({ length: inFlight }, () => read());
  let ends = 0, failed = false, faultSent = false, reads = 0, maxReadMs = 0, lastAt = 0, maxGapMs = 0;
  try {
    while(queue.length){
      const { result, error, started, at:completed } = await queue.shift();reads++;
      maxReadMs=Math.max(maxReadMs,completed-started);
      if(lastAt)maxGapMs=Math.max(maxGapMs,completed-lastAt);
      lastAt=completed;
      if (error || result?.status !== 'ok' || !result.data?.byteLength){
        failed = true;
        if (!faultSent){ faultSent = true; self.postMessage({ event:'fault', message:error?.message || `ADC USB 读取失败：${result?.status}` }); }
        continue;
      }
      const data = result.data;
      const source = new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
      const end = isEnd(new DataView(data.buffer,data.byteOffset,data.byteLength),token);
      if (end) ends++;
      if (!ends && !failed) queue.push(read());
      // Copy into a transferable buffer; WebUSB owns the original response buffer.
      const frame = source.slice();
      self.postMessage({ event:'packet', buffer:frame.buffer, completedAt:completed },[frame.buffer]);
    }
    self.postMessage({ event:'drained', complete:ends === inFlight, ends, expected:inFlight,
      metrics:{nativeReads:reads,nativePeak:inFlight,maxReadAwaitMs:maxReadMs,maxCompletionGapMs:maxGapMs} });
  } catch(error){
    self.postMessage({ event:'fault', message:error?.message || String(error) });
    self.postMessage({ event:'drained', complete:false, ends, expected:inFlight,
      metrics:{nativeReads:reads,nativePeak:inFlight,maxReadAwaitMs:maxReadMs,maxCompletionGapMs:maxGapMs} });
  } finally { active = false; }
}
async function closeUsb(){
  if (active) throw Error('ADC Worker 仍有 USB 读取');
  if (!device) return { closed:true };
  try { if (device.opened) await device.releaseInterface(iface); }
  finally { try { if (device.opened) await device.close(); } finally { device = null; iface = null; } }
  return { closed:true };
}

self.onmessage = async ({ data }) => {
  const { id, action } = data || {};
  try {
    let value = {};
    if (action === 'open') value = await openUsb(data.device);
    else if (action === 'start') {
      // Submit all reads synchronously before acknowledging; the page then sends ADC START over HID.
      const task = pump(data);
      reply(id,{ ok:true });
      await task;
      return;
    } else if (action === 'out') {
      if (!device) throw Error('ADC Worker USB 尚未打开');
      const result = await device.transferOut(11,new Uint8Array());
      value = { status:result.status };
    } else if (action === 'close') value = await closeUsb();
    else throw Error(`未知 ADC Worker 操作：${action}`);
    reply(id,{ ok:true,...value });
  } catch(error){
    reply(id,{ ok:false, code:error?.code || null, error:error?.message || String(error) });
  }
};
