import assert from 'node:assert/strict';
import { UsbLease } from '../../app/core/usb-device.js';
import { closeProbeUsbDevices } from '../../app/core/probe-bus.js';
import { WebUsbDapProbe } from '../../app/rtt/dap-webusb.js';
const ep = (endpointNumber, direction) => ({endpointNumber, direction, type:'bulk', packetSize:512});
const iface = (interfaceNumber, endpoints) => ({interfaceNumber, alternates:[{endpoints}]});
export function fakeUsb(){
 const events = []; const device = {vendorId:0xd28,productId:0x204,opened:false,
  configuration:{interfaces:[iface(5,[ep(11,'in'),ep(11,'out')]),iface(0,[ep(1,'in'),ep(2,'out'),ep(3,'in')])]},
  async open(){events.push('open');this.opened=true;},async claimInterface(i){events.push(`claim:${i}`);},
  async releaseInterface(i){events.push(`release:${i}`);},async clearHalt(){},
  async close(){events.push('close');this.opened=false;},async reset(){events.push('reset');},
 };return {device,events};
}
const {device,events}=fakeUsb();
Object.defineProperty(globalThis,'navigator',{value:{usb:{getDevices:async()=>[device]}},configurable:true});
const spi=new UsbLease(device,'spi');await spi.open();await spi.claim(5,[0x8b,11]);
const dap=new WebUsbDapProbe();dap.device=device;dap.resync=async()=>{};
await dap._claim();assert.equal(dap.epIn,1);assert.equal(dap.epOut,2,'DAP must not pick the SPI interface listed first');
dap._ctrl=async()=>{};await dap.disconnect();
assert.ok(device.opened);assert.ok(!events.includes('reset'));assert.ok(!events.includes('close'));
assert.equal(await closeProbeUsbDevices(),0,'legacy cleanup cannot close a live independent endpoint');
await spi.close();assert.equal(events.at(-1),'close');
console.log('usb-transports: DAP disconnect/legacy cleanup preserve independent SPI interface PASS');
