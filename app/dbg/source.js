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

/**
 * 索引文件数上限。
 *
 * 🚨 2026-10 真机现场：HPM6800EVK + lwip_tcpecho 的 ELF，DWARF 里记的是编译机绝对路径
 *    `E:/sdk_env_v1.11.0/hpm_sdk/...`，而 `hpm_sdk` 有 **33255** 个文件、`sdk_env_v1.11.0`
 *    有 **43719** —— 老上限 20000 一进去就被截断（只给一句 ⚠），选"最外层那块"反而可能
 *    索引不到你要的那个 .c。现在放到 60000：`sdk_env_v1.11.0` 整棵也装得下（含工具链头文件）。
 *    条目本身只存路径字符串（句柄模式不读文件内容），几万条对桌面浏览器不是负担；
 *    真正的代价是"选目录那一下"要遍历几万个目录项，几秒钟，慢但一次性。
 */
const MAX_FILES = 60000;
const MAX_DEPTH = 14;
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;         // 单个源文件读取上限（防手滑选到整个磁盘）
const MAX_CACHE = 120;

export const normSlashes = p => String(p ?? '').replace(/\\/g, '/');
export const baseNameOf = p => normSlashes(p).split('/').pop() || '';
const isAbs = p => /^([A-Za-z]:\/|\/)/.test(p);
const styleOf = p => (/^[A-Za-z]:\//.test(p) ? 'win' : 'posix');

/**
 * 从 ELF 的 DWARF 路径里推荐「该选哪个源码目录」。
 *
 * 为什么能做：`.debug_line` 里存的就是**编译时的路径**，这份 HPM6800EVK 的 ELF 实测 188 条
 * **全是绝对路径**，而且分三簇：
 *   · `E:/sdk_env_v1.11.0/hpm_sdk` 146 条（例程 / SoC / 驱动 / lwIP 内核）
 *   · `E:/sdk_env_v1.11.0/toolchains` 18 条（工具链头文件）
 *   · `/home/builder/...` 24 条（**编译机上的路径**，本机不存在，谁也覆盖不到）
 * 用户要手选一个目录，选小了 `main` 以外的看不到，选大了几万个文件还得遍历。
 *
 * 算法（好解释、也稳）：先按"前两段"分簇（`E:/sdk_env_v1.11.0`、`/home/builder`…），取文件最多的
 * 那一簇；然后在簇内**沿最大分支往下钻**：只要最大的孩子几乎装下这一层（≥ 85%，默认）就继续往
 * 具体里走，一旦再往下会丢掉超过 15% 的文件就停 —— 得到"覆盖够多、又尽量具体"的那个目录。
 * （阈值是这么定的：实测 `E:/sdk_env_v1.11.0` 164 → `…/hpm_sdk` 146 是 89%，往下钻几乎不亏，
 *   于是推荐 `hpm_sdk`；再往下最大分支只占两成多，钻进去就要丢一半文件，所以停住。）
 * 另外把别的簇也钻一遍列出来（跨机器/跨盘的标 foreign —— 那份 HPM 的 ELF 里就有 24 条
 * `/home/builder/...`，本机永远覆盖不到，先说清楚省得用户白挑）。
 */
export function sourceRootSuggestions(rawPaths, { maxOthers = 2, drill = 0.85, minShare = 0.02 } = {}){
  const seen = new Map();                       // 小写 → 原样（Windows 路径不区分大小写）
  for (const raw of (rawPaths || [])){
    const p = normSlashes(raw);
    if (!p || !isAbs(p)) continue;
    const k = p.toLowerCase();
    if (!seen.has(k)) seen.set(k, p);
  }
  const paths = [...seen.values()];
  const total = paths.length;
  if (!total) return { total: 0, best: null, root: null, others: [], covered: 0 };

  /**
   * 分簇用的"机器根"：取前两个**非空**路径段。
   *   `E:/sdk_env_v1.11.0/hpm_sdk/…` → `E:/sdk_env_v1.11.0`
   *   `/home/builder/work/…`         → `/home/builder`（posix 前面那个空段要跳过，否则会缩成 /home）
   */
  const clusterKey = p => {
    const seg = p.split('/').filter(Boolean).slice(0, 2);
    return seg[0]?.endsWith(':') ? seg.join('/') : '/' + seg.join('/');
  };
  const clusters = new Map();
  for (const p of paths){
    const k = clusterKey(p).toLowerCase();
    if (!clusters.has(k)) clusters.set(k, { dir: clusterKey(p), files: [] });
    clusters.get(k).files.push(p);
  }
  const ranked = [...clusters.values()].sort((a, b) => b.files.length - a.files.length);
  const main = ranked[0];

  /** 在一个簇内"沿最大分支往下钻"，直到没有哪个孩子占该目录的绝对多数 */
  const drillDown = (cluster) => {
    let cur = cluster.dir, curCount = cluster.files.length;
    for (;;){
      const prefix = cur + '/';
      const kids = new Map();
      for (const p of cluster.files){
        if (!p.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        const rest = p.slice(prefix.length);
        if (!rest.includes('/')) continue;                   // 直接躺在这一层的文件，不是"孩子"
        const seg = rest.split('/')[0];
        const k = (prefix + seg).toLowerCase();
        kids.set(k, { dir: prefix + seg, n: (kids.get(k)?.n || 0) + 1 });
      }
      const top = [...kids.values()].sort((a, b) => b.n - a.n)[0];
      if (!top || top.n < curCount * drill) break;
      cur = top.dir; curCount = top.n;
    }
    return { dir: cur, files: curCount, share: curCount / total };
  };

  const best = drillDown(main);
  const others = ranked.slice(1)
    .filter(c => c.files.length / total >= minShare)
    .slice(0, maxOthers)
    .map(c => ({ ...drillDown(c), foreign: styleOf(c.dir) !== styleOf(main.dir) }));

  return {
    total,
    best,
    root: { dir: main.dir, files: main.files.length, share: main.files.length / total },
    others,
    covered: best.files,
  };
}

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
