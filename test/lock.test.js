import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhError, classify } from '../src/gh.js';
import { classifyClaimError } from '../src/lock.js';

test('claim classification: 409 and "already exists" are held; everything else is unknown', () => {
  assert.equal(classifyClaimError(new GhError('x', { status: 409, kind: 'conflict' })), 'held');
  assert.equal(classifyClaimError(new GhError('Reference already exists', { status: 422, kind: 'validation' })), 'held');
  assert.equal(classifyClaimError(new GhError('the endpoint has been spammed', { status: 422, kind: 'validation' })), 'unknown');
  assert.equal(classifyClaimError(new GhError('rate limited', { status: 403, kind: 'ratelimit' })), 'unknown');
  assert.equal(classifyClaimError(new GhError('boom', { status: 502, kind: 'server' })), 'unknown');
  assert.equal(classifyClaimError(new GhError('dial tcp: no such host', { status: 0, kind: 'network' })), 'unknown');
  assert.equal(classifyClaimError(new Error('plain')), 'unknown');
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
