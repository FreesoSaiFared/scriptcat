#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node --check run_probe.mjs
for f in stale/*.js repaired/*.js; do node --check "$f"; done
node run_probe.mjs stale || true
node run_probe.mjs repaired
python3 - <<'PY'
import json
s=json.load(open('result-stale.json'))
r=json.load(open('result-repaired.json'))
assert s['serviceWorkerSurvived'] and s['recreation']['changed'] and s['error'] and not s.get('second')
assert r['serviceWorkerSurvived'] and r['recreation']['changed'] and r['error'] is None and r['second']
assert r['first']['targetId'] != r['second']['targetId']
print('ALL_TORSIONFIELD_OFFSCREEN_BROWSER_PROBE_CHECKS_OK')
PY
