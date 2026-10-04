/** Same-page engine handoff. Release complete sessions before touching USB handles. */
export async function releaseLocalProbeUsers(keep, why = '另一个功能要使用探针'){
  const t = globalThis.__tools || globalThis.window?.__tools;
  if (!t) return;
  if (keep !== 'flash' && t.flash?.busy) throw new Error('烧录器正在使用探针，请等待完成');
  if (keep !== 'dbg' && (t.dbg?.session?.connected || t.dbg?._connecting)) await t.dbg.disconnect();
  if (keep !== 'rtt' && (t.rtt?.probe || t.rtt?.bridge || t.rtt?._connectPromise)){
    const pending = t.rtt._connectPromise;
    await t.rtt.disconnect();
    if (pending) await pending.catch(() => {});
  }
  const sc = t.scope;
  if (keep !== 'scope' && sc && (sc.running || sc._starting || sc.transport || (sc.hid && sc.hid !== sc.mockProbe)))
    await sc.releaseProbe(why);
  const fw = t.hid;
  if (keep !== 'hid' && fw && (fw.last?.running || fw._starting || (fw.dev?.connected && !fw.mock))) await fw.stop();
  if (t.spiSession?.connected || t.spiSession?.dataReady) await t.spiSession.teardown();
  if (t.i2c?.runner?.running) t.i2c.runner.stop();
  if (t.i2c?.session?.connected) await t.i2c.session.disconnect();
}
