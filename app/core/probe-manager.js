/** Control-plane arbitration only. Bulk readers and sample processing never enter this queue. */
export class ProbeCancelled extends Error {
  constructor(){ super('探针操作已取消'); this.name = 'ProbeCancelled'; }
}

export class ProbeManager {
  constructor({ beforeAcquire = null, locks = globalThis.navigator?.locks } = {}){
    this.clients = new Map();
    this.leases = new Map();
    this.pending = new Set();
    this.current = null;
    this._chain = Promise.resolve();
    this.beforeAcquire = beforeAcquire;
    this.locks = locks;
  }

  register(owner, { resources, release, active = () => false, protected: guarded = () => false }){
    if (this.clients.has(owner)) throw new Error(`重复的探针使用者：${owner}`);
    this.clients.set(owner, { resources: new Set(resources), release, active, guarded });
  }

  _enqueue(fn){
    const p = this._chain.then(fn);
    this._chain = p.catch(() => {});
    return p;
  }

  _conflicts(a, b){ return [...a].some(r => b.has(r)); }

  _checkProtected(owner, resources){
    for (const [id, c] of this.clients){
      if (id !== owner && this._conflicts(resources, c.resources) && c.guarded())
        throw new Error(`${id === 'flash' ? '烧录器' : id}正在使用探针，请等待完成`);
    }
  }

  /** Serialize acquisition AND setup: a later feature cannot close a half-open session. */
  async run(owner, fn, { reason = '另一个功能要使用探针', policy = 'handoff' } = {}){
    const client = this.clients.get(owner);
    if (!client) throw new Error(`未登记的探针使用者：${owner}`);
    this._checkProtected(owner, client.resources);
    const ticket = { owner, controller: new AbortController(), phase: 'queued' };
    this.pending.add(ticket);
    const alive = () => { if (ticket.controller.signal.aborted) throw new ProbeCancelled(); };
    try {
      return await this._enqueue(async () => {
        alive();
        ticket.phase = 'lock';
        const execute = async () => {
          alive(); ticket.phase = 'setup'; this.current = ticket;
          try {
            this._checkProtected(owner, client.resources);
            const conflicts = [...this.clients].filter(([id, c]) => id !== owner &&
              (this.leases.has(id) || c.active()) && this._conflicts(client.resources, c.resources));
            if (policy === 'reject' && conflicts.length) throw new Error('共享资源正在使用中，请先停止对应功能');
            for (const [id, c] of conflicts){
              await c.release(reason);
              this.leases.delete(id);
              alive();
            }
            // One page owns the physical device. Compatible local clients share that ownership.
            if (!this.leases.size && this.beforeAcquire) await this.beforeAcquire(reason);
            alive();
            const lease = Object.freeze({ owner, signal: ticket.controller.signal, assert: alive });
            this.leases.set(owner, lease);
            return await fn(lease);
          } finally {
            if (!client.active()) this.leases.delete(owner);
            this.current = null;
          }
        };
        // Same-origin tabs cannot start simultaneous handshakes. This lock is released after setup.
        if (this.locks?.request)
          return await this.locks.request('web-serial-rtt-tools/probe-control', { signal: ticket.controller.signal }, execute);
        return await execute();
      });
    } catch (e){
      if (ticket.controller.signal.aborted && e.name === 'AbortError') throw new ProbeCancelled();
      throw e;
    } finally { this.pending.delete(ticket); }
  }

  /** Cancel queued starts immediately; existing feature state machines drain starts already executing. */
  cancel(owner){
    for (const t of this.pending) if (t.owner === owner) t.controller.abort();
  }

  forget(owner){ this.leases.delete(owner); }

  async releaseOthers(keep, reason = '另一个功能要使用探针'){
    // Compatibility calls made inside setup have already been arbitrated by run().
    if (keep && this.current?.owner === keep) return;
    const all = new Set([...this.clients.values()].flatMap(c => [...c.resources]));
    this._checkProtected(keep, all);
    for (const t of this.pending) if (t.owner !== keep) t.controller.abort();
    return await this._enqueue(async () => {
      this._checkProtected(keep, all);
      for (const [id, c] of this.clients){
        if (id === keep || (!this.leases.has(id) && !c.active())) continue;
        await c.release(reason); // Failure preserves ownership and aborts the handoff.
        this.leases.delete(id);
      }
    });
  }

  summary(){
    return { owners: [...this.leases.keys()], pending: [...this.pending].map(t => ({ owner: t.owner, phase: t.phase })) };
  }
}

/** View adapters can run without a manager in standalone demos/tests. */
export async function runProbeOperation(view, owner, fn, { mock = false, ...opts } = {}){
  if (mock || !view.probeManager) return await fn();
  try { return await view.probeManager.run(owner, fn, opts); }
  catch (e){ if (e instanceof ProbeCancelled) return false; throw e; }
}
