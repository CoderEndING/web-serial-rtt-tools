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
    this._binds = [];
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
  /** 把 DOM 控件与设置项绑起来；返回当前值 */
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
    this._binds.push(apply);
    return kind === 'checked' ? el.checked : el.value;
  }
}

export const store = new Store();
