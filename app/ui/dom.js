/** 小型 DOM 助手。 */
export const $ = id => document.getElementById(id);

/**
 * 分段按钮组（HTML 里 <div class="seg" data-group="xxx">），返回可读写的小对象。
 * 独立成函数是因为到处都要用（ASCII/HEX、终端/文本/HEX…）。
 */
export function seg(group, initial, onChange){
  const btns = [...group.querySelectorAll('button')];
  let val = initial;
  const api = {
    get value(){ return val; },
    set(v){
      val = v;
      for (const b of btns) b.classList.toggle('on', b.dataset.v === v);
    },
    enable(on){ for (const b of btns) b.disabled = !on; },
  };
  for (const b of btns){
    b.addEventListener('click', () => {
      if (b.dataset.v === val) return;
      api.set(b.dataset.v);
      onChange?.(val);
    });
  }
  api.set(initial);
  return api;
}

/** 顶栏状态标签 */
export function setFlag(el, text, kind){
  el.textContent = text;
  el.className = 'flag ' + (kind === 'on' ? 'flag-on' : kind === 'warn' ? 'flag-warn' : 'flag-off');
}

/** 状态行文本 + 颜色类 */
export function setStatus(el, text, kind){
  el.textContent = text;
  el.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
}

/** 防抖 */
export function debounce(fn, ms = 120){
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** kHz → 人看的标签：8000 → "8 MHz"、500 → "500 kHz" */
export function mhzLabel(khz){
  const n = Number(khz);
  if (!n) return '';
  return n >= 1000 ? (n / 1000) + ' MHz' : n + ' kHz';
}

/**
 * 给下拉框补一个"当前值"选项。
 * localStorage 里可能存着老版本的值（比如 8000/12000/20000 —— 新候选里没有），
 * 不补的话 select 会显示成空白或跳回第一项，等于**悄悄改了用户的设置**。
 */
export function ensureSelectOption(sel, value, label){
  const v = String(value ?? '');
  if (!sel || v === '' || [...sel.options].some(o => o.value === v)) return;
  const o = document.createElement('option');
  o.value = v;
  o.textContent = label || v;
  sel.appendChild(o);
}
