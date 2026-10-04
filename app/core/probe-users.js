import { ProbeManager } from './probe-manager.js';
import { CdcMode, isProbeCdcPort } from './cdc-mode.js';

// Bulk endpoints are independent. Target accesses still share one SWD/JTAG engine.
// SPI/I2C bridges exist only on EVKLite: SPI2 PB10..15, debug PA04..08.
// SPI auxiliary pads may use I2C's PA28/29, so retain their pin exclusion.
export const PROBE_RESOURCES = Object.freeze({
  dbg: ['target-engine', 'debug-pins', 'dap-bulk'],
  rtt: ['target-engine', 'debug-pins', 'rtt-ring', 'dap-bulk'],
  scope: ['target-engine', 'debug-pins', 'scope-stream'],
  hid: ['target-engine', 'debug-pins', 'rtt-ring', 'cdc-mode'],
  spi: ['spi-bulk', 'spi-pins', 'i2c-pins'],
  i2c: ['i2c-pins'],
  serial: ['cdc-port'],
  flash: ['target-engine', 'debug-pins', 'rtt-ring', 'dap-bulk', 'cdc-mode'],
});

/** Resource declarations and teardown adapters are the only place that knows other features. */
export function createProbeManager(t, { bus = null, locks } = {}){
  const manager = new ProbeManager({ locks, beforeAcquire: async reason => {
    if (bus?.supported) await bus.requestRelease({ why: reason });
  } });
  const register = (id, active, release, guarded) => manager.register(id, {
    resources: PROBE_RESOURCES[id], active, release, protected: guarded,
  });
  register('flash', () => !!t.flash?.busy, async () => {}, () => !!t.flash?.busy);
  register('dbg', () => !!t.dbg?.session?.connected && t.dbg?.session?.backendName !== '模拟目标',
    () => t.dbg.disconnect());
  register('rtt', () => !!(t.rtt?.probe || t.rtt?.bridge) && !t.rtt?._probeMock,
    async () => {
      const pending = t.rtt?._connectPromise;
      await t.rtt.disconnect();
      if (pending) await pending.catch(() => {});
    });
  register('scope', () => !!(t.scope && !t.scope.usingMock &&
    (t.scope.running || t.scope.transport || (t.scope.hid && t.scope.hid !== t.scope.mockProbe))),
    why => t.scope.releaseProbe(why));
  register('hid', () => !t.hid?.mock && !!(t.hid?.last?.running || t.hid?._bridgeRequested),
    async () => { await t.hid.stop({ fromManager: true }); await t.hid.dev?.close?.(); });
  register('spi', () => !t.spiSession?.usingMock && !!(t.spiSession?.connected || t.spiSession?.dataReady),
    async () => { t.spi?.abortLoop?.(); t.panel?.anim?.stop?.(); await t.spiSession.teardown(); },
    () => !t.spiSession?.usingMock && !!t.spiSession?.busy);
  register('i2c', () => !t.i2c?.session?.usingMock && !!t.i2c?.session?.connected,
    async () => { t.i2c?.runner?.stop(); await t.i2c.session.disconnect(); });
  register('serial', () => !!t.session?.isOpen && isProbeCdcPort(t.session.port),
    () => t.session?.close());
  manager.cdcMode = new CdcMode(t, manager);
  manager.assertUsbResetAllowed = (kind, device) => {
    const own = { dap: ['dbg', 'rtt', 'flash'], scope: ['scope'], spi: ['spi'] }[kind] || [];
    const peers = [...manager.clients].filter(([id, c]) => !own.includes(id) &&
      (manager.leases.has(id) || c.active())).map(([id]) => id);
    let info = {};
    try { info = t.session?.port?.getInfo?.() || {}; } catch {}
    if (t.session?.isOpen && info.usbVendorId === device.vendorId && info.usbProductId === device.productId)
      peers.push('CDC 串口');
    if (peers.length) throw new Error(`USB 整设备复位需要先断开 ${[...new Set(peers)].join('、')}`);
  };
  return manager;
}

/** Legacy handoff API, retained for standalone clients. The application uses the persistent manager. */
export async function releaseLocalProbeUsers(keep, why = '另一个功能要使用探针'){
  const t = globalThis.__tools || globalThis.window?.__tools;
  if (!t) return;
  return await (t.probeManager || createProbeManager(t)).releaseOthers(keep, why);
}
