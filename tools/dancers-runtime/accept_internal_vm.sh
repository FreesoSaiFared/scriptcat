#!/usr/bin/env bash
set -Eeuo pipefail

BIN_ZIP="${BIN_ZIP:-/mnt/data/dancers-runtime-binaries.zip}"
SRC_ZIP="${SRC_ZIP:-/mnt/data/dancers-runtime-sources.zip}"
QUARRY_ZIP="${QUARRY_ZIP:-/mnt/data/dancers-source-quarry.zip}"
ROOT="${DANCERS_ROOT:-/mnt/data/dancers-runtime}"
TOOLS_DIR="${DANCERS_TOOLS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
INCOMING="$ROOT/incoming"
PAYLOAD="$ROOT/payload"
OUT="$ROOT/out"
mkdir -p "$INCOMING/bin" "$INCOMING/src" "$INCOMING/quarry" "$PAYLOAD" "$OUT"

log(){ printf '[dancers-runtime] %s\n' "$*" >&2; }
die(){ log "FATAL: $*"; exit 1; }
trap 'rc=$?; log "failed rc=$rc line=$LINENO"; exit $rc' ERR

for f in "$BIN_ZIP" "$TOOLS_DIR/danceseq.py" "$TOOLS_DIR/compile_plan.py" "$TOOLS_DIR/state_to_openpose.py" "$TOOLS_DIR/blender_compile_state.py"; do
  [[ -f "$f" ]] || die "missing $f"
done
[[ -f "$SRC_ZIP" || -f "$QUARRY_ZIP" ]] || die "need at least one source capsule: $SRC_ZIP or $QUARRY_ZIP"
for cmd in python3 tar sha256sum; do command -v "$cmd" >/dev/null || die "$cmd is required"; done

BIN_SHA=$(sha256sum "$BIN_ZIP" | awk '{print $1}')
SRC_SHA=none
QUARRY_SHA=none
[[ -f "$SRC_ZIP" ]] && SRC_SHA=$(sha256sum "$SRC_ZIP" | awk '{print $1}')
[[ -f "$QUARRY_ZIP" ]] && QUARRY_SHA=$(sha256sum "$QUARRY_ZIP" | awk '{print $1}')
TOOLS_SHA=$(sha256sum "$TOOLS_DIR/danceseq.py" "$TOOLS_DIR/compile_plan.py" "$TOOLS_DIR/state_to_openpose.py" "$TOOLS_DIR/blender_compile_state.py" | sha256sum | awk '{print $1}')
STAMP="$BIN_SHA $SRC_SHA $QUARRY_SHA"

if [[ ! -f "$ROOT/.payload-stamp" || "$(cat "$ROOT/.payload-stamp")" != "$STAMP" ]]; then
  log "extracting staged mailbox artifacts"
  rm -rf "$INCOMING/bin" "$INCOMING/src" "$INCOMING/quarry" "$PAYLOAD"
  mkdir -p "$INCOMING/bin" "$INCOMING/src" "$INCOMING/quarry" "$PAYLOAD"

  python3 - "$BIN_ZIP" "$INCOMING/bin" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    z.extractall(sys.argv[2])
PY
  BIN_TAR=$(find "$INCOMING/bin" -type f -name 'dancers-runtime-binaries.tar.gz' -print -quit)
  [[ -n "$BIN_TAR" ]] || die "runtime binaries tar payload missing"
  P=$(dirname "$BIN_TAR")/packages.sha256
  [[ -f "$P" ]] || die "packages.sha256 missing beside runtime binaries tar"
  WANT=$(grep "  $(basename "$BIN_TAR")$" "$P" | awk '{print $1}' | head -n1)
  GOT=$(sha256sum "$BIN_TAR" | awk '{print $1}')
  [[ -n "$WANT" && "$GOT" == "$WANT" ]] || die "runtime package hash mismatch"
  tar -xzf "$BIN_TAR" -C "$PAYLOAD"

  if [[ -f "$SRC_ZIP" ]]; then
    python3 - "$SRC_ZIP" "$INCOMING/src" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    z.extractall(sys.argv[2])
PY
    SRC_TAR=$(find "$INCOMING/src" -type f -name 'dancers-runtime-sources.tar.gz' -print -quit)
    [[ -n "$SRC_TAR" ]] || die "legacy source tar payload missing"
    P=$(dirname "$SRC_TAR")/packages.sha256
    [[ -f "$P" ]] || die "packages.sha256 missing beside legacy source tar"
    WANT=$(grep "  $(basename "$SRC_TAR")$" "$P" | awk '{print $1}' | head -n1)
    GOT=$(sha256sum "$SRC_TAR" | awk '{print $1}')
    [[ -n "$WANT" && "$GOT" == "$WANT" ]] || die "legacy source package hash mismatch"
    tar -xzf "$SRC_TAR" -C "$PAYLOAD"
  fi

  if [[ -f "$QUARRY_ZIP" ]]; then
    log "ingesting unfiltered source quarry"
    python3 - "$QUARRY_ZIP" "$INCOMING/quarry" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    z.extractall(sys.argv[2])
PY
    QUARRY_TAR=$(find "$INCOMING/quarry" -type f -name 'dancers-source-quarry.tar.gz' -print -quit)
    [[ -n "$QUARRY_TAR" ]] || die "source quarry tar payload missing"
    QS=$(find "$INCOMING/quarry" -type f -name 'dancers-source-quarry.tar.gz.sha256' -print -quit)
    [[ -n "$QS" ]] || die "source quarry checksum missing"
    (cd "$(dirname "$QUARRY_TAR")" && sha256sum -c "$(basename "$QS")")
    mkdir -p "$PAYLOAD/quarry"
    tar -xzf "$QUARRY_TAR" -C "$PAYLOAD/quarry"
    if [[ -f "$PAYLOAD/quarry/manifest/source-files.sha256" ]]; then
      (cd "$PAYLOAD/quarry" && sha256sum -c manifest/source-files.sha256)
    fi
    [[ -f "$PAYLOAD/quarry/manifest/source-policy.txt" ]] || die "source quarry policy receipt missing"
    grep -q '^license_filtering=false$' "$PAYLOAD/quarry/manifest/source-policy.txt" || die "unexpected source quarry policy"
  fi

  if [[ -f "$PAYLOAD/manifest/all-files.sha256" ]]; then
    (cd "$PAYLOAD" && grep -v ' manifest/all-files.sha256$' manifest/all-files.sha256 | sha256sum -c -)
  fi
  printf '%s' "$STAMP" > "$ROOT/.payload-stamp"
else
  log "payload hashes unchanged; extraction reused"
fi

BLENDER=$(find "$PAYLOAD/runtime" -maxdepth 3 -type f -name blender -perm -111 -print -quit || true)
GLTFPACK=$(find "$PAYLOAD/runtime" -type f -name gltfpack -perm -111 -print -quit || true)
SD_BIN=$(find "$PAYLOAD/runtime" -type f -perm -111 \( -name sd-cli -o -name sd \) -print -quit || true)
[[ -n "$BLENDER" ]] || die "Blender executable not found"
[[ -n "$GLTFPACK" ]] || die "gltfpack executable not found"

cat > "$OUT/five-dancer.danceseq" <<'EOF'
DANCESEQ/1
bpm 124
fps 24
duration_frames 96
FORM V_SHALLOW
F001 ALL pose neutral
F024 D1,D5 step inward 0.31m
F024 D3 pelvis.z -0.19m
F048 ALL pelvis.yaw -18deg
F048 ALL chest.look camera
F072 ALL root.z +0.17m
F072 ALL root.y -0.24m
F096 ALL pose loop_ready
CONTACT preserve_support
EOF

log "compiling DANCESEQ -> DANCESTATE"
python3 "$TOOLS_DIR/danceseq.py" "$OUT/five-dancer.danceseq" -o "$OUT/five-dancer.plan.json"
python3 "$TOOLS_DIR/compile_plan.py" "$OUT/five-dancer.danceseq" -o "$OUT/five-dancer.state.json"
log "rendering deterministic OpenPose-style ControlNet input"
python3 "$TOOLS_DIR/state_to_openpose.py" "$OUT/five-dancer.state.json" -o "$OUT/control-openpose.png" --frame 48 --receipt "$OUT/control-openpose.json"
[[ -s "$OUT/control-openpose.png" && -s "$OUT/control-openpose.json" ]] || die "OpenPose control render missing"

"$BLENDER" --version > "$OUT/blender-version.txt"
BLENDER_CMD=("$BLENDER" -b --python "$TOOLS_DIR/blender_compile_state.py" -- --state "$OUT/five-dancer.state.json" --out "$OUT" --preview-frame 48)
log "running Blender DANCESTATE adapter"
if command -v xvfb-run >/dev/null 2>&1; then xvfb-run -a "${BLENDER_CMD[@]}"; else "${BLENDER_CMD[@]}"; fi
[[ -s "$OUT/blender-receipt.json" ]] || die "Blender adapter did not emit receipt"
[[ -s "$OUT/five-dancer-raw.glb" ]] || die "raw GLB was not produced"

"$GLTFPACK" -i "$OUT/five-dancer-raw.glb" -o "$OUT/five-dancer-packed.glb" -cc > "$OUT/gltfpack.txt" 2>&1 || \
  "$GLTFPACK" -i "$OUT/five-dancer-raw.glb" -o "$OUT/five-dancer-packed.glb" > "$OUT/gltfpack.txt" 2>&1
[[ -s "$OUT/five-dancer-packed.glb" ]] || die "packed GLB was not produced"

printf '%s\n' "$SD_BIN" > "$OUT/sd-binary.txt"
if [[ -n "$SD_BIN" ]]; then
  "$SD_BIN" --help > "$OUT/sd-help.txt" 2>&1 || true
  ldd "$SD_BIN" > "$OUT/sd-ldd.txt" 2>&1 || true
fi
lscpu > "$OUT/lscpu.txt"
cat /proc/meminfo > "$OUT/meminfo.txt"
uname -a > "$OUT/uname.txt"

python3 - "$OUT" "$BIN_SHA" "$SRC_SHA" "$QUARRY_SHA" "$TOOLS_SHA" <<'PY'
import sys,json,hashlib,os,platform,pathlib
out=pathlib.Path(sys.argv[1])
blender=json.loads((out/'blender-receipt.json').read_text())
plan=json.loads((out/'five-dancer.plan.json').read_text())
state=json.loads((out/'five-dancer.state.json').read_text())
control=json.loads((out/'control-openpose.json').read_text())
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1048576),b''): h.update(b)
 return h.hexdigest()
files={p.name:{'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(out.iterdir()) if p.is_file() and p.name not in {'ACCEPTANCE_RECEIPT.json','sha256sums.txt'}}
ok={x.get('label'):x.get('status')=='ok' for x in blender.get('renders',[])}
acc={
 'danceseq_parsed':plan.get('schema')=='DANCESEQ/1',
 'state_compiled':state.get('schema')=='DANCESTATE/1' and state.get('valid') is True,
 'control_openpose_created':control.get('schema')=='DANCERS_OPENPOSE_CONTROL/1' and control.get('source_state_sha256')==sha(out/'five-dancer.state.json') and control.get('output_sha256')==sha(out/'control-openpose.png'),
 'state_consumed_by_blender':blender.get('schema')=='BLENDER_DANCESTATE_RECEIPT/1' and blender.get('source_state_sha256')==sha(out/'five-dancer.state.json'),
 'blend_created':(out/'five-dancer.blend').exists(),
 'raw_glb_created':(out/'five-dancer-raw.glb').exists(),
 'packed_glb_created':(out/'five-dancer-packed.glb').exists(),
 'workbench_ok':ok.get('workbench',False),
 'eevee_ok':ok.get('eevee',False),
 'cycles_cpu_ok':ok.get('cycles_cpu',False),
}
acc['render_matrix_complete']=all(acc[k] for k in ('workbench_ok','eevee_ok','cycles_cpu_ok'))
acc['pass_core']=all(acc[k] for k in ('danceseq_parsed','state_compiled','control_openpose_created','state_consumed_by_blender','blend_created','raw_glb_created','packed_glb_created','cycles_cpu_ok'))
receipt={
 'schema':'DANCERS_RUNTIME_ACCEPTANCE/4',
 'host':{'platform':platform.platform(),'machine':platform.machine(),'cpu_count':os.cpu_count()},
 'mailbox':{'binaries_zip_sha256':sys.argv[2],'legacy_sources_zip_sha256':sys.argv[3],'unfiltered_quarry_zip_sha256':sys.argv[4],'tools_sha256':sys.argv[5]},
 'source_policy':{'license_filtering':False,'bundle_all_selected_sources':True,'quarry_present':sys.argv[4] != 'none'},
 'semantic':{'event_count':plan['stats']['event_count'],'state_frames':len(state['frames']),'diagnostics':state['diagnostics']},
 'control_openpose':control,
 'blender':blender,
 'sd_probe':{'binary':(out/'sd-binary.txt').read_text(errors='replace').strip(),'help_captured':(out/'sd-help.txt').exists(),'model_downloaded':False},
 'artifacts':files,
 'acceptance':acc,
}
(out/'ACCEPTANCE_RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(acc,indent=2))
if not acc['pass_core']: raise SystemExit('core acceptance failed')
PY
(cd "$OUT" && sha256sum * > sha256sums.txt)
log "complete: $OUT/ACCEPTANCE_RECEIPT.json"
