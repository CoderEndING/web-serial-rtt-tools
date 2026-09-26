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
