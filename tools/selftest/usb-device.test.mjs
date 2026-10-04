import assert from 'node:assert/strict';
import { UsbLease, usbDeviceInUse, setUsbResetGuard } from '../../app/core/usb-device.js';
const events = [];
const device = { opened: false, configuration: null,
  async open(){ events.push('open'); this.opened = true; },
  async selectConfiguration(){ this.configuration = {}; events.push('config'); },
  async claimInterface(i){ events.push(`claim:${i}`); },
  async releaseInterface(i){ events.push(`release:${i}`); },
  async reset(){ events.push('reset'); }, async close(){ events.push('close'); this.opened = false; },
};
const dap = new UsbLease(device, 'dap'), scope = new UsbLease(device, 'scope'), spi = new UsbLease(device, 'spi');
await Promise.all([dap.open(), scope.open(), spi.open()]);
await dap.claim(0, [0x81, 2]); await scope.claim(0, [0x83]); await spi.claim(5, [0x8b, 11]);
assert.deepEqual(events, ['open', 'config', 'claim:0', 'claim:5']);
await assert.rejects(dap.reset(), /scope.*spi/); assert.ok(!events.includes('reset'));
const duplicate = new UsbLease(device, 'duplicate'); await assert.rejects(duplicate.claim(0, [0x81]), /端点/); await duplicate.close();
await scope.close(); assert.ok(!events.includes('release:0'), 'shared interface remains claimed');
await dap.close(); assert.ok(device.opened); assert.equal(events.at(-1), 'release:0');
setUsbResetGuard(() => { throw new Error('CDC still open'); });
await assert.rejects(spi.close({dirty:true}), /CDC still open/); assert.ok(usbDeviceInUse(device));
setUsbResetGuard(null); await spi.close({dirty:true});
assert.deepEqual(events.slice(-2), ['reset', 'close']); assert.ok(!usbDeviceInUse(device));
// Enumeration aliases with a nonempty serial share the canonical handle.
const first = {...device, vendorId: 0xd28, productId: 0x204, serialNumber: 'lease-test', opened:false};
const alias = {...first}; const a = new UsbLease(first, 'a'), b = new UsbLease(alias, 'b');
assert.equal(a.device, b.device); await a.open(); assert.ok(usbDeviceInUse(alias)); await a.close();
const noSerialA = new UsbLease({...device}, 'a'), noSerialB = new UsbLease({...device}, 'b');
assert.notEqual(noSerialA.device, noSerialB.device);
console.log('usb-device: shared lifecycle, endpoint exclusion, interface refs, guarded reset, alias identity PASS');
