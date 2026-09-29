#!/usr/bin/env bash
set -Eeuo pipefail

DATA_ROOT="${DANCERS_DATA_ROOT:-/mnt/data}"
ROOT="${DANCERS_ROOT:-$DATA_ROOT/dancers-runtime}"
TOOLS_ZIP="${TOOLS_ZIP:-$DATA_ROOT/dancers-runtime-tools.zip}"
BIN_ZIP="${BIN_ZIP:-$DATA_ROOT/dancers-runtime-binaries.zip}"
SRC_ZIP="${SRC_ZIP:-$DATA_ROOT/dancers-runtime-sources.zip}"
QUARRY_ZIP="${QUARRY_ZIP:-$DATA_ROOT/dancers-source-quarry.zip}"
SIDECAR_ZIP="${SIDECAR_ZIP:-$DATA_ROOT/dancers-biomechanics-sidecar.zip}"
MODEL_ROOT="${MODEL_ROOT:-$DATA_ROOT/dancers-models}"

log(){ printf '[dancers-bootstrap] %s\n' "$*" >&2; }
die(){ log "FATAL: $*"; exit 1; }
trap 'rc=$?; log "failed rc=$rc line=$LINENO"; exit $rc' ERR

for cmd in python3 tar sha256sum; do command -v "$cmd" >/dev/null || die "$cmd is required"; done
for f in "$TOOLS_ZIP" "$BIN_ZIP"; do [[ -f "$f" ]] || die "missing $f"; done
[[ -f "$QUARRY_ZIP" || -f "$SRC_ZIP" ]] || die "missing both source quarry and legacy source capsule"

mkdir -p "$ROOT/bootstrap" "$ROOT/tools" "$ROOT/biomechanics" "$ROOT/models" "$ROOT/receipts"

log "1/6 unpacking canonical tools mailbox"
rm -rf "$ROOT/bootstrap/tools-outer" "$ROOT/bootstrap/tools-inner"
mkdir -p "$ROOT/bootstrap/tools-outer" "$ROOT/bootstrap/tools-inner"
python3 - "$TOOLS_ZIP" "$ROOT/bootstrap/tools-outer" <<'PY'
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: z.extractall(sys.argv[2])
PY
TOOLS_TAR=$(find "$ROOT/bootstrap/tools-outer" -type f -name 'dancers-runtime-tools.tar.gz' -print -quit)
TOOLS_SUM=$(find "$ROOT/bootstrap/tools-outer" -type f -name 'dancers-runtime-tools.tar.gz.sha256' -print -quit)
[[ -n "$TOOLS_TAR" && -n "$TOOLS_SUM" ]] || die "tools artifact is missing tar/checksum"
(cd "$(dirname "$TOOLS_TAR")" && sha256sum -c "$(basename "$TOOLS_SUM")")
tar -xzf "$TOOLS_TAR" -C "$ROOT/bootstrap/tools-inner"
[[ -f "$ROOT/bootstrap/tools-inner/SHA256SUMS" ]] || die "tools SHA256SUMS missing"
(cd "$ROOT/bootstrap/tools-inner" && sha256sum -c SHA256SUMS)
rm -rf "$ROOT/tools"
mkdir -p "$ROOT/tools"
cp -a "$ROOT/bootstrap/tools-inner/dancers-runtime/." "$ROOT/tools/"
chmod +x "$ROOT/tools/accept_internal_vm.sh" "$ROOT/tools/bootstrap_debian13.sh" 2>/dev/null || true

log "2/6 running canonical runtime/source acceptance in one child script"
BIN_ZIP="$BIN_ZIP" SRC_ZIP="$SRC_ZIP" QUARRY_ZIP="$QUARRY_ZIP" \
DANCERS_ROOT="$ROOT" DANCERS_TOOLS_DIR="$ROOT/tools" \
  "$ROOT/tools/accept_internal_vm.sh"
cp "$ROOT/out/ACCEPTANCE_RECEIPT.json" "$ROOT/receipts/runtime-acceptance.json"

log "3/6 installing relocatable OpenSim/SMPL-X/VPoser sidecar when staged"
SIDE_STATUS=absent
if [[ -f "$SIDECAR_ZIP" ]]; then
  rm -rf "$ROOT/bootstrap/sidecar-outer" "$ROOT/biomechanics"
  mkdir -p "$ROOT/bootstrap/sidecar-outer" "$ROOT/biomechanics"
  python3 - "$SIDECAR_ZIP" "$ROOT/bootstrap/sidecar-outer" <<'PY'
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: z.extractall(sys.argv[2])
PY
  SIDE_TAR=$(find "$ROOT/bootstrap/sidecar-outer" -type f -name 'dancers-biomechanics-py311.tar.gz' -print -quit)
  SIDE_RECEIPT=$(find "$ROOT/bootstrap/sidecar-outer" -type f -name 'SIDECAR_ACCEPTANCE_RECEIPT.json' -print -quit)
  [[ -n "$SIDE_TAR" ]] || die "sidecar archive missing inside $SIDECAR_ZIP"
  if [[ -n "$SIDE_RECEIPT" ]]; then
    WANT=$(python3 - "$SIDE_RECEIPT" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['archive']['sha256'])
PY
)
    GOT=$(sha256sum "$SIDE_TAR" | awk '{print $1}')
    [[ "$WANT" == "$GOT" ]] || die "sidecar inner archive hash mismatch"
    cp "$SIDE_RECEIPT" "$ROOT/receipts/sidecar-build-receipt.json"
  fi
  tar -xzf "$SIDE_TAR" -C "$ROOT/biomechanics"
  [[ -x "$ROOT/biomechanics/bin/python" ]] || die "sidecar Python missing after extraction"
  [[ -x "$ROOT/biomechanics/bin/conda-unpack" ]] && "$ROOT/biomechanics/bin/conda-unpack"
  "$ROOT/biomechanics/bin/python" - <<'PY' > "$ROOT/receipts/sidecar-runtime-probe.json"
import json,opensim,torch,smplx,human_body_prior
print(json.dumps({
  'schema':'DANCERS_SIDECAR_RUNTIME_PROBE/1',
  'opensim':opensim.GetVersion(),
  'torch':torch.__version__,
  'torch_cuda_available':torch.cuda.is_available(),
  'smplx_import':True,
  'human_body_prior_import':True
},indent=2))
PY
  SIDE_STATUS=ok
fi

log "4/6 discovering optionally staged CPU image models"
# Model weights are intentionally external large payloads. If already staged under MODEL_ROOT,
# register them without downloading anything from the air-gapped VM.
BASE=$(find "$MODEL_ROOT" -maxdepth 2 -type f \( -name '*q4_0*.gguf' -o -name '*q4*.gguf' \) -print -quit 2>/dev/null || true)
CONTROL=$(find "$MODEL_ROOT" -maxdepth 2 -type f -name '*openpose*.safetensors' -print -quit 2>/dev/null || true)
LCM=$(find "$MODEL_ROOT" -maxdepth 2 -type f -iname '*lcm*lora*.safetensors' -print -quit 2>/dev/null || true)

log "5/6 writing machine-readable installation receipt"
python3 - "$ROOT" "$BIN_ZIP" "$SRC_ZIP" "$QUARRY_ZIP" "$TOOLS_ZIP" "$SIDECAR_ZIP" "$SIDE_STATUS" "$BASE" "$CONTROL" "$LCM" <<'PY'
import json,sys,hashlib,pathlib,platform,os
root=pathlib.Path(sys.argv[1])
def fmeta(s):
 p=pathlib.Path(s)
 if not s or not p.is_file(): return None
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return {'path':str(p),'bytes':p.stat().st_size,'sha256':h.hexdigest()}
runtime=json.load(open(root/'receipts/runtime-acceptance.json'))
rec={
 'schema':'DANCERS_DEBIAN13_INSTALL/1',
 'root':str(root),
 'host':{'platform':platform.platform(),'machine':platform.machine(),'cpu_count':os.cpu_count()},
 'payloads':{
   'binaries':fmeta(sys.argv[2]),'legacy_sources':fmeta(sys.argv[3]),
   'source_quarry':fmeta(sys.argv[4]),'tools':fmeta(sys.argv[5]),'biomechanics_sidecar':fmeta(sys.argv[6])},
 'runtime_acceptance':runtime.get('acceptance',{}),
 'biomechanics':{'status':sys.argv[7]},
 'cpu_image_models':{'base':fmeta(sys.argv[8]),'controlnet_openpose':fmeta(sys.argv[9]),'lcm_lora':fmeta(sys.argv[10])},
}
rec['ready'] = bool(runtime.get('acceptance',{}).get('pass_core')) and sys.argv[7] in ('ok','absent')
(root/'receipts/INSTALL_RECEIPT.json').write_text(json.dumps(rec,indent=2)+'\n')
print(json.dumps(rec,indent=2))
PY

log "6/6 complete"
cat "$ROOT/receipts/INSTALL_RECEIPT.json"
