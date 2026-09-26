/** 收发计数器：总量 + 滑动 1 秒速率。 */
export class Counter {
  constructor(){ this.total = 0; this.frames = 0; this._win = []; }
  add(n, t = performance.now()){
    this.total += n; this.frames++;
    this._win.push([t, n]);
    if (this._win.length > 4096) this._win.splice(0, 1024);
  }
  rate(now = performance.now()){
    while (this._win.length && now - this._win[0][0] > 1000) this._win.shift();
    let s = 0;
    for (const [, n] of this._win) s += n;
    return s;
  }
  reset(){ this.total = 0; this.frames = 0; this._win = []; }
}
