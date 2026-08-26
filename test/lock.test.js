import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhError, classify } from '../src/gh.js';
import { classifyClaimError } from '../src/lock.js';
import { classifyLeasePush, heartbeatMode, lastSignalAt } from '../src/model.js';

test('claim classification: 409 and "already exists" are held; everything else is unknown', () => {
  assert.equal(classifyClaimError(new GhError('x', { status: 409, kind: 'conflict' })), 'held');
  assert.equal(classifyClaimError(new GhError('Reference already exists', { status: 422, kind: 'validation' })), 'held');
  assert.equal(classifyClaimError(new GhError('the endpoint has been spammed', { status: 422, kind: 'validation' })), 'unknown');
  assert.equal(classifyClaimError(new GhError('rate limited', { status: 403, kind: 'ratelimit' })), 'unknown');
  assert.equal(classifyClaimError(new GhError('boom', { status: 502, kind: 'server' })), 'unknown');
  assert.equal(classifyClaimError(new GhError('dial tcp: no such host', { status: 0, kind: 'network' })), 'unknown');
  assert.equal(classifyClaimError(new Error('plain')), 'unknown');
});

test('lease classification: only a rejected push is LOCK_LOST', () => {
  const rejected = "To github.com:acme/board.git\n ! [rejected]        9f856d0 -> refs/kb/locks/1/1 (stale info)\nerror: failed to push some refs";
  assert.equal(classifyLeasePush(0, 'Everything up-to-date'), 'ok');
  assert.equal(classifyLeasePush(1, rejected), 'lost');
  // a deleted ref (the dispatcher reclaimed) reads exactly like a stale lease — verified against git
  assert.equal(classifyLeasePush(1, ' ! [rejected]        9f856d0 -> refs/kb/locks/1/1 (stale info)'), 'lost');
  // everything else says nothing about the lock, and must never stop a healthy worker
  assert.equal(classifyLeasePush(128, "fatal: 'origin' does not appear to be a git repository"), 'unavailable');
  assert.equal(classifyLeasePush(128, 'fatal: could not read Username: No such device or address'), 'unavailable');
  assert.equal(classifyLeasePush(128, 'fatal: unable to access ...: Could not resolve host: github.com'), 'unavailable');
  assert.equal(classifyLeasePush(1, ' ! [remote rejected] refs/kb/locks/1/1 (pre-receive hook declined)'), 'unavailable');
  assert.equal(classifyLeasePush(null, 'spawnSync git ENOENT'), 'unavailable');
});

test('heartbeat mode comes from the profile, and anything unknown means auto', () => {
  const cfg = { profiles: { claude: { heartbeat: 'ref' }, cloud: { heartbeat: 'comment' }, odd: { heartbeat: 'yes' }, plain: {} } };
  assert.equal(heartbeatMode(cfg, 'claude'), 'ref');
  assert.equal(heartbeatMode(cfg, 'cloud'), 'comment');
  assert.equal(heartbeatMode(cfg, 'odd'), 'auto');
  assert.equal(heartbeatMode(cfg, 'plain'), 'auto');
  assert.equal(heartbeatMode(cfg, 'missing'), 'auto');
  assert.equal(heartbeatMode(null, null), 'auto');
});

test('the last signal is the freshest of started_at, heartbeat_at and the lock ref commit', () => {
  const a = { started_at: '2026-08-26T01:00:00.000Z', heartbeat_at: '2026-08-26T02:00:00.000Z' };
  assert.equal(lastSignalAt(a, '2026-08-26T03:00:00Z'), '2026-08-26T03:00:00Z', 'a CAS beat wins');
  assert.equal(lastSignalAt(a, '2026-08-26T01:30:00Z'), a.heartbeat_at, 'an old ref (never beaten) does not');
  assert.equal(lastSignalAt(a, null), a.heartbeat_at);
  assert.equal(lastSignalAt({ started_at: a.started_at }, null), a.started_at);
  assert.equal(lastSignalAt({ started_at: a.started_at }, 'not a date'), a.started_at);
  assert.equal(lastSignalAt({}, null), null);
});

test('gh error classification', () => {
  assert.equal(classify(0, 'error connecting to api.github.com: dial tcp: no such host'), 'network');
  assert.equal(classify(403, 'API rate limit exceeded'), 'ratelimit');
  assert.equal(classify(403, 'Resource not accessible by integration'), 'auth');
  assert.equal(classify(429, ''), 'ratelimit');
  assert.equal(classify(404, 'Not Found'), 'notfound');
  assert.equal(classify(409, ''), 'conflict');
  assert.equal(classify(422, 'Validation Failed'), 'validation');
  assert.equal(classify(503, ''), 'server');
  assert.equal(classify(0, 'To get started with GitHub CLI, please run: gh auth login'), 'auth');
});
