'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./transductive-prompt-runtime.chatgpt-lab-core.js');

const selfTest = core.runCoreSelfTest();
assert.equal(selfTest.ok, true, selfTest.failures.join(', '));

const codeGate = core.validateResponse('```js\nconsole.log(1)\n```', ['code-only']);
assert.deepEqual(codeGate, []);
assert.equal(core.validateResponse('text before\n```js\nconsole.log(1)\n```', ['code-only']).length, 1);

assert.deepEqual(core.validateResponse('{"ok":true}', ['json-only']), []);
assert.equal(core.validateResponse('```json\n{"ok":true}\n```', ['json-only']).length, 1);

assert.deepEqual(core.validateResponse('```diff\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n```', ['patch-only']), []);
assert.equal(core.validateResponse('diff --git a/a b/a', ['patch-only']).length, 1);

assert.equal(
  core.validateResponse('```text\nIf you want, this is quoted test data.\n```', ['direct-language']).length,
  0,
  'direct-language gate must ignore fenced source material'
);
assert.equal(core.validateResponse('If you want, I can help.', ['direct-language']).length > 0, true);

const normalized = core.normalizeEpochState({ activeGates: ['code-only', 'json-only', 'direct-language'] });
assert.deepEqual(normalized.activeGates, ['direct-language', 'code-only']);

const first = core.buildConstraintContract(normalized);
const second = core.buildConstraintContract(normalized);
assert.equal(first.fingerprint, second.fingerprint);
assert.match(first.text, /OUTPUT-GATE code-only/);
assert.doesNotMatch(first.text, /OUTPUT-GATE json-only/);

const repeated = `before\n${first.text}\nmiddle\n${first.text}\nafter`;
assert.equal(core.stripConstraintContracts(repeated), 'before\n\nmiddle\n\nafter');

const candidates = core.detectPromptCandidates(`
<prompt>
You are a deterministic tool. Always inspect the input. Never invent evidence. Before acting, identify the concrete target. Do not create unrelated layers. Return the complete result. Preserve exact source terminology.
</prompt>
`);
assert.equal(candidates.length, 1);

const oversizedLibrary = Array.from({ length: 260 }, (_, index) => ({
  title: `Prompt ${index}`,
  path: ['Imported'],
  body: `Instruction ${index} `.repeat(10),
}));
assert.equal(core.normalizePromptLibrary(oversizedLibrary).length, 200);

const installedMetadata = fs.readFileSync(
  path.join(__dirname, 'transductive-prompt-runtime.chatgpt-lab.user.js'),
  'utf8',
);
assert.match(installedMetadata, /@version\s+0\.3\.3-authoritative-port/);
assert.match(installedMetadata, /@require\s+https:\/\/raw\.githubusercontent\.com\/FreesoSaiFared\/scriptcat\/9c2092795a328f6535584c3215c2a3aacbf5e52a\/userscripts\/torsionfield-chatgpt-conversation-surface\.js/);
assert.match(installedMetadata, /@require\s+https:\/\/raw\.githubusercontent\.com\/FreesoSaiFared\/scriptcat\/9c2092795a328f6535584c3215c2a3aacbf5e52a\/userscripts\/transductive-prompt-runtime\.chatgpt-lab-core\.js/);
assert.doesNotMatch(installedMetadata, /raw\.githubusercontent\.com\/FreesoSaiFared\/scriptcat\/refs\/heads\//);

console.log(JSON.stringify({
  ok: true,
  version: core.VERSION,
  assertions: 20,
  contractFingerprint: first.fingerprint,
}));
