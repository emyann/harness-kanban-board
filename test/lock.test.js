import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhError, classify } from '../src/gh.js';
import { classifyClaimError } from '../src/forge.js';
import { lastSignalAt } from '../src/model.js';

test('claim classification: 409 and "already exists" are held; everything else is unknown', () => {
  assert.equal(classifyClaimError(new GhError('x', { status: 409, kind: 'conflict' })), 'held');
  assert.equal(classifyClaimError(new GhError('Reference already exists', { status: 422, kind: 'validation' })), 'held');
  assert.equal(classifyClaimError(new GhError('the endpoint has been spammed', { status: 422, kind: 'validation' })), 'unknown');
  assert.equal(classifyClaimError(new GhError('rate limited', { status: 403, kind: 'ratelimit' })), 'unknown');
  assert.equal(classifyClaimError(new GhError('boom', { status: 502, kind: 'server' })), 'unknown');
  assert.equal(classifyClaimError(new GhError('dial tcp: no such host', { status: 0, kind: 'network' })), 'unknown');
  assert.equal(classifyClaimError(new Error('plain')), 'unknown');
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

test('a GraphQL "could not resolve" 404 is notfound, not network — a real DNS failure still is', () => {
  assert.equal(classify(0, 'Could not resolve to an Issue with the number of 999999.'), 'notfound');
  assert.equal(classify(0, 'Could not resolve to a Repository with the name \'acme/ghost\'.'), 'notfound');
  assert.equal(classify(0, 'Could not resolve to a User with the login of \'ghost\'.'), 'notfound');
  assert.equal(classify(0, 'Could not resolve to a node with the global id of \'abc\'.'), 'notfound');
  assert.equal(classify(0, 'error connecting to api.github.com: dial tcp: no such host'), 'network');
  assert.equal(classify(0, 'dial tcp: lookup api.github.com: no such host'), 'network');
  assert.equal(classify(0, 'fatal: unable to access ...: Could not resolve host: github.com'), 'network');
  assert.equal(classify(0, 'unexpected EOF'), 'network');
  // "eof" must not fire on unrelated text that merely contains the substring
  assert.equal(classify(0, 'geofencing is enabled for this repo'), 'unknown');
});
