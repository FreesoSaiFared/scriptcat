#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${DANCERS_ROOT:-/mnt/data/dancers-runtime}"
MODEL_ROOT="${MODEL_ROOT:-/mnt/data/dancers-models}"
OUT="${DANCERS_IMAGE_OUT:-$ROOT/image-out}"
CONTROL_IMAGE="${CONTROL_IMAGE:-$ROOT/out/control-openpose.png}"
PROMPT="${PROMPT:-five adult female dancers, synchronized pop choreography, full body, coordinated stage outfits, fashion performance photography, energetic movement, coherent anatomy}"
NEGATIVE="${NEGATIVE:-child, minor, extra limbs, fused bodies, malformed hands, cropped feet, text, watermark}"
SEED="${SEED:-424242}"
WIDTH="${WIDTH:-384}"
HEIGHT="${HEIGHT:-384}"
STEPS="${STEPS:-4}"
CFG="${CFG:-1}"
CONTROL_STRENGTH="${CONTROL_STRENGTH:-0.85}"
THREADS="${DANCERS_THREADS:-$(nproc)}"
mkdir -p "$OUT"

log(){ printf '[dancers-cpu-image] %s\n' "$*" >&2; }
die(){ log "FATAL: $*"; exit 1; }
trap 'rc=$?; log "failed rc=$rc line=$LINENO"; exit $rc' ERR

SD_BIN="${SD_BIN:-$(find "$ROOT/payload/runtime" -type f -perm -111 -name sd-cli -print -quit 2>/dev/null || true)}"
BASE="${BASE_MODEL:-$(find "$MODEL_ROOT" -maxdepth 2 -type f \( -name '*q4_0*.gguf' -o -name '*q4*.gguf' \) -print -quit 2>/dev/null || true)}"
CONTROL="${CONTROL_MODEL:-$(find "$MODEL_ROOT" -maxdepth 2 -type f -name '*openpose*.safetensors' -print -quit 2>/dev/null || true)}"
LCM="${LCM_LORA:-$(find "$MODEL_ROOT" -maxdepth 2 -type f -iname '*lcm*lora*.safetensors' -print -quit 2>/dev/null || true)}"
[[ -x "$SD_BIN" ]] || die "sd-cli not found"
[[ -f "$BASE" ]] || die "quantized SD1.5 base model not found"
[[ -f "$LCM" ]] || die "LCM-LoRA not found"

FLAGS=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null | cut -d: -f2- || true)
isa=x86-64
[[ " $FLAGS " == *' sse4_2 '* ]] && isa=x86-64-v2
[[ " $FLAGS " == *' avx2 '* ]] && isa=avx2
[[ " $FLAGS " == *' avx512f '* ]] && isa=avx512
log "cpu_profile=$isa threads=$THREADS; stable-diffusion.cpp CPU_ALL_VARIANTS dispatch remains authoritative"

LCM_DIR=$(dirname "$LCM")
LCM_NAME=$(basename "$LCM" .safetensors)
OUTPUT="$OUT/dancers-sd15.png"
TIMELOG="$OUT/time.txt"
STDOUT="$OUT/sd.stdout.txt"
CPUINFO="$OUT/cpu.txt"
{
  printf 'isa_profile=%s\nthreads=%s\n' "$isa" "$THREADS"
  lscpu 2>/dev/null || true
} > "$CPUINFO"

cmd=("$SD_BIN"
  -m "$BASE"
  -p "${PROMPT}<lora:${LCM_NAME}:1>"
  -n "$NEGATIVE"
  --lora-model-dir "$LCM_DIR"
  --steps "$STEPS"
  --cfg-scale "$CFG"
  --sampling-method lcm
  --backend cpu
  --threads "$THREADS"
  --diffusion-fa
  -W "$WIDTH" -H "$HEIGHT"
  --seed "$SEED"
  -o "$OUTPUT")
MODE=plain
if [[ -f "$CONTROL_IMAGE" && -f "$CONTROL" ]]; then
  MODE=controlnet_openpose
  cmd+=(--control-net "$CONTROL" --control-image "$CONTROL_IMAGE" --control-strength "$CONTROL_STRENGTH")
fi

log "mode=$MODE resolution=${WIDTH}x${HEIGHT} steps=$STEPS"
start=$(date +%s.%N)
set +e
/usr/bin/time -v "${cmd[@]}" > "$STDOUT" 2> "$TIMELOG"
rc=$?
set -e
end=$(date +%s.%N)

python3 - "$OUTPUT" "$TIMELOG" "$start" "$end" "$rc" "$MODE" "$isa" "$THREADS" "$BASE" "$CONTROL" "$LCM" "$CONTROL_IMAGE" "$OUT/CPU_IMAGE_RECEIPT.json" <<'PY'
import sys,json,pathlib,hashlib,re
img,timef,start,end,rc,mode,isa,threads,base,control,lcm,control_image,out=sys.argv[1:]
def meta(s):
    p=pathlib.Path(s)
    if not p.is_file(): return None
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return {'path':str(p),'bytes':p.stat().st_size,'sha256':h.hexdigest()}
t=pathlib.Path(timef).read_text(errors='replace') if pathlib.Path(timef).exists() else ''
m=re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)',t)
rec={
 'schema':'DANCERS_CPU_IMAGE_RUN/1',
 'mode':mode,'isa_profile':isa,'threads':int(threads),'exit_code':int(rc),
 'elapsed_s':round(float(end)-float(start),3),
 'max_rss_kb':int(m.group(1)) if m else None,
 'models':{'base':meta(base),'controlnet':meta(control),'lcm_lora':meta(lcm)},
 'control_image':meta(control_image),
 'output':meta(img),
}
rec['ok']=rec['exit_code']==0 and rec['output'] is not None
pathlib.Path(out).write_text(json.dumps(rec,indent=2)+'\n')
print(json.dumps(rec,indent=2))
PY

[[ $rc -eq 0 && -s "$OUTPUT" ]] || die "image generation failed; inspect $TIMELOG and $STDOUT"
log "complete: $OUTPUT"
