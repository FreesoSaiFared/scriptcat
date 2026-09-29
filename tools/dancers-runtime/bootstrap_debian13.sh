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

mkdir -p "$ROOT/bootstrap" "$ROOT/tools" "$ROOT/biomechanics" "$ROOT/receipts" "$MODEL_ROOT"

extract_zip(){
  local src="$1" dst="$2"
  mkdir -p "$dst"
  python3 - "$src" "$dst" <<'PY'
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    z.extractall(sys.argv[2])
PY
}

log "1/8 unpacking canonical tools mailbox"
rm -rf "$ROOT/bootstrap/tools-outer" "$ROOT/bootstrap/tools-inner"
mkdir -p "$ROOT/bootstrap/tools-outer" "$ROOT/bootstrap/tools-inner"
extract_zip "$TOOLS_ZIP" "$ROOT/bootstrap/tools-outer"
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

log "2/8 reconstructing expanded source quarry from transport chunks when present"
SOURCE_TRANSPORT=none
SOURCE_CHUNK_ZIPS=()
while IFS= read -r -d '' f; do SOURCE_CHUNK_ZIPS+=("$f"); done < <(find "$DATA_ROOT" -maxdepth 1 -type f -name 'dancers-source-quarry-[0-9][0-9].zip' -print0 | sort -z)
SOURCE_MANIFEST_ZIP="$DATA_ROOT/dancers-source-quarry-manifest.zip"
if (( ${#SOURCE_CHUNK_ZIPS[@]} > 0 )); then
  [[ -f "$SOURCE_MANIFEST_ZIP" ]] || die "source quarry chunks are present but manifest ZIP is missing"
  QSTAGE="$ROOT/bootstrap/quarry-chunks"
  rm -rf "$QSTAGE"; mkdir -p "$QSTAGE/chunks" "$QSTAGE/manifest-outer"
  for z in "${SOURCE_CHUNK_ZIPS[@]}"; do
    tmp="$QSTAGE/outer-$(basename "$z" .zip)"; extract_zip "$z" "$tmp"
    part=$(find "$tmp" -type f -name 'quarry.part-*' -print -quit)
    [[ -n "$part" ]] || die "no quarry.part-* in $z"
    cp "$part" "$QSTAGE/chunks/$(basename "$part")"
  done
  extract_zip "$SOURCE_MANIFEST_ZIP" "$QSTAGE/manifest-outer"
  mdir=$(find "$QSTAGE/manifest-outer" -type f -name chunks.sha256 -printf '%h\n' | head -n1)
  [[ -n "$mdir" ]] || die "source quarry chunk manifest missing chunks.sha256"
  mkdir -p "$QSTAGE/manifest"; cp -a "$mdir/." "$QSTAGE/manifest/"
  (cd "$QSTAGE" && sha256sum -c manifest/chunks.sha256)
  cat "$QSTAGE"/chunks/quarry.part-* > "$QSTAGE/dancers-source-quarry.tar.gz"
  [[ -f "$QSTAGE/manifest/quarry.sha256" ]] || die "source quarry full archive hash missing"
  (cd "$QSTAGE" && sha256sum -c manifest/quarry.sha256)
  cp "$QSTAGE/manifest/quarry.sha256" "$QSTAGE/dancers-source-quarry.tar.gz.sha256"
  REASSEMBLED_QUARRY="$ROOT/bootstrap/dancers-source-quarry-reassembled.zip"
  python3 - "$QSTAGE" "$REASSEMBLED_QUARRY" <<'PY'
import sys,zipfile,pathlib
root=pathlib.Path(sys.argv[1]); out=sys.argv[2]
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_STORED) as z:
    for name in ('dancers-source-quarry.tar.gz','dancers-source-quarry.tar.gz.sha256'):
        z.write(root/name,arcname=name)
PY
  QUARRY_ZIP="$REASSEMBLED_QUARRY"
  SOURCE_TRANSPORT=chunked
elif [[ -f "$QUARRY_ZIP" ]]; then
  SOURCE_TRANSPORT=single_zip
elif [[ -f "$SRC_ZIP" ]]; then
  SOURCE_TRANSPORT=legacy_only
else
  die "no source quarry or legacy source capsule staged"
fi

log "3/8 reconstructing CPU image model stack from transport chunks when present"
MODEL_TRANSPORT=none
MODEL_MANIFEST_ZIP="$DATA_ROOT/dancers-model-manifest.zip"
BASE_ZIPS=(); CONTROL_ZIPS=(); LCM_ZIPS=()
while IFS= read -r -d '' f; do BASE_ZIPS+=("$f"); done < <(find "$DATA_ROOT" -maxdepth 1 -type f -name 'dancers-model-base-[0-9][0-9].zip' -print0 | sort -z)
while IFS= read -r -d '' f; do CONTROL_ZIPS+=("$f"); done < <(find "$DATA_ROOT" -maxdepth 1 -type f -name 'dancers-model-control-[0-9][0-9].zip' -print0 | sort -z)
while IFS= read -r -d '' f; do LCM_ZIPS+=("$f"); done < <(find "$DATA_ROOT" -maxdepth 1 -type f -name 'dancers-model-lcm-[0-9][0-9].zip' -print0 | sort -z)
if (( ${#BASE_ZIPS[@]} + ${#CONTROL_ZIPS[@]} + ${#LCM_ZIPS[@]} > 0 )); then
  [[ -f "$MODEL_MANIFEST_ZIP" ]] || die "model chunks are present but dancers-model-manifest.zip is missing"
  MSTAGE="$ROOT/bootstrap/model-chunks"
  rm -rf "$MSTAGE"; mkdir -p "$MSTAGE/chunks" "$MSTAGE/manifest-outer"
  for z in "${BASE_ZIPS[@]}" "${CONTROL_ZIPS[@]}" "${LCM_ZIPS[@]}"; do
    [[ -f "$z" ]] || continue
    tmp="$MSTAGE/outer-$(basename "$z" .zip)"; extract_zip "$z" "$tmp"
    part=$(find "$tmp" -type f \( -name 'base.part-*' -o -name 'control.part-*' -o -name 'lcm.part-*' \) -print -quit)
    [[ -n "$part" ]] || die "model part missing in $z"
    cp "$part" "$MSTAGE/chunks/$(basename "$part")"
  done
  extract_zip "$MODEL_MANIFEST_ZIP" "$MSTAGE/manifest-outer"
  mdir=$(find "$MSTAGE/manifest-outer" -type f -name chunks.sha256 -printf '%h\n' | head -n1)
  [[ -n "$mdir" ]] || die "model chunk manifest missing chunks.sha256"
  mkdir -p "$MSTAGE/manifest"; cp -a "$mdir/." "$MSTAGE/manifest/"
  (cd "$MSTAGE" && sha256sum -c manifest/chunks.sha256)
  cat "$MSTAGE"/chunks/base.part-* > "$MODEL_ROOT/v1-5-pruned-emaonly.q4_0.gguf"
  cat "$MSTAGE"/chunks/control.part-* > "$MODEL_ROOT/control_v11p_sd15_openpose.safetensors"
  cat "$MSTAGE"/chunks/lcm.part-* > "$MODEL_ROOT/lcm-lora-sdv1-5.safetensors"
  python3 - "$MSTAGE/manifest/models.sha256" "$MODEL_ROOT" <<'PY'
import sys,pathlib,hashlib
mf=pathlib.Path(sys.argv[1]); root=pathlib.Path(sys.argv[2])
for line in mf.read_text().splitlines():
    if not line.strip(): continue
    want,name=line.split(None,1); name=pathlib.Path(name.strip()).name; p=root/name
    if not p.is_file(): raise SystemExit(f'missing reconstructed model {p}')
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    if h.hexdigest()!=want: raise SystemExit(f'hash mismatch for {p}')
    print(f'{name}: OK')
PY
  MODEL_TRANSPORT=chunked
fi

log "4/8 running canonical DANCESEQ/Blender/runtime acceptance in one child script"
BIN_ZIP="$BIN_ZIP" SRC_ZIP="$SRC_ZIP" QUARRY_ZIP="$QUARRY_ZIP" \
DANCERS_ROOT="$ROOT" DANCERS_TOOLS_DIR="$ROOT/tools" \
  "$ROOT/tools/accept_internal_vm.sh"
cp "$ROOT/out/ACCEPTANCE_RECEIPT.json" "$ROOT/receipts/runtime-acceptance.json"

log "5/8 installing relocatable OpenSim/SMPL-X/VPoser sidecar when staged"
SIDE_STATUS=absent
if [[ -f "$SIDECAR_ZIP" ]]; then
  rm -rf "$ROOT/bootstrap/sidecar-outer" "$ROOT/biomechanics"
  mkdir -p "$ROOT/bootstrap/sidecar-outer" "$ROOT/biomechanics"
  extract_zip "$SIDECAR_ZIP" "$ROOT/bootstrap/sidecar-outer"
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

log "6/8 registering CPU image models and stable-diffusion.cpp"
BASE=$(find "$MODEL_ROOT" -maxdepth 2 -type f \( -name '*q4_0*.gguf' -o -name '*q4*.gguf' \) -print -quit 2>/dev/null || true)
CONTROL=$(find "$MODEL_ROOT" -maxdepth 2 -type f -name '*openpose*.safetensors' -print -quit 2>/dev/null || true)
LCM=$(find "$MODEL_ROOT" -maxdepth 2 -type f -iname '*lcm*lora*.safetensors' -print -quit 2>/dev/null || true)
SD_BIN=$(find "$ROOT/payload/runtime" -type f -perm -111 -name sd-cli -print -quit 2>/dev/null || true)
MODELS_READY=false
[[ -n "$BASE" && -n "$CONTROL" && -n "$LCM" ]] && MODELS_READY=true

log "7/8 writing one machine-readable installation receipt"
python3 - "$ROOT" "$BIN_ZIP" "$SRC_ZIP" "$QUARRY_ZIP" "$TOOLS_ZIP" "$SIDECAR_ZIP" "$SIDE_STATUS" "$BASE" "$CONTROL" "$LCM" "$SD_BIN" "$SOURCE_TRANSPORT" "$MODEL_TRANSPORT" "$MODELS_READY" <<'PY'
import json,sys,hashlib,pathlib,platform,os
root=pathlib.Path(sys.argv[1])
def fmeta(s):
    if not s: return None
    p=pathlib.Path(s)
    if not p.is_file(): return None
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return {'path':str(p),'bytes':p.stat().st_size,'sha256':h.hexdigest()}
runtime=json.load(open(root/'receipts/runtime-acceptance.json'))
rec={
 'schema':'DANCERS_DEBIAN13_INSTALL/2',
 'root':str(root),
 'host':{'platform':platform.platform(),'machine':platform.machine(),'cpu_count':os.cpu_count()},
 'transport':{'source':sys.argv[12],'models':sys.argv[13]},
 'payloads':{
   'binaries':fmeta(sys.argv[2]),'legacy_sources':fmeta(sys.argv[3]),
   'source_quarry':fmeta(sys.argv[4]),'tools':fmeta(sys.argv[5]),'biomechanics_sidecar':fmeta(sys.argv[6])},
 'runtime_acceptance':runtime.get('acceptance',{}),
 'biomechanics':{'status':sys.argv[7]},
 'cpu_image':{
   'runtime':fmeta(sys.argv[11]),
   'models_ready':sys.argv[14].lower()=='true',
   'base':fmeta(sys.argv[8]),'controlnet_openpose':fmeta(sys.argv[9]),'lcm_lora':fmeta(sys.argv[10]),
   'recommended':{'sampler':'lcm','steps':4,'cfg':1,'backend':'cpu'}},
}
rec['ready_core'] = bool(runtime.get('acceptance',{}).get('pass_core')) and sys.argv[7] in ('ok','absent')
rec['ready_full'] = rec['ready_core'] and rec['cpu_image']['models_ready'] and rec['cpu_image']['runtime'] is not None
(root/'receipts/INSTALL_RECEIPT.json').write_text(json.dumps(rec,indent=2)+'\n')
print(json.dumps(rec,indent=2))
PY

log "8/8 complete"
cat "$ROOT/receipts/INSTALL_RECEIPT.json"
