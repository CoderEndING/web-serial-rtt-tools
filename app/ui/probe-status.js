import { PROBE_FEATURES } from '../core/probe-users.js';
import { setFlag } from './dom.js';

/** Only inspect local connection/lease state; never query hardware from the header. */
export function probeStatus(tools){
  const manager = tools.probeManager;
  const { pending = [], failures = [] } = manager?.summary() || {};
  const name = id => PROBE_FEATURES.find(f => f.id === id)?.label || id;
  if (failures.length) return { text:'探针：需恢复', kind:'err', title:failures.map(f => `${name(f.owner)}：${f.error}`).join('\n') };
  if (pending.length) return { text:'探针：切换中', kind:'warn', title:pending.map(p => name(p.owner)).join('、') };
  const active = PROBE_FEATURES.filter(f => f.active(tools)).map(f => f.label);
  return active.length
    ? { text:`探针：${active.length === 1 ? active[0] : `${active.length} 项连接`}`, kind:'on', title:`当前连接：${active.join('、')}` }
    : { text:'探针：未使用', kind:'off', title:'当前页面没有功能连接实体探针；串口连接状态单独显示。' };
}

export function initProbeStatus(tools){
  const serial = document.getElementById('conn-flag');
  setFlag(serial, tools.session.isOpen ? '串口：已连接' : '串口：未连接', tools.session.isOpen ? 'on' : 'off');
  tools.session.on('open', ({ info, opts }) => {
    setFlag(serial, '串口：已连接', 'on'); serial.title = `${info} @${opts.baudRate}`;
  });
  tools.session.on('close', () => { setFlag(serial, '串口：未连接'); serial.title = ''; });
  const el = document.getElementById('probe-flag');
  let previous = '';
  const update = () => {
    const state = probeStatus(tools), key = JSON.stringify(state);
    if (key === previous) return;
    previous = key;
    el.textContent = state.text; el.title = state.title; el.className = `flag flag-${state.kind}`;
  };
  update();
  // No DOM writes while unchanged, including during high-rate capture.
  setInterval(update, 1000);
}
