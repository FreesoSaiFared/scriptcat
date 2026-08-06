'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const launcher = fs.readFileSync(
  path.join(__dirname, 'start-chatgpt-torsionfield-lab.ps1'),
  'utf8',
);

assert.match(
  launcher,
  /corepack pnpm run build:torsionfield/,
  'the Torsionfield launcher must build the trusted Torsionfield channel',
);
assert.doesNotMatch(
  launcher,
  /corepack pnpm run build(?:\s|$)/,
  'the Torsionfield launcher must not silently replace the trusted build with a generic build',
);

console.log(JSON.stringify({ ok: true, assertions: 2, purpose: 'launcher preserves the trusted Torsionfield build' }));
