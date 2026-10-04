import { ProbeManager } from './probe-manager.js';

// Current bulk drivers close/reset the whole USBDevice, so separate bulk interfaces
// still conflict on usb-device. I2C has fixed PA28/PA29 pins, independent of SWD/SPI.
export const PROBE_RESOURCES = Object.freeze({
  dbg: ['target-engine', 'debug-pins', 'usb-device'],
  rtt: ['target-engine', 'debug-pins', 'rtt-ring', 'usb-device'],
  scope: ['target-engine', 'debug-pins', 'usb-device', 'scope-stream'],
  hid: ['target-engine', 'debug-pins', 'rtt-ring', 'cdc-mode'],
  // Auxiliary SPI pads are configurable, including PA28/PA29 and alternate-board debug pins.
  spi: ['usb-device', 'spi-pins', 'i2c-pins', 'debug-pins'],
  i2c: ['i2c-pins'],
  flash: ['target-engine', 'debug-pins', 'rtt-ring', 'usb-device', 'scope-stream', 'cdc-mode', 'spi-pins', 'i2c-pins'],
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
  register('hid', () => !t.hid?.mock && !!t.hid?.last?.running,
    async () => { await t.hid.stop({ fromManager: true }); await t.hid.dev?.close?.(); });
  register('spi', () => !t.spiSession?.usingMock && !!(t.spiSession?.connected || t.spiSession?.dataReady),
    async () => { t.spi?.abortLoop?.(); t.panel?.anim?.stop?.(); await t.spiSession.teardown(); },
    () => !t.spiSession?.usingMock && !!t.spiSession?.busy);
  register('i2c', () => !t.i2c?.session?.usingMock && !!t.i2c?.session?.connected,
    async () => { t.i2c?.runner?.stop(); await t.i2c.session.disconnect(); });
  return manager;
}

/** Legacy handoff API, retained for standalone clients. The application uses the persistent manager. */
export async function releaseLocalProbeUsers(keep, why = '另一个功能要使用探针'){
  const t = globalThis.__tools || globalThis.window?.__tools;
  if (!t) return;
  return await (t.probeManager || createProbeManager(t)).releaseOthers(keep, why);
}
