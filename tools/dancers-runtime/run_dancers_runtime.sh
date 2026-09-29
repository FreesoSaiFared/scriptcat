#!/usr/bin/env bash
set -Eeuo pipefail

DATA_ROOT="${DANCERS_DATA_ROOT:-/mnt/data}"
ROOT="${DANCERS_ROOT:-$DATA_ROOT/dancers-runtime}"
TOOLS_ZIP="${TOOLS_ZIP:-$DATA_ROOT/dancers-runtime-tools.zip}"
MODEL_ROOT="${MODEL_ROOT:-$DATA_ROOT/dancers-models}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_IMAGE_SMOKE="${DANCERS_RUN_IMAGE_SMOKE:-1}"

log(){ printf '[dancers-full] %s\n' "$*" >&2; }
die(){ log "FATAL: $*"; exit 1; }
trap 'rc=$?; log "failed rc=$rc line=$LINENO"; exit $rc' ERR

log "phase 1: bootstrap portable Blender, sources, biomechanics and CPU models"
DANCERS_DATA_ROOT="$DATA_ROOT" DANCERS_ROOT="$ROOT" TOOLS_ZIP="$TOOLS_ZIP" MODEL_ROOT="$MODEL_ROOT" \
  "$HERE/bootstrap_debian13.sh"

INSTALL="$ROOT/receipts/INSTALL_RECEIPT.json"
[[ -s "$INSTALL" ]] || die "bootstrap did not produce $INSTALL"
MODELS_READY=$(python3 - "$INSTALL" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
print('true' if r.get('cpu_image',{}).get('models_ready') else 'false')
PY
)
CORE_READY=$(python3 - "$INSTALL" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
print('true' if r.get('ready_core') else 'false')
PY
)
[[ "$CORE_READY" == true ]] || die "core runtime acceptance failed"

IMAGE_STATUS=skipped
if [[ "$RUN_IMAGE_SMOKE" == 1 && "$MODELS_READY" == true ]]; then
  log "phase 2: real CPU SD1.5 + LCM + OpenPose ControlNet smoke image"
  CONTROL_IMAGE="$ROOT/out/control-openpose.png" \
  DANCERS_ROOT="$ROOT" MODEL_ROOT="$MODEL_ROOT" DANCERS_IMAGE_OUT="$ROOT/image-out" \
    "$HERE/render_cpu_image.sh"
  [[ -s "$ROOT/image-out/CPU_IMAGE_RECEIPT.json" ]] || die "CPU image receipt missing"
  cp "$ROOT/image-out/CPU_IMAGE_RECEIPT.json" "$ROOT/receipts/cpu-image-smoke.json"
  IMAGE_STATUS=$(python3 - "$ROOT/receipts/cpu-image-smoke.json" <<'PY'
import json,sys
print('ok' if json.load(open(sys.argv[1])).get('ok') else 'failed')
PY
)
  [[ "$IMAGE_STATUS" == ok ]] || die "CPU image smoke test failed"
elif [[ "$RUN_IMAGE_SMOKE" == 1 ]]; then
  IMAGE_STATUS=models_missing
  log "phase 2 skipped: CPU model stack is not staged"
else
  IMAGE_STATUS=disabled
fi

log "phase 3: final full-stack receipt"
python3 - "$INSTALL" "$ROOT/receipts/cpu-image-smoke.json" "$IMAGE_STATUS" "$ROOT/receipts/FULL_ACCEPTANCE_RECEIPT.json" <<'PY'
import json,sys,pathlib
install_path=pathlib.Path(sys.argv[1]); image_path=pathlib.Path(sys.argv[2]); image_status=sys.argv[3]; out=pathlib.Path(sys.argv[4])
install=json.loads(install_path.read_text())
image=json.loads(image_path.read_text()) if image_path.is_file() else None
rec={
 'schema':'DANCERS_FULL_ACCEPTANCE/1',
 'install':install,
 'cpu_image_smoke':{'status':image_status,'receipt':image},
}
rec['pass_core']=bool(install.get('ready_core'))
rec['pass_full']=rec['pass_core'] and bool(install.get('cpu_image',{}).get('models_ready')) and image_status=='ok'
out.write_text(json.dumps(rec,indent=2)+'\n')
print(json.dumps({'pass_core':rec['pass_core'],'pass_full':rec['pass_full'],'cpu_image_smoke':image_status},indent=2))
PY

log "complete: $ROOT/receipts/FULL_ACCEPTANCE_RECEIPT.json"
