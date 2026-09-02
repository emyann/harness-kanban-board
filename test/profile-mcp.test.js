// #257 — `"mcp"` on a profile: a whitelist under `curate`, a subtraction under `inherit`.
//
// Every answer here comes from `effectiveTools` (src/model.js), the one derivation of what a launch
// may use. Nothing in this file reads `allowed_tools` to compute a second answer; it only writes
// them as fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveTools, profileMcp, toolPosture } from '../src/model.js';

const servers = (tools) => tools.filter((t) => t.startsWith('mcp__'));

// ---------- curate: the whitelist ----------

test('curate: a profile reaches exactly the servers its "mcp" names, and no others', () => {
  const profile = { tools: 'curate', mcp: ['react-aria'], allowed_tools: ['Read', 'Edit', 'mcp__figma__get_file'] };
  const { tools, dropped, mcp } = effectiveTools(profile, null, {});
  assert.deepEqual(tools, ['Read', 'Edit', 'mcp__react-aria__*'],
    'the named server becomes reachable; the unnamed one goes, whatever allowed_tools said');
  assert.deepEqual(mcp, { posture: 'curate', allow: ['react-aria'], deny: [] });
  assert.deepEqual(dropped, [{ tool: 'mcp__figma__*', source: 'profile.mcp', reason: 'not named by the profile' }]);
});

test('curate: naming a server is what makes the repo\'s own .mcp.json server usable (#130)', () => {
  // The story #130 was filed about: react-aria sits in the repo's `.mcp.json`, the worker inherits
  // it, and `allowed_tools` never named it — so every one of its tools was denied and the worker
  // built the components from training knowledge instead.
  const before = { allowed_tools: ['Read', 'Edit'] };
  assert.deepEqual(servers(effectiveTools(before, null, {}).tools), [], 'today: not one tool of it is granted');
  const after = { ...before, mcp: ['react-aria'] };
  assert.deepEqual(servers(effectiveTools(after, null, {}).tools), ['mcp__react-aria__*']);
});

test('curate: an explicit grant already covering the server is not duplicated', () => {
  const profile = { mcp: ['react-aria'], allowed_tools: ['Read', 'mcp__react-aria__*'] };
  assert.deepEqual(effectiveTools(profile, null, {}).tools, ['Read', 'mcp__react-aria__*']);
});

test('curate: "mcp": [] is a real choice — no MCP server at all', () => {
  const profile = { mcp: [], allowed_tools: ['Read', 'mcp__supabase__*'] };
  const { tools, mcp } = effectiveTools(profile, null, {});
  assert.deepEqual(tools, ['Read']);
  assert.deepEqual(mcp, { posture: 'curate', allow: [], deny: [] });
});

test('curate: a harness with no per-command allow-list is left alone', () => {
  // codex: the sandbox is the policy. Adding one server would turn "no allow-list" into an
  // allow-list of one, which denies everything else — the opposite of what the board asked for.
  const profile = { mcp: ['react-aria'], allowed_tools: null };
  const { tools, mcp } = effectiveTools(profile, null, {});
  assert.deepEqual(tools, []);
  assert.equal(mcp.allow, null, 'nothing here can honestly claim to narrow that harness');
});

// ---------- inherit: the subtraction ----------

test('inherit: the session\'s servers minus the excluded one — the production-database case', () => {
  // The operator's case, exactly: a Supabase server that writes to production must not be left in
  // an unattended worker's hands, and an inherit board can only express that as a subtraction.
  const profile = { tools: 'inherit', mcp: ['supabase'], allowed_tools: ['Read', 'Edit'] };
  const { tools, mcp } = effectiveTools(profile, null, {});
  assert.deepEqual(tools, ['Read', 'Edit'], 'inheriting is not narrowing: the rest of the grant is untouched');
  assert.deepEqual(mcp, { posture: 'inherit', allow: null, deny: ['supabase'] },
    'allow is null — the session\'s servers, whatever they are — and supabase is subtracted from it');
});

test('inherit: an excluded server is not handed back through allowed_tools', () => {
  const profile = { tools: 'inherit', mcp: ['supabase'], allowed_tools: ['Read', 'mcp__supabase__query', 'mcp__react-aria__*'] };
  const { tools, dropped, mcp } = effectiveTools(profile, null, {});
  assert.deepEqual(tools, ['Read', 'mcp__react-aria__*']);
  assert.deepEqual(dropped, [{ tool: 'mcp__supabase__*', source: 'profile.mcp', reason: 'excluded by the profile' }]);
  assert.deepEqual(mcp.deny, ['supabase']);
});

test('inherit: a card can narrow to a few of the session\'s servers, but never past an exclusion', () => {
  const profile = { tools: 'inherit', mcp: ['supabase'], allowed_tools: ['Read'] };
  const ok = effectiveTools(profile, { kb: { mcp: ['react-aria'] } }, {});
  assert.deepEqual(ok.mcp, { posture: 'inherit', allow: ['react-aria'], deny: ['supabase'] });
  assert.deepEqual(ok.dropped, []);

  const widen = effectiveTools(profile, { kb: { mcp: ['react-aria', 'supabase'] } }, {});
  assert.deepEqual(widen.mcp.allow, ['react-aria'], 'a card cannot un-exclude what the board withheld');
  assert.deepEqual(widen.dropped, [{ tool: 'mcp__supabase__*', source: 'kb.mcp', reason: 'excluded by the profile' }]);
});

// ---------- the promise that a board declaring nothing is unchanged ----------

test('a profile with no "mcp" is byte-identical to before, under either posture', () => {
  const grant = ['Read', 'Edit', 'mcp__react-aria__*'];
  for (const tools of [undefined, 'curate', 'inherit']) {
    const profile = tools === undefined ? { allowed_tools: [...grant] } : { tools, allowed_tools: [...grant] };
    const out = effectiveTools(profile, null, {});
    assert.deepEqual(out.tools, grant, `posture ${tools}: the grant is untouched`);
    assert.deepEqual(out.dropped, []);
    assert.equal(out.mcp.allow, null);
    assert.deepEqual(out.mcp.deny, []);
    assert.equal(out.mcp.posture, toolPosture(profile));
  }
});

test('profileMcp: null when undeclared, deduped and trimmed when declared', () => {
  assert.equal(profileMcp({}), null);
  assert.equal(profileMcp(null), null);
  assert.equal(profileMcp({ mcp: 'react-aria' }), null, 'a string is not a list — loadBoard is where that is refused');
  assert.deepEqual(profileMcp({ mcp: [] }), []);
  assert.deepEqual(profileMcp({ mcp: [' react-aria ', 'react-aria', '', 'figma'] }), ['react-aria', 'figma']);
});
