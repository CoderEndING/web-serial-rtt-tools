/**
 * 源码文件仓 —— 「停下来显示当前源码行」的另一半（行号表那一半在 `app/elf/lines.js`）。
 *
 * 浏览器**读不到**你磁盘上的 `.c`（安全模型），所以必须由用户明确给一次权限。两条路：
 *   ① `showDirectoryPicker()`（File System Access，Chromium 系；http://127.0.0.1 与 https 下可用）
 *      —— 选一次工程目录，之后按需读文件，**不用重复授权**（句柄可以留着）；
 *   ② `<input type="file" webkitdirectory>`（老浏览器兜底）—— 拿到的是 File 快照，
 *      文件后来改了要重新选一次目录。
 *
 * 命中率的关键在 `resolve()`：ELF 里记的是**编译机上的绝对路径**
 * （`E:/proj/src/main.c`，甚至跟同事机器上的路径不一样），而用户选的目录可能是
 * `E:/proj`、`E:/proj/MDK-ARM` 或它的父目录。所以按"从最长后缀开始逐级尝试"匹配，
 * 再退到"同名文件唯一就认它"。匹配不上就老实说"没找到源文件"，不猜别的文件。
 */

const MAX_FILES = 20000;
const MAX_DEPTH = 14;
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;         // 单个源文件读取上限（防手滑选到整个磁盘）
const MAX_CACHE = 120;

export const normSlashes = p => String(p ?? '').replace(/\\/g, '/');
export const baseNameOf = p => normSlashes(p).split('/').pop() || '';

export class SourceStore {
  constructor(){
    this.rootName = '';
    this.byRel = new Map();          // 相对路径（小写）→ 条目
    this.byBase = new Map();         // 文件名（小写）→ 条目数组
    this.entries = [];
    this.text = new Map();           // 路径（小写）→ 文本
    this.note = '';
  }

  static supported(){
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  get ready(){ return this.entries.length > 0; }
  get count(){ return this.entries.length; }

  summary(){
    if (!this.ready) return this.note || '还没选源码目录';
    return `源码目录「${this.rootName}」：${this.entries.length} 个文件`
      + (this.note ? `　⚠ ${this.note}` : '');
  }

  clear(){
    this.byRel.clear(); this.byBase.clear(); this.entries = []; this.text.clear();
    this.rootName = ''; this.note = '';
  }

  _put(entry){
    this.entries.push(entry);
    const rel = entry.rel.toLowerCase();
    if (!this.byRel.has(rel)) this.byRel.set(rel, entry);
    const b = entry.base.toLowerCase();
    if (!this.byBase.has(b)) this.byBase.set(b, []);
    this.byBase.get(b).push(entry);
  }

  /** 路径①：选目录（Chromium；必须由用户点击触发） */
  async pick(){
    if (!SourceStore.supported()) throw new Error('这个浏览器不支持选目录（用「选择源码文件夹…」那个按钮，或换 Chrome/Edge）');
    const dir = await window.showDirectoryPicker({ id: 'dbg-src', mode: 'read' });
    this.clear();
    this.rootName = dir.name || '';
    await this._walk(dir, '', 0);
    return this.summary();
  }

  async _walk(dir, prefix, depth){
    if (depth > MAX_DEPTH) return;
    for await (const [name, h] of dir.entries()){
      if (this.entries.length >= MAX_FILES){ this.note = `文件数超过 ${MAX_FILES}，只索引了前面这些`; return; }
      if (h.kind === 'directory'){
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        await this._walk(h, prefix ? `${prefix}/${name}` : name, depth + 1);
      } else {
        this._put({ rel: prefix ? `${prefix}/${name}` : name, base: name, kind: 'handle', h });
      }
    }
  }

  /** 路径②：`<input webkitdirectory>` / 拖进来的 FileList（老浏览器兜底） */
  indexFileList(list){
    this.clear();
    const arr = Array.from(list || []);
    this.rootName = (arr[0]?.webkitRelativePath || '').split('/')[0] || '（已选文件夹）';
    for (const f of arr){
      if (this.entries.length >= MAX_FILES) break;
      const rel = normSlashes(f.webkitRelativePath || f.name).replace(/^[^/]+\//, '');
      this._put({ rel, base: baseNameOf(rel), kind: 'file', h: f });
    }
    return this.summary();
  }

  /** ELF 里的路径 → 索引里的条目（匹配不上返回 null） */
  resolve(p){
    const full = normSlashes(p);
    if (!full || !this.ready) return null;
    const parts = full.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++){                 // 从最长后缀开始试
      const hit = this.byRel.get(parts.slice(i).join('/').toLowerCase());
      if (hit) return hit;
    }
    const same = this.byBase.get(baseNameOf(full).toLowerCase());
    if (same?.length === 1) return same[0];                 // 同名只有一个 → 认它
    return null;
  }

  /** 读源码（带缓存）；找不到/读不了**抛人话错误**，界面照实显示 */
  async read(p){
    const key = normSlashes(p).toLowerCase();
    if (this.text.has(key)) return this.text.get(key);
    const entry = this.resolve(p);
    if (!entry) throw new Error(`源码目录里找不到 ${baseNameOf(p)}（点「选择源码目录…」选到它的上级目录；ELF 里记的是 ${p}）`);
    let file;
    try {
      file = entry.kind === 'handle' ? await entry.h.getFile() : entry.h;
    } catch (e){
      throw new Error(`打不开 ${entry.rel}：${e?.message || e}（浏览器的目录授权可能被回收了，重新选一次目录）`);
    }
    if (file.size > MAX_FILE_BYTES) throw new Error(`${entry.rel} 有 ${(file.size / 1048576).toFixed(1)} MB，太大不读`);
    const txt = await file.text();
    if (this.text.size >= MAX_CACHE) this.text.delete(this.text.keys().next().value);
    this.text.set(key, txt);
    return txt;
  }
}
