import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { holderId, parseHolder, holderLiveness, pidIsAlive, bootTime } from '../src/liveness.ts';

/**
 * The clock is not the only evidence.
 *
 * A lease expires on the wall clock; a run times out on a monotonic one. Across a suspend those
 * two disagree, and the disagreement makes a live worker look abandoned. Everything here is about
 * the case where the answer must be "leave it alone" — the reclaim path already had tests proving
 * it takes a lease, and none proving it declines to.
 */

const HERE = os.hostname();
const recent = () => new Date();

test('a holder round-trips: the host is in it, because a pid alone means nothing', () => {
  const h = holderId('claude', 4242, 'laptop');
  assert.equal(h, 'laptop/4242@claude');
  assert.deepEqual(parseHolder(h), { host: 'laptop', pid: 4242 });
});

test('a holder from another machine is unknown, never dead', () => {
  const h = holderId('claude', 4242, 'someone-elses-box');
  assert.equal(holderLiveness(h, recent(), { hostname: HERE }), 'unknown',
    'guessing dead here starts a second worker on a Job that already has one');
});

test('an unparseable holder is unknown — including the old bare-pid format', () => {
  assert.equal(holderLiveness('4242@claude', recent()), 'unknown');
  assert.equal(holderLiveness('', recent()), 'unknown');
  assert.equal(parseHolder('nonsense'), null);
});

test('our own process is alive, so its lease is not free to take', () => {
  const h = holderId('claude', process.pid, HERE);
  assert.equal(holderLiveness(h, recent()), 'alive');
});

test('a process that has exited is dead, and does not wait for the clock', () => {
  // A real pid that is really gone: spawn something, let it finish, keep the number.
  const done = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(done.status, 0);
  const gone = done.pid as number;
  assert.equal(pidIsAlive(gone), false, 'the child has exited');
  assert.equal(holderLiveness(holderId('claude', gone, HERE), recent()), 'dead',
    'reclaim should not have to wait out the lease when the holder is provably gone');
});

test('a lease older than this boot is dead however alive its pid looks', () => {
  // The pid-recycling case. After a reboot some other process holds 4242; without the boot check
  // this reads `alive` for ever and the Job is never reclaimed — stuck, not double-run, but stuck.
  const beforeBoot = new Date(bootTime() - 60 * 60_000);
  const answer = holderLiveness(holderId('claude', 4242, HERE), beforeBoot, {
    hostname: HERE,
    alive: () => true, // pretend the recycled pid is running
  });
  assert.equal(answer, 'dead');
});

test('a lease taken after boot still consults the pid', () => {
  const afterBoot = new Date(bootTime() + 60_000);
  const opts = { hostname: HERE, now: () => Date.now() };
  assert.equal(holderLiveness(holderId('c', 4242, HERE), afterBoot, { ...opts, alive: () => true }), 'alive');
  assert.equal(holderLiveness(holderId('c', 4242, HERE), afterBoot, { ...opts, alive: () => false }), 'dead');
});

test('pid 0 and negatives are not alive, whatever the kernel would say about them', () => {
  // `process.kill(0, 0)` signals the whole process group, which is emphatically not the question.
  assert.equal(pidIsAlive(0), false);
  assert.equal(pidIsAlive(-1), false);
  assert.equal(pidIsAlive(1.5), false);
});

test('boot time is in the past and inside the machines uptime', () => {
  const b = bootTime();
  assert.ok(b < Date.now(), 'the machine booted before now');
  assert.ok(Date.now() - b >= os.uptime() * 1000 - 1000);
});
