// An in-memory `Store` — the §6.4 interface (docs/local-first.md, `STORE_METHODS` in
// `src/store/index.js`) over plain objects, with nothing under it. No `gh`, no git, no SQLite.
//
//   const store = new FakeStore();
//   store.addCard(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
//   const restore = store.install();          // installs it as openStore()'s answer
//
// It exists so a scenario can assert on **what the board was asked to do** rather than on which
// REST paths one driver happens to send. `test/fake-gh.js` models GitHub's wire protocol and is the
// right double for the forge half (`src/forge.js`) and for the GitHub driver's own conformance run;
// this one models the board, and its `calls` are interface method names:
//
//   gh.callsMatching('POST', /issues\/7\/labels/)   →   store.callsOf('setStatus')
//   gh.lockRefs()                                   →   store.locks()
//   gh.runOf(7)                                     →   store.runOf(7)
//
// Card records are the same shape `test/fake-gh.js` seeds, so `kbIssue()` feeds either double and a
// `FakeGh` can be handed in to share one set of records with the forge half (see the constructor).
import { setStore } from '../src/store/index.js';
import { normalizeCardGrants } from '../src/board.js';
import {
  DEFAULT_KB, L, RESULT_MARKER, RUN_MARKER,
  agentOf, boardOf, emptyRun, isResultComment, parseBodyBlock, parseResultComment, parseRunComment,
  pickRunComment, serializeBodyBlock, serializeRunComment, statusOf,
} from '../src/model.js';

export { kbIssue, runWith } from './fake-gh.js';

/** @returns {Error & {exitCode: number}} */
function fail(message, exitCode = 2) {
  const e = /** @type {any} */ (new Error(message));
  e.exitCode = exitCode;
  return e;
}

export class FakeStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.board]  the board slug this store answers for
   * @param {string} [opts.host]
   * @param {any} [opts.gh]  a `FakeGh` to share card records with. Hand one in when the scenario
   *   also exercises the forge (`src/forge.js` reads pull requests off these same records through
   *   the gh transport) — seeding once then shows up on both sides, which is what a real board does.
   * @param {boolean} [opts.events]  whether `capabilities().events` is true (the local store's answer)
   * @param {any} [opts.settings]  what `board().settings` carries
   */
  constructor({ board = 'default', host = 'test-host', gh = null, events = true, settings = {} } = {}) {
    this.kind = 'fake';
    this.gh = gh;
    /** number -> card record, in `test/fake-gh.js`'s issue shape */
    this.cards = gh ? gh.issues : new Map();
    /** `${n}/${k}` -> { token, beat_at } */
    this.claims = new Map();
    /** every interface call, in order: `{ method, args }` */
    this.calls = [];
    this.log = [];
    this.nextCommentId = 9000;
    this.nextEventId = 1;
    this.tokenSeq = 0;
    this._events = events;
    this._board = { slug: board, host, paused_at: null, paused_by: null, settings: { ...settings } };
    this._root = '/fake/store';
  }

  /** Install as `openStore`'s answer. Returns the restore function from `setStore`. */
  install() { return setStore(() => this); }

  // ---------- seeding ----------

  /**
   * Seed a card from a `kbIssue()` spec (or a bare `{number, title, labels, comments}`), without
   * going through `createTask` — the equivalent of `FakeGh.addIssue`, and the reason the record
   * shape is shared.
   */
  addCard(spec = {}) {
    const number = spec.number ?? this.#nextNumber();
    const card = {
      number,
      id: spec.id || `I_kwFake${number}`,
      databaseId: spec.databaseId ?? 5_000_000 + number,
      title: spec.title || `issue ${number}`,
      body: spec.body || '',
      state: String(spec.state || 'OPEN').toUpperCase(),
      stateReason: spec.stateReason ? String(spec.stateReason).toUpperCase() : null,
      labels: [...(spec.labels || [])],
      comments: [],
      blockedBy: [...(spec.blockedBy || [])], // issue numbers, or literal {number,state,...}
      prs: [...(spec.prs || [])],
      events: [...(spec.events || [])],
      createdAt: spec.createdAt || `2026-08-26T00:00:${String(number % 60).padStart(2, '0')}Z`,
      updatedAt: spec.updatedAt || spec.createdAt || '2026-08-26T01:00:00Z',
      url: `https://github.com/acme/board/issues/${number}`,
    };
    this.cards.set(number, card);
    for (const body of spec.comments || []) this.#comment(number, body);
    return card;
  }

  /** Alias, so a harness that seeds through `FakeGh.addIssue` reads the same either way. */
  addIssue(spec) { return this.addCard(spec); }

  /** A beat somebody else recorded, as `lockBeatAt` reads it back. */
  recordBeat(n, k, at) {
    const lock = this.claims.get(this.#key(n, k));
    if (lock) lock.beat_at = new Date(at).toISOString();
    return lock;
  }

  // ---------- assertions ----------

  /** Every live claim as `"<n>/<k>"`, sorted — what `FakeGh.lockRefs()` used to say in ref names. */
  locks() { return [...this.claims.keys()].sort(); }

  labelsOf(n) { return [...this.#card(n).labels]; }
  statusOf(n) { return statusOf(this.#card(n).labels); }

  /** The run record the board would read back, or null. */
  runOf(n) {
    const picked = pickRunComment(this.#card(n).comments);
    return picked.chosen ? parseRunComment(picked.chosen.body) : null;
  }

  /** Every call to `name` — for "and it did this once" and "and it never wrote" assertions. */
  callsOf(name) { return this.calls.filter((c) => c.method === name); }

  /** Every call that changes the board. The store vocabulary's answer to "did anything get written". */
  writes() { return this.calls.filter((c) => WRITES.has(c.method)); }

  // ---------- the interface ----------

  root() { return this._root; }
  capabilities() { return { events: this._events }; }

  board() {
    this.#note('board');
    return { ...this._board, settings: { ...this._board.settings } };
  }

  setBoard(patch = {}) {
    this.#note('setBoard', patch);
    Object.assign(this._board, patch);
    if (patch.settings) this._board.settings = { ...this._board.settings, ...patch.settings };
    return this.board();
  }

  /** @param {{states?: string[], blockers?: boolean|'all'}} [opts] */
  async listTasks({ states = ['OPEN'], blockers = true } = {}) {
    this.#note('listTasks', { states, blockers });
    const want = states.map((x) => String(x).toUpperCase());
    for (const x of want) {
      if (x !== 'OPEN' && x !== 'CLOSED') throw fail(`listTasks: unknown state "${x}" — a store knows OPEN and CLOSED`);
    }
    return [...this.cards.values()]
      .filter((c) => want.includes(c.state) && (!this._board.slug || c.labels.includes(L.board(this._board.slug))))
      .sort((a, b) => a.number - b.number)
      .map((c) => this.#toTask(c));
  }

  async listClosedRecent({ first = 30 } = {}) {
    this.#note('listClosedRecent', { first });
    return [...this.cards.values()]
      .filter((c) => c.state === 'CLOSED' && c.labels.includes(L.board(this._board.slug)))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, first)
      .map((c) => this.#toTask(c));
  }

  async getTask(n) {
    this.#note('getTask', n);
    return this.#toTask(this.#card(n));
  }

  async createTask({ title, body = '', kb = {}, status = 'triage', agent = null }) {
    this.#note('createTask', { title, status, agent });
    const labels = [L.board(this._board.slug), L.status(status)];
    if (agent) labels.push(L.agent(agent));
    const card = this.addCard({ title, body: serializeBodyBlock({ ...DEFAULT_KB, ...kb }, body), labels });
    this.#append('create', card.number, { title, status, agent });
    return this.#toTask(card);
  }

  /** Replace the prose, keep the machine block — a raw body write would drop `kb` silently. */
  async updateBody(n, body) {
    this.#note('updateBody', n);
    const card = this.#card(n);
    const { kb } = parseBodyBlock(card.body);
    card.body = serializeBodyBlock(kb, body);
    this.#touch(card, 'updateBody', n);
    return this.#toTask(card);
  }

  async setStatus(task, status, { add = [], remove = [] } = {}) {
    this.#note('setStatus', { number: task.number, status, add, remove });
    const card = this.#card(task.number);
    card.labels = card.labels.filter((l) => !l.startsWith('kb:status:') && !remove.includes(l));
    card.labels.push(L.status(status));
    for (const l of add) if (!card.labels.includes(l)) card.labels.push(l);
    this.#touch(card, 'setStatus', task.number, { status });
    return this.#sync(task, card);
  }

  async setAgent(task, agent) {
    this.#note('setAgent', { number: task.number, agent });
    const card = this.#card(task.number);
    // exactly one profile label survives: adding beside the old one is #113
    card.labels = card.labels.filter((l) => !l.startsWith('kb:agent:'));
    card.labels.push(L.agent(agent));
    this.#touch(card, 'setAgent', task.number, { agent });
    return this.#sync(task, card);
  }

  async addLabels(task, names) {
    this.#note('addLabels', { number: task.number, names });
    const card = this.#card(task.number);
    for (const l of names) if (!card.labels.includes(l)) card.labels.push(l);
    this.#touch(card, 'addLabels', task.number, { names });
    return this.#sync(task, card);
  }

  async removeLabel(task, name) {
    this.#note('removeLabel', { number: task.number, name });
    const card = this.#card(task.number);
    card.labels = card.labels.filter((l) => l !== name);
    this.#touch(card, 'removeLabel', task.number, { name });
    return this.#sync(task, card);
  }

  async closeTask(n, reason = 'completed') {
    this.#note('closeTask', { number: n, reason });
    const card = this.#card(n);
    card.state = 'CLOSED';
    card.stateReason = String(reason).toUpperCase();
    this.#touch(card, 'closeTask', n, { reason });
    return this.#toTask(card);
  }

  async reopenTask(n) {
    this.#note('reopenTask', n);
    const card = this.#card(n);
    card.state = 'OPEN';
    card.stateReason = null;
    this.#touch(card, 'reopenTask', n);
    return this.#toTask(card);
  }

  async addBlockedBy(child, parent) {
    this.#note('addBlockedBy', { child, parent });
    const card = this.#card(child);
    this.#card(parent); // a blocker that is not on the board is a bug in the fixture, not a link
    if (!this.#blockerNumbers(card).includes(Number(parent))) card.blockedBy.push(Number(parent));
    this.#touch(card, 'addBlockedBy', child, { parent });
    return this.#toTask(card);
  }

  async removeBlockedBy(child, parent) {
    this.#note('removeBlockedBy', { child, parent });
    const card = this.#card(child);
    card.blockedBy = card.blockedBy.filter((b) => (b && typeof b === 'object' ? b.number : Number(b)) !== Number(parent));
    this.#touch(card, 'removeBlockedBy', child, { parent });
    return this.#toTask(card);
  }

  // ---- runs, results, notes ----

  async loadRun(n) {
    this.#note('loadRun', n);
    const picked = pickRunComment(this.#card(n).comments);
    if (!picked.chosen) return { id: null, run: emptyRun(), duplicates: [] };
    return { id: picked.chosen.id, run: parseRunComment(picked.chosen.body) || emptyRun(), duplicates: picked.duplicates.map((c) => c.id) };
  }

  /** Mutates `rec.id` in place, so a create is followed by updates and never a second record. */
  async saveRun(n, rec) {
    this.#note('saveRun', n);
    const card = this.#card(n);
    const body = serializeRunComment(rec.run);
    const existing = rec.id ? card.comments.find((c) => c.id === rec.id) : null;
    if (existing) existing.body = body;
    else rec.id = this.#comment(n, body).id;
    this.#touch(card, 'saveRun', n);
    return { id: rec.id };
  }

  async latestResult(n) {
    this.#note('latestResult', n);
    const results = this.#card(n).comments
      .map((c) => ({ comment: c, parsed: String(c.body || '').startsWith(RESULT_MARKER) ? parseResultComment(c.body) : null }))
      .filter((x) => x.parsed);
    if (!results.length) return null;
    const last = results[results.length - 1];
    return { ...last.parsed, at: last.comment.created_at, url: last.comment.html_url };
  }

  async parentResults(task) {
    this.#note('parentResults', task.number);
    const out = [];
    for (const b of task.blockedBy || []) {
      const r = await this.latestResult(b.number);
      out.push({ number: b.number, title: b.title, state: b.state, result: r });
    }
    return out;
  }

  async addNote(n, text) {
    this.#note('addNote', n);
    const card = this.#card(n);
    const c = this.#comment(n, text);
    this.#touch(card, 'addNote', n);
    return c;
  }

  /** What a *person* wrote: hkb's own run and result records are not notes. */
  async listNotes(n) {
    this.#note('listNotes', n);
    return this.#card(n).comments
      .filter((c) => !String(c.body || '').startsWith(RUN_MARKER) && !isResultComment(c.body))
      .map((c) => ({ id: c.id, at: c.created_at, actor: c.user?.login || null, text: c.body || '' }));
  }

  // ---- claims ----

  async claim(n, k) {
    this.#note('claim', { n, k });
    const key = this.#key(n, k);
    if (this.claims.has(key)) return { result: 'held', token: null };
    const token = this.#token();
    this.claims.set(key, { token, beat_at: null });
    this.#append('claim', n, { k });
    return { result: 'claimed', token };
  }

  async release(n, k) {
    this.#note('release', { n, k });
    const had = this.claims.delete(this.#key(n, k));
    if (had) this.#append('release', n, { k });
    return had;
  }

  async listLocks() {
    this.#note('listLocks');
    return [...this.claims.entries()]
      .map(([key, lock]) => {
        const [n, k] = key.split('/').map(Number);
        return { n, k, token: lock.token, beat_at: lock.beat_at };
      })
      .sort((a, b) => a.n - b.n || a.k - b.k);
  }

  async lockBeatAt(n, k, _token = null) {
    this.#note('lockBeatAt', { n, k });
    return this.claims.get(this.#key(n, k))?.beat_at ?? null;
  }

  /** One compare-and-swap on the claim, leased on where this worker left it. */
  heartbeat(n, k, expected) {
    this.#note('heartbeat', { n, k });
    const lock = this.claims.get(this.#key(n, k));
    if (!lock || lock.token !== expected) return { result: 'lost', token: null };
    lock.token = this.#token();
    lock.beat_at = new Date().toISOString();
    return { result: 'ok', token: lock.token };
  }

  // ---- events ----

  async events({ after = 0, limit = 200 } = {}) {
    this.#note('events', { after, limit });
    if (!this._events) throw fail('this store has no event log (capabilities().events is false)');
    return this.log.filter((e) => e.id > after).slice(0, limit);
  }

  // ---------- internals ----------

  #key(n, k) { return `${Number(n)}/${Number(k)}`; }
  #token() { return `t${String(++this.tokenSeq).padStart(4, '0')}`.padEnd(40, '0'); }
  #nextNumber() { return Math.max(0, ...this.cards.keys()) + 1; }
  #note(method, ...args) { this.calls.push({ method, args }); }

  #card(n) {
    const card = this.cards.get(Number(n));
    if (!card) throw fail(`no card #${n} on this board — seed it with addCard(kbIssue({number: ${n}}))`);
    return card;
  }

  #comment(n, body) {
    const card = this.#card(n);
    const c = {
      id: this.nextCommentId++,
      body,
      user: { login: 'hkb' },
      created_at: '2026-08-26T01:00:00Z',
      updated_at: '2026-08-26T01:00:00Z',
      html_url: `${card.url}#issuecomment-${this.nextCommentId}`,
    };
    card.comments.push(c);
    return c;
  }

  #touch(card, kind, number, payload = {}) {
    card.updatedAt = new Date().toISOString();
    this.#append(kind, number, payload);
  }

  #append(kind, number, payload = {}) {
    if (!this._events) return;
    this.log.push({ id: this.nextEventId++, at: new Date().toISOString(), kind, number: number ?? null, payload });
  }

  #blockerNumbers(card) {
    return card.blockedBy.map((b) => (b && typeof b === 'object' ? Number(b.number) : Number(b)));
  }

  #blockers(card) {
    return card.blockedBy.map((b) => {
      if (b && typeof b === 'object') {
        return { number: b.number, state: String(b.state || 'OPEN').toUpperCase(), stateReason: b.stateReason ? String(b.stateReason).toUpperCase() : null, title: b.title || `issue ${b.number}` };
      }
      const parent = this.cards.get(Number(b));
      if (!parent) throw fail(`#${b} blocks #${card.number} but was never seeded`);
      return { number: parent.number, state: parent.state, stateReason: parent.stateReason, title: parent.title };
    });
  }

  /** The card record as `src/model.js` reads a task — `toTask` in `src/store/github.js`, verbatim. */
  #toTask(card) {
    const labels = [...card.labels];
    const { kb, rest: bodyText } = parseBodyBlock(card.body);
    normalizeCardGrants(kb);
    return {
      number: card.number,
      nodeId: card.id,
      databaseId: card.databaseId,
      title: card.title,
      body: card.body || '',
      bodyText,
      kb,
      labels,
      status: statusOf(labels),
      agent: agentOf(labels),
      board: boardOf(labels),
      needsHuman: labels.includes(L.needsHuman),
      state: card.state,
      stateReason: card.stateReason,
      updatedAt: card.updatedAt,
      createdAt: card.createdAt,
      url: card.url,
      blockedBy: this.#blockers(card),
      prs: card.prs.map((p) => ({ number: p.number, nodeId: p.nodeId || `PR_kwFake${p.number}`, state: p.state, isDraft: !!p.isDraft, url: p.url || `https://github.com/acme/board/pull/${p.number}`, headRefName: p.headRefName || `kb/${card.number}`, baseRefName: p.baseRefName || null, merged: !!p.merged, autoMergeEnabled: !!p.autoMerge })),
    };
  }

  /**
   * Bring the caller's task object up to date in place. Every verb holds one task through a whole
   * tick and reads `task.status` after moving it, so a driver that returned a fresh object and left
   * the old one stale would break them silently (`syncTask`, `src/store/git.js`).
   */
  #sync(task, card) {
    const read = this.#toTask(card);
    for (const key of Object.keys(read)) task[key] = read[key];
    return task;
  }
}

/** The methods that change the board — what `writes()` counts. */
const WRITES = new Set([
  'setBoard', 'createTask', 'updateBody', 'setStatus', 'setAgent', 'addLabels', 'removeLabel',
  'closeTask', 'reopenTask', 'addBlockedBy', 'removeBlockedBy', 'saveRun', 'addNote',
  'claim', 'release',
]);
