// An in-memory `Store` (docs/local-first.md §6.4), installed through `setStore` so a test asserts
// on **board behaviour** instead of on the in-memory GitHub's REST log.
//
//   const store = new FakeStore({ board: 'default' });
//   store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
//   const restore = store.install(ctx);
//   ...
//   assert.equal(store.statusOf(7), 'running');
//   assert.deepEqual(await store.locks(), ['7/1']);
//   assert.deepEqual(store.writes(), []);            // "and nothing was written"
//
// Why it exists: 121 assertion sites read the fake GitHub's request log and its lock refs — the shape
// of GitHub's REST API — to find out things the protocol states in its own words ("the lock was
// released", "the run record was not rewritten", "a check with nothing to check costs nothing").
// Every one of those sites pinned `src/store/github.js` in place (docs/local-first.md §10-§11).
// Through the interface the same assertions are portable, which is why `locksOf`/`writesOf` below
// are free functions: `test/*.test.js` runs several of these scenarios against the **real** local
// driver too, and the assertion reads the same either way.
//
// What is NOT here: pull requests. They are `src/forge.js`, they still go through `src/gh.js`
// whatever the board is kept in, and a test that asserts on one keeps using `test/fake-gh.js`
// (`gh.requestsMatching`). The two doubles compose — install both.
import { setStore } from '../src/store/index.js';
import {
  DEFAULT_KB, L, RESULT_MARKER, STATUSES,
  emptyRun, isResultComment, parseBodyBlock, parseResultComment,
  serializeBodyBlock,
  statusOf, agentOf, boardOf, tagBlockers,
} from '../src/model.js';
import { normalizeCardGrants, loadBoard, saveBoard } from '../src/board.js';
import { FakeGh, issueRecord, commentRecord } from './fake-gh.js';

/** Every method of the interface that changes the board — what `writes()` counts. */
export const WRITE_METHODS = Object.freeze([
  'setBoard', 'createTask', 'updateBody', 'setKb', 'setStatus', 'setAgent',
  'addLabels', 'removeLabel', 'ensureLabels', 'closeTask', 'reopenTask',
  'addBlockedBy', 'removeBlockedBy', 'saveRun', 'addNote',
  'claim', 'release', 'heartbeat', 'resyncBeat', 'dropBeat',
]);

/**
 * Both doubles, installed together, with one restore that undoes them in the order they went on.
 *
 * Eleven harnesses used to copy the same four lines and re-derive the LIFO teardown by hand; the
 * ordering hazard is worth removing once rather than being correct eleven times. `makeCtx` is a
 * function because most harnesses build their context out of the fake GitHub's `nameWithOwner`,
 * and the store's `install(ctx)` needs the context that comes out of it.
 *
 * @param {((gh: FakeGh) => any)|any} [makeCtx]  the context, or a function from the fake GitHub to it
 * @param {{caps?: any, board?: string, host?: string|null, events?: boolean}} [opts]
 */
export function installDoubles(makeCtx = null, { caps = {}, board = 'default', host = null, events = false } = {}) {
  const gh = new FakeGh({ caps });
  const store = new FakeStore({ board, host, events });
  const ctx = typeof makeCtx === 'function' ? makeCtx(gh) : makeCtx;
  const restoreGh = gh.install();
  const restoreStore = store.install(ctx);
  return { gh, store, ctx, restore: () => { restoreStore(); restoreGh(); } };
}

/**
 * The live claims, as `"<n>/<k>"` strings, sorted — the portable form of what
 * the fake GitHub used to answer with (`refs/kb/locks/7/1` names a GitHub ref; a store that keeps
 * its claims in a table has no such name, and `listLocks()` is what both have).
 * @param {any} store
 */
export async function locksOf(store) {
  const rows = await store.listLocks();
  return rows.map((r) => `${r.n}/${r.k}`).sort();
}

/**
 * What a claim is *about* is the claim, not the card: a tick that tried to claim #7 and was told
 * somebody else holds it has written nothing on #7, and `writesTo` has to agree.
 */
export const CARD_WRITE_METHODS = Object.freeze(WRITE_METHODS.filter((m) => !['setBoard', 'claim', 'release', 'heartbeat', 'resyncBeat', 'dropBeat'].includes(m)));

export class FakeStore {
  /**
   * @param {{board?: string, host?: string|null, events?: boolean, url?: (n: number) => string}} [opts]
   */
  constructor({ board = 'default', host = null, events = false, url = null } = {}) {
    this.kind = 'fake';
    this.boardSlug = board;
    this.host = host;
    this.caps = { events };
    this.urlOf = url || ((n) => `https://example.invalid/issues/${n}`);
    /** number -> card record */
    this.issues = new Map();
    /** `"<n>/<k>"` -> {token, beat_at} — the claims, whatever a driver keeps them in */
    this.lockRows = new Map();
    /** `"<n>/<k>"` -> token — this host's own beat chain, the counterpart of the local ref mirror */
    this.beats = new Map();
    /** every interface call, in order: `{name, args}` */
    this.calls = [];
    this.nextCommentId = 1000;
    this.nextToken = 1;
    this.repoLabels = new Set();
    this.eventLog = [];
    /** number -> how many times the card actually changed — see `#touch` */
    this.revisions = new Map();
    this.ctx = null;
    this.closed = 0;
  }

  // ---------- installation ----------

  /**
   * Install as the store `openStore` returns, for every context. Returns the restore function.
   * `ctx` is remembered so `board()`/`setBoard()` read and write the same `.kanban/board.json` the
   * real drivers do — a test that pauses a board through the interface still sees the file change.
   * @param {any} [ctx]
   */
  install(ctx = null) {
    if (ctx) this.ctx = ctx;
    const store = this.asStore();
    return setStore((c) => { if (c && !this.ctx) this.ctx = c; return store; });
  }

  /**
   * The recording `Store`: every §6.4 method, wrapped so the call lands in `calls` first.
   * Built once and memoized — `openStore` may be called forty times in one verb and every one of
   * them has to hand back the same handle.
   */
  asStore() {
    if (this._store) return this._store;
    const raw = this.raw();
    const store = /** @type {any} */ ({ kind: 'fake', get ctx() { return this.ctxOf; }, ctxOf: null, index: null });
    for (const [name, fn] of Object.entries(raw)) {
      store[name] = (...args) => {
        const entry = { name, args, changed: false };
        this.calls.push(entry);
        // `claim` is the one method that reports a failure rather than throwing it (a claim whose
        // outcome cannot be classified is `unknown`, which is what the dispatcher backs off on), so
        // it takes its own from the queue.
        if (name !== 'claim') {
          const injected = this.#takeFailure(name, args);
          if (injected) throw injected;
        }
        // The frame is what `#wrote()` marks. Every method here mutates in its synchronous
        // segment — `async` or not, none of them awaits before writing — so the frame covers
        // exactly the call that did it, and `writes()` can count effects rather than calls.
        const outer = this._frame;
        this._frame = entry;
        try { return fn(...args); } finally { this._frame = outer; }
      };
    }
    // Not part of the interface, but `closeStore` calls it and the seam's own tests count it.
    store.close = () => { this.closed++; };
    this._store = store;
    return store;
  }

  // ---------- seeding ----------

  /**
   * A card, from the same `kbIssue({...})` spec `test/fake-gh.js` takes — so a file migrating onto
   * the store double changes `h.gh.addIssue` to `h.store.addIssue` and nothing else.
   */
  addIssue(spec = {}) {
    const number = spec.number ?? (Math.max(0, ...this.issues.keys()) + 1);
    const rec = issueRecord(spec, { number, url: spec.url || this.urlOf(number) });
    for (const l of rec.labels) this.repoLabels.add(l);
    this.issues.set(number, rec);
    // The run record is a *record*, not a comment: this store keeps it the way every store hkb
    // ships does (one document per card), so a fixture seeded through `kbIssue({run})` lands as one.
    rec.run = rec.run ? clone(rec.run) : null;
    for (const body of spec.comments || []) this.addComment(number, body);
    return rec;
  }

  addComment(number, body) {
    const rec = this.#rec(number);
    const c = commentRecord({ id: this.nextCommentId++, body, url: rec.url });
    rec.comments.push(c);
    return c;
  }

  /**
   * A beat landed at `at`, as `lockBeatAt` reads it back — the fixture `gh.beat()` was.
   * Creates the claim if there is none, the way `gh.beat` created the ref: a test that seeds "an
   * attempt that last beat an hour ago" is describing a claim, not making one through the verb.
   */
  beat(n, k, at) {
    const row = this.lockRows.get(key(n, k)) || { token: `tok${this.nextToken++}`, beat_at: null };
    row.beat_at = new Date(at).toISOString();
    this.lockRows.set(key(n, k), row);
    return row.token;
  }

  /** A claim made out of band — what the dispatcher's `POST git/refs` leaves behind. */
  hold(n, k, { at = null } = {}) {
    const token = `tok${this.nextToken++}`;
    this.lockRows.set(key(n, k), { token, beat_at: at ? new Date(at).toISOString() : null });
    return token;
  }

  // ---------- assertions ----------

  labelsOf(number) { return [...this.#rec(number).labels]; }
  statusOf(number) { return statusOf(this.#rec(number).labels); }
  bodyOf(number) { return this.#rec(number).body; }
  /** How many times this card has actually changed. Equal before and after = nothing was written. */
  revisionOf(number) { return this.revisions.get(Number(number)) || 0; }
  stateOf(number) { const r = this.#rec(number); return { state: r.state, stateReason: r.stateReason }; }
  /** The run record as hkb would read it back, or null. */
  runOf(number) { return this.#rec(number).run; }
  /**
   * The live claims as `"<n>/<k>"`, sorted. Async on purpose: `locksOf` reads any driver.
   *
   * Through `raw()`, never through the recording store: reading an assertion must not append to
   * the log another assertion reads, and with `fail('listLocks')` armed the *assertion* would
   * otherwise be the caller that consumes the injected error.
   */
  locks() { return locksOf(this.raw()); }
  /** One claim as the store keeps it — `{token, beat_at}` — or null. */
  lockOf(n, k) { return this.lockRows.get(key(n, k)) || null; }
  /**
   * Every mutating call that actually changed something, as method names — `[]` is "and nothing
   * was written". Effects, not calls: `ensureLabels` with nothing to create and `setStatus` to the
   * status the card already has both reach the interface and make no request on a real driver, so
   * counting them here would make `[]` mean less than it says.
   */
  writes(name = null) {
    return this.calls
      .filter((c) => c.changed && (name ? c.name === name : WRITE_METHODS.includes(c.name)))
      .map((c) => c.name);
  }
  /** The same, narrowed to one card: "#7 was not touched" without naming a REST path. */
  writesTo(number) {
    return this.calls
      .filter((c) => c.changed && CARD_WRITE_METHODS.includes(c.name) && numberOf(c.args) === Number(number))
      .map((c) => c.name);
  }
  /** Every call to `name`, with its arguments. */
  callsOf(name) { return this.calls.filter((c) => c.name === name); }
  /** Forget the call log — a harness that reuses one store across `run()`s starts each one clean. */
  clearCalls() { this.calls.length = 0; return this; }

  // ---------- the interface ----------

  #rec(number) {
    const rec = this.issues.get(Number(number));
    if (!rec) { const e = /** @type {any} */ (new Error(`issue #${number} not found`)); e.exitCode = 2; throw e; }
    return rec;
  }

  /**
   * The card changed. `revisionOf` counts these, which is how a test says "nothing to change is
   * nothing to write" without naming a REST call: a verb may reach the interface and still leave
   * the card exactly as it found it, and that is the thing worth asserting.
   */
  #touch(rec) {
    rec.updatedAt = new Date().toISOString();
    this.revisions.set(rec.number, (this.revisions.get(rec.number) || 0) + 1);
    this.#wrote();
  }

  /** Something changed. The call in flight is what `writes()` counts. */
  #wrote() { if (this._frame) this._frame.changed = true; }

  #blockers(rec) {
    return rec.blockedBy.map((b) => {
      if (b && typeof b === 'object') return { number: b.number, state: String(b.state || 'OPEN').toUpperCase(), stateReason: b.stateReason ? String(b.stateReason).toUpperCase() : null, title: b.title || `issue ${b.number}` };
      const parent = this.issues.get(Number(b));
      if (!parent) throw new Error(`fake-store: #${b} blocks #${rec.number} but was never added`);
      return { number: parent.number, state: parent.state, stateReason: parent.stateReason, title: parent.title };
    });
  }

  /** The task shape every driver answers with (`src/store/index.js`'s `listTasks` typedef). */
  #task(rec) {
    const { kb, rest: bodyText } = parseBodyBlock(rec.body);
    normalizeCardGrants(kb);
    return {
      number: rec.number,
      nodeId: rec.id,
      databaseId: rec.databaseId,
      title: rec.title,
      body: rec.body || '',
      bodyText,
      kb,
      labels: [...rec.labels],
      status: statusOf(rec.labels),
      agent: agentOf(rec.labels),
      board: boardOf(rec.labels),
      needsHuman: rec.labels.includes(L.needsHuman),
      state: rec.state,
      stateReason: rec.stateReason,
      updatedAt: rec.updatedAt,
      createdAt: rec.createdAt,
      url: rec.url,
      blockedBy: this.#blockers(rec),
      prs: rec.prs.map((p) => ({
        number: p.number,
        nodeId: p.nodeId || `PR_kwFake${p.number}`,
        state: p.state,
        isDraft: !!p.isDraft,
        url: p.url || `https://example.invalid/pull/${p.number}`,
        headRefName: p.headRefName || `kb/${rec.number}`,
        baseRefName: p.baseRefName || 'main',
        merged: !!p.merged,
        autoMergeEnabled: !!(p.autoMergeEnabled || p.autoMerge),
      })),
    };
  }

  /** The record behind a task object a caller is holding — the writers mutate both. */
  #of(task) { return this.#rec(typeof task === 'object' && task ? task.number : task); }

  #event(kind, number, payload = {}) {
    this.eventLog.push({ id: this.eventLog.length + 1, at: new Date().toISOString(), kind, number: number ?? null, payload });
  }

  #comments(n) { return this.#rec(n).comments.map((c) => ({ ...c })); }

  /**
   * The interface, unrecorded. `asStore()` wraps these; the double's own internals and its
   * assertion helpers call them directly, so an assertion never lands in the call log and a
   * method that leans on another (`setBoard` → `board`, `listTasks` → `listClosedRecent`) does not
   * record two calls where a driver makes one.
   */
  raw() {
    if (this._raw) return this._raw;
    const self = this;
    this._raw = {
      root: () => (self.ctx?.root ?? '/fake'),
      capabilities: () => ({ ...self.caps }),

      // ---- board ----
      board() {
        const cfg = (self.ctx && loadBoard(self.ctx.root)) || self.ctx?.cfg || {};
        return {
          slug: self.boardSlug,
          host: cfg.host ?? self.host ?? null,
          paused_at: cfg.paused_at ?? null,
          paused_by: cfg.paused_by ?? null,
          settings: cfg,
        };
      },
      setBoard(patch = {}) {
        if (!self.ctx) throw new Error('fake-store: setBoard needs a ctx — pass one to install()');
        const cfg = { ...(loadBoard(self.ctx.root) || {}), ...patch };
        saveBoard(self.ctx.root, cfg);
        self.ctx.cfg = cfg;
        self.#wrote();
        return self.raw().board();
      },

      // ---- tasks ----
      async listTasks({ states = ['OPEN'], blockers = true } = {}) {
        const want = states.map((x) => String(x).toUpperCase());
        for (const x of want) {
          if (x === 'OPEN' || x === 'CLOSED') continue;
          const e = /** @type {any} */ (new Error(`listTasks: unknown state "${x}" — a store knows OPEN and CLOSED`));
          e.exitCode = 2;
          throw e;
        }
        // Closed-only is the reconcile question, and every driver answers it with a recent page.
        if (!want.includes('OPEN')) return self.raw().listClosedRecent();
        const tasks = [...self.issues.values()]
          .filter((r) => want.includes(r.state) && r.labels.includes(L.board(self.boardSlug)))
          .sort((a, b) => a.number - b.number)
          .map((r) => self.#task(r));
        // `blockers: false` is a caller saying "do not spend anything on dependencies", and the
        // double answers it the way the driver that *can* refuse does (src/store/github.js:148):
        // no edges, and a note saying they were never read. Filling them anyway — as a store with
        // the edges in hand could — would make `blockersKnown` true here and false on GitHub, and
        // every migrated assertion about "an empty blockedBy nobody read is not 'no blockers'"
        // would be true only of the double.
        if (blockers === false) {
          for (const t of tasks) t.blockedBy = [];
          return tagBlockers(tasks, { source: null, filled: false, scope: 'none' });
        }
        return tagBlockers(tasks, { source: 'fake', filled: true, scope: 'all' });
      },
      async listClosedRecent({ first = 50, since = null } = {}) {
        const cut = since ? Date.parse(since) : NaN;
        const inWindow = (r) => {
          if (!Number.isFinite(cut)) return true;
          const d = Date.parse(r.updatedAt || '');
          return !Number.isFinite(d) || d >= cut;
        };
        return [...self.issues.values()]
          .filter((r) => r.state === 'CLOSED' && r.labels.includes(L.board(self.boardSlug)) && inWindow(r))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.number - a.number))
          .slice(0, first)
          .map((r) => self.#task(r));
      },
      async getTask(n) { return self.#task(self.#rec(n)); },
      async createTask({ title, body = '', kb = {}, status = 'triage', agent = null }) {
        const labels = [L.board(self.boardSlug), L.status(status)];
        if (agent) labels.push(L.agent(agent));
        const rec = self.addIssue({ title, body: serializeBodyBlock({ ...DEFAULT_KB, ...kb }, body), labels });
        self.#wrote();
        self.#event('created', rec.number, { title });
        return self.#task(rec);
      },
      async updateBody(n, body) {
        const rec = self.#rec(n);
        const { kb } = parseBodyBlock(rec.body);
        rec.body = serializeBodyBlock(kb, body);
        self.#touch(rec);
        return self.#task(rec);
      },
      // `bodyText` defaults to *the record's* prose, not the passed task's. Defaulting to
      // `task.bodyText` modelled the GitHub driver, where kb and prose shared one body field and a
      // caller could only write both; the one driver left reads the card it is about to patch, so a
      // `setKb` on a task read before someone else rewrote the prose does not put the old prose
      // back. The conformance scenario pins the pairing.
      async setKb(task, kb, bodyText = undefined) {
        const rec = self.#of(task);
        const prose = bodyText === undefined ? parseBodyBlock(rec.body).rest : bodyText;
        rec.body = serializeBodyBlock(kb, prose);
        self.#touch(rec);
        task.kb = kb; task.body = rec.body; task.bodyText = prose;
        return task;
      },
      async setStatus(task, status, { add = [], remove = [] } = {}) {
        if (!STATUSES.includes(status)) throw new Error(`invalid status ${status}`);
        const rec = self.#of(task);
        const toRemove = new Set([...task.labels.filter((l) => l.startsWith('kb:status:') && l !== L.status(status)), ...remove]);
        const missing = [L.status(status), ...add].filter((l) => !task.labels.includes(l));
        const before = rec.labels;
        const kept = before.filter((l) => !toRemove.has(l));
        const added = missing.filter((l) => !before.includes(l));
        rec.labels = [...kept, ...added];
        for (const l of missing) self.repoLabels.add(l);
        // A status that is already the card's status writes nothing — the drivers elide the call,
        // and a double that recorded one anyway would make "nothing to change is nothing to write"
        // unassertable through the interface. Both halves count: a label *taken off* is a
        // `DELETE /issues/<n>/labels/<name>` on the real driver, and comparing against `rec.labels`
        // after it was reassigned could only ever see the additions.
        if (kept.length !== before.length || added.length) self.#touch(rec);
        // The task the caller holds is updated in place, the way every driver's `setStatus` does.
        task.labels = [...task.labels.filter((l) => !toRemove.has(l)), ...missing];
        task.status = status;
        self.#event('status', rec.number, { status });
        return task;
      },
      async setAgent(task, agent) {
        const rec = self.#of(task);
        const want = L.agent(agent);
        const kept = rec.labels.filter((l) => !l.startsWith('kb:agent:'));
        const changed = !rec.labels.includes(want) || rec.labels.some((l) => l.startsWith('kb:agent:') && l !== want);
        rec.labels = [...kept, want];
        self.repoLabels.add(want);
        if (changed) self.#touch(rec);
        task.labels = [...task.labels.filter((l) => !l.startsWith('kb:agent:')), want];
        task.agent = agent;
        return task;
      },
      async addLabels(task, names) {
        const rec = self.#of(task);
        const missing = names.filter((l) => !task.labels.includes(l));
        if (!missing.length) return task;
        for (const l of missing) { if (!rec.labels.includes(l)) rec.labels.push(l); self.repoLabels.add(l); }
        self.#touch(rec);
        task.labels.push(...missing);
        return task;
      },
      async removeLabel(task, name) {
        const rec = self.#of(task);
        if (!task.labels.includes(name)) return task;
        rec.labels = rec.labels.filter((l) => l !== name);
        self.#touch(rec);
        task.labels = task.labels.filter((l) => l !== name);
        return task;
      },
      async ensureLabels(names) {
        const created = [];
        for (const name of names) {
          if (self.repoLabels.has(name)) continue;
          self.repoLabels.add(name);
          created.push(name);
        }
        if (created.length) self.#wrote(); // a label that already exists costs a real driver no request
        return created;
      },
      async closeTask(n, reason = 'completed') {
        const rec = self.#rec(n);
        rec.state = 'CLOSED';
        rec.stateReason = String(reason).toUpperCase();
        self.#touch(rec);
        self.#event('closed', rec.number, { reason });
        return self.#task(rec);
      },
      async reopenTask(n) {
        const rec = self.#rec(n);
        rec.state = 'OPEN';
        rec.stateReason = null;
        self.#touch(rec);
        return self.#task(rec);
      },
      async addBlockedBy(child, parent) {
        const c = self.#rec(child);
        self.#rec(parent); // a link to a card that does not exist is a 404 on every driver
        if (!c.blockedBy.some((b) => Number(b?.number ?? b) === Number(parent))) c.blockedBy.push(Number(parent));
        self.#touch(c);
        return { number: Number(parent) };
      },
      async removeBlockedBy(child, parent) {
        const c = self.#rec(child);
        c.blockedBy = c.blockedBy.filter((b) => Number(b?.number ?? b) !== Number(parent));
        self.#touch(c);
        return null;
      },

      // ---- runs, results, notes ----
      // A copy out and a copy in, like every real driver: the caller mutates what it was handed
      // and hands it back to `saveRun`, and a double that returned its own object would make that
      // round trip invisible — every `saveRun` would already have "happened".
      async loadRun(n) {
        const card = self.#rec(n);
        return { id: card.run ? n : null, run: card.run ? clone(card.run) : emptyRun(), duplicates: [] };
      },
      async saveRun(n, rec) {
        const card = self.#rec(n);
        card.run = clone(rec.run);
        rec.id = n;
        self.#touch(card);
        return card.run;
      },
      async latestResult(n) {
        const results = self.#comments(n)
          .map((c) => ({ comment: c, parsed: String(c.body || '').startsWith(RESULT_MARKER) ? parseResultComment(c.body) : null }))
          .filter((x) => x.parsed);
        if (!results.length) return null;
        const last = results[results.length - 1];
        return { ...last.parsed, at: last.comment.created_at, url: last.comment.html_url };
      },
      async parentResults(task) {
        const out = [];
        for (const b of task.blockedBy || []) {
          out.push({ number: b.number, title: b.title, state: b.state, result: await self.raw().latestResult(b.number) });
        }
        return out;
      },
      async addNote(n, text) {
        const c = self.addComment(n, String(text ?? ''));
        self.#touch(self.#rec(n));
        self.#event('note', Number(n), { text: String(text ?? '') });
        return { id: c.id, at: c.created_at, actor: c.user.login, text: c.body, url: c.html_url };
      },
      async listNotes(n) {
        return self.#comments(n)
          .filter((c) => !isResultComment(c.body))
          .map((c) => ({ id: c.id, at: c.created_at, actor: c.user?.login || null, text: c.body || '' }));
      },

      // ---- claims ----
      // Create-if-absent on one row, which is all the protocol asks of a store: `claimed` when this
      // caller made it, `held` when somebody already had it. `unknown` is a driver that could not
      // find out, and `fail('claim')` is how a test asks for one.
      async claim(n, k) {
        // `fail('claim')` is the store-level form of the two things that can go wrong at a claim:
        // somebody won the race (`result: 'held'`, and no row of ours to list), or the driver could
        // not find out (`unknown`, which is what the dispatcher backs off on).
        const failure = self.#takeFailure('claim');
        if (failure) return { result: failure.result || 'unknown', token: null, ref: null, error: failure.result ? null : failure };
        const at = key(n, k);
        if (self.lockRows.has(at)) return { result: 'held', token: null, ref: null, error: null };
        const token = `tok${self.nextToken++}`;
        self.lockRows.set(at, { token, beat_at: null });
        self.beats.set(at, token);
        self.#wrote();
        self.#event('claimed', Number(n), { attempt: Number(k) });
        return { result: 'claimed', token, ref: null, error: null };
      },
      async release(n, k) {
        const at = key(n, k);
        const had = self.lockRows.delete(at);
        if (had) { self.#wrote(); self.#event('released', Number(n), { attempt: Number(k) }); }
        return had;
      },
      async listLocks() {
        return [...self.lockRows.entries()].map(([at, row]) => {
          const [n, k] = at.split('/').map(Number);
          return { n, k, token: row.token, beat_at: row.beat_at, ref: null };
        });
      },
      async lockBeatAt(n, k) { return self.lockRows.get(key(n, k))?.beat_at ?? null; },
      /** A table, not a ref: this store has no name for a claim, and callers fall back to `k`. */
      lockRef: () => null,
      heartbeat(n, k, expected) {
        const at = key(n, k);
        const row = self.lockRows.get(at);
        if (!row) return { result: 'lost', token: null, expected, detail: 'the claim is gone' };
        if (row.token !== expected) return { result: 'lost', token: null, expected, detail: `the claim is at ${row.token}` };
        row.token = `tok${self.nextToken++}`;
        row.beat_at = new Date().toISOString();
        self.beats.set(at, row.token);
        self.#wrote();
        return { result: 'ok', token: row.token, expected, detail: '' };
      },
      async lockToken(n, k) { return self.lockRows.get(key(n, k))?.token ?? null; },
      beatToken: (n, k) => self.beats.get(key(n, k)) ?? null,
      resyncBeat: (n, k, token) => { self.beats.set(key(n, k), token); self.#wrote(); return true; },
      dropBeat: (n, k) => { const had = self.beats.delete(key(n, k)); if (had) self.#wrote(); return had; },

      // ---- events ----
      async events({ after = 0, limit = 100 } = {}) {
        if (!self.caps.events) {
          const e = /** @type {any} */ (new Error('this store has no event log (capabilities().events is false).'));
          e.exitCode = 2;
          throw e;
        }
        return self.eventLog.filter((e) => e.id > after).slice(0, limit);
      },
      /**
       * One card's history: whatever this store has for it. Seeded timeline rows (the shape the
       * GitHub driver maps an issue event into) plus, on a store with a log, that card's own rows —
       * narrowed to the card and to the *newest* `limit`, never a forward page from id 0.
       */
      async taskEvents(n, { limit = 100 } = {}) {
        const rec = self.#rec(n);
        const seeded = rec.events.map((e) => ({ at: e.created_at || e.at, kind: e.event || e.kind, detail: e.label?.name || e.detail || '', actor: e.actor?.login || e.actor || null }));
        const logged = self.caps.events
          ? self.eventLog.filter((e) => e.number === Number(n)).map((e) => ({ at: e.at, kind: e.kind, detail: detailOf(e.payload), actor: null }))
          : [];
        return [...seeded, ...logged].slice(-limit);
      },
    };
    return this._raw;
  }

  // ---------- injected failures ----------

  /**
   * Make the next `times` calls to `name` fail. The store double's counterpart of
   * `FakeGh.fail({path})` — a test that wanted "the claim could not be classified" used to inject a
   * 500 on `POST git/refs`, which is a sentence about GitHub, not about the board.
   */
  fail(name, { message = 'injected failure', times = 1, result = null, kind = null, when = null } = {}) {
    this.failures = this.failures || [];
    // `when(args)` narrows an injected failure to one *call* rather than one method: `sweep()` and
    // the tick both call `listTasks`, and a test about the sweep's read failing must not take the
    // tick's down with it.
    this.failures.push({ name, message, times, result, kind, when });
    return this;
  }

  #takeFailure(name, args = []) {
    for (const f of this.failures || []) {
      if (f.name !== name || f.times <= 0) continue;
      if (f.when && !f.when(...args)) continue;
      f.times--;
      const e = /** @type {any} */ (new Error(f.message));
      // `kind` is `src/gh.js`'s classification (`auth`, `server`, `notfound`, …) and the callers
      // branch on it — the dispatcher stops a tick on `auth` and backs off on everything else.
      if (f.kind) e.kind = f.kind;
      if (f.result) e.result = f.result;
      return e;
    }
    return null;
  }
}

const key = (n, k) => `${Number(n)}/${Number(k)}`;

/** A structural copy, so a record handed out and a record kept are never the same object. */
const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * Which card a call was about. The interface addresses a card two ways — by number (`saveRun`,
 * `closeTask`, `addNote`) and by the task object a caller is holding (`setStatus`, `addLabels`) —
 * and `writesTo` has to see through both.
 */
function numberOf(args = []) {
  const first = args[0];
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) return Number(first);
  if (first && typeof first === 'object' && typeof first.number === 'number') return first.number;
  return null;
}

/** An event payload as the one line `hkb log` prints for it. */
const detailOf = (payload = {}) => String(payload.status ?? payload.reason ?? payload.title ?? payload.text ?? (payload.attempt != null ? `attempt ${payload.attempt}` : ''));

// The two fixture helpers are `test/fake-gh.js`'s, and there is deliberately one copy: a card spec
// that meant different labels depending on which double read it would make the two suites disagree
// about what a board looks like.
export { kbIssue, runWith } from './fake-gh.js';
