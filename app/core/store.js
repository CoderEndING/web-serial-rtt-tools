/**
 * 设置持久化：所有界面选项都存 localStorage，刷新不丢。
 * 用法：store.bind(el, 'serial.baud')            // 双向绑定（值）
 *       store.bind(el, 'serial.ts', 'checked')   // 复选框
 *       store.get('serial.baud', '115200')
 */
const KEY = 'serial-rtt-tools:v1';

class Store {
  constructor(){
    this.d = {};
    try { this.d = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { this.d = {}; }
  }
  get(k, dflt){
    const v = this.d[k];
    return v === undefined ? dflt : v;
  }
  set(k, v){
    if (this.d[k] === v) return;
    this.d[k] = v;
    this._save();
  }
  _save(){
    try { localStorage.setItem(KEY, JSON.stringify(this.d)); } catch {}
  }
  /**
   * 把 DOM 控件与设置项绑起来；返回当前值。
   *
   * 单向就够：控件 → localStorage（读回时由这个函数 apply 一次）。
   * 🚨 原来这里还 push 了一份 `apply` 到 `this._binds`，说是"同步用"，但**没有任何地方调用过它**
   *    （代码审查抓到的死代码）。真要实现"同一个 key 绑多个控件、改一处刷另一处"，得先跳过
   *    触发事件的那个元素 —— 否则给它重设 value 会把光标顶到末尾（文本输入框里很烦）。
   *    眼下 44 处绑定没有重复 key，所以直接删掉，别留一个假装存在的机制。
   */
  bind(el, key, kind = 'value'){
    const apply = () => {
      const v = this.d[key];
      if (v === undefined) return;
      if (kind === 'checked') el.checked = !!v;
      else el.value = v;
    };
    apply();
    const ev = (el.tagName === 'SELECT' || kind === 'checked') ? 'change' : 'input';
    el.addEventListener(ev, () => {
      this.set(key, kind === 'checked' ? el.checked : el.value);
    });
    return kind === 'checked' ? el.checked : el.value;
  }
}

export const store = new Store();
