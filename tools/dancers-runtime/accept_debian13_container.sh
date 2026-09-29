#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${DANCERS_DEBIAN13_ROOT:-/work}"
EVIDENCE="${DANCERS_DEBIAN13_EVIDENCE:-$ROOT/debian13-evidence}"
RUNTIME="$ROOT/runtime-debian13"
OUT="$ROOT/out-debian13"
TOOLS="$ROOT/tools/dancers-runtime"
mkdir -p "$EVIDENCE" "$RUNTIME" "$OUT"
exec > >(tee "$EVIDENCE/accept.log") 2>&1

log(){ printf '[dancers-debian13] %s\n' "$*" >&2; }
die(){ log "FATAL: $*"; exit 1; }
trap 'rc=$?; log "failed rc=$rc line=$LINENO"; exit $rc' ERR

log "host inventory"
cat /etc/os-release | tee "$EVIDENCE/os-release.txt"
uname -a | tee "$EVIDENCE/uname.txt"
lscpu | tee "$EVIDENCE/lscpu.txt"
free -h | tee "$EVIDENCE/free.txt"
grep -q '^VERSION_ID="13"' /etc/os-release || die "not Debian 13"

log "installing minimal runtime libraries"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl xz-utils unzip python3 \
  xvfb xauth libgl1 libegl1 libx11-6 libxi6 libxrender1 libxfixes3 \
  libxxf86vm1 libxkbcommon0 libsm6 libice6 libfontconfig1 libfreetype6 \
  libdbus-1-3 libwayland-client0 libwayland-egl1 libtbb12 libzstd1 libgomp1 \
  > "$EVIDENCE/apt.txt"
rm -rf /var/lib/apt/lists/*

log "acquiring pinned portable Blender 4.5.14, sd.cpp and gltfpack"
BLENDER_VER=4.5.14
BLENDER_FILE="blender-${BLENDER_VER}-linux-x64.tar.xz"
curl -fL --retry 5 --retry-delay 2 -o "$RUNTIME/$BLENDER_FILE" \
  "https://download.blender.org/release/Blender4.5/${BLENDER_FILE}"
curl -fL --retry 5 --retry-delay 2 -o "$RUNTIME/blender.sha256" \
  "https://download.blender.org/release/Blender4.5/blender-${BLENDER_VER}.sha256"
grep "$BLENDER_FILE" "$RUNTIME/blender.sha256" | (cd "$RUNTIME" && sha256sum -c -)
tar -C "$RUNTIME" -xf "$RUNTIME/$BLENDER_FILE"
BLENDER=$(find "$RUNTIME" -maxdepth 3 -type f -name blender -perm -111 -print -quit)
[[ -n "$BLENDER" ]] || die "Blender executable missing"
"$BLENDER" --version | tee "$EVIDENCE/blender-version.txt"
ldd "$BLENDER" | tee "$EVIDENCE/blender-ldd.txt"
! grep -q 'not found' "$EVIDENCE/blender-ldd.txt" || die "Blender has missing shared libraries"

SD_TAG=master-929-3f8527a
SD_FILE=sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64.zip
curl -fL --retry 5 --retry-delay 2 -o "$RUNTIME/sd.zip" \
  "https://github.com/leejet/stable-diffusion.cpp/releases/download/${SD_TAG}/${SD_FILE}"
echo "9ad35ed309dbe59f5e66f35edafac9a69e6cc233ea6b9577071feae829159d37  $RUNTIME/sd.zip" | sha256sum -c -
unzip -q "$RUNTIME/sd.zip" -d "$RUNTIME/sd"
SD_BIN=$(find "$RUNTIME/sd" -type f -perm -111 -name sd-cli -print -quit)
[[ -n "$SD_BIN" ]] || die "sd-cli missing"
ldd "$SD_BIN" | tee "$EVIDENCE/sd-ldd.txt"
! grep -q 'not found' "$EVIDENCE/sd-ldd.txt" || die "sd-cli has missing shared libraries"
"$SD_BIN" --help > "$EVIDENCE/sd-help.txt" 2>&1

gltfpack_zip="$RUNTIME/gltfpack.zip"
curl -fL --retry 5 --retry-delay 2 -o "$gltfpack_zip" \
  'https://github.com/zeux/meshoptimizer/releases/download/v1.3/gltfpack-ubuntu.zip'
echo "0666d9dc40d60fe5b9a45f3fc24f8e6ca87112974bd5de9ca57152aa13d06017  $gltfpack_zip" | sha256sum -c -
unzip -q "$gltfpack_zip" -d "$RUNTIME/gltfpack"
GLTFPACK=$(find "$RUNTIME/gltfpack" -type f -name gltfpack -print -quit)
chmod +x "$GLTFPACK"

log "compiling deterministic five-dancer choreography"
cat > "$OUT/debian13.danceseq" <<'EOF'
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
python3 "$TOOLS/danceseq.py" "$OUT/debian13.danceseq" -o "$OUT/debian13.plan.json"
python3 "$TOOLS/compile_plan.py" "$OUT/debian13.danceseq" -o "$OUT/debian13.state.json"
python3 "$TOOLS/state_to_openpose.py" "$OUT/debian13.state.json" \
  -o "$OUT/control-openpose.png" --frame 48 --receipt "$OUT/control-openpose.json"
[[ -s "$OUT/control-openpose.png" ]] || die "OpenPose control image missing"

log "executing Blender render/export matrix"
xvfb-run -a "$BLENDER" -b --python "$TOOLS/blender_compile_state.py" -- \
  --state "$OUT/debian13.state.json" --out "$OUT" --preview-frame 48
for f in blender-receipt.json five-dancer.blend five-dancer-raw.glb workbench.png eevee.png cycles_cpu.png; do
  [[ -s "$OUT/$f" ]] || die "missing Blender output $f"
done
"$GLTFPACK" -i "$OUT/five-dancer-raw.glb" -o "$OUT/five-dancer-packed.glb" -cc > "$EVIDENCE/gltfpack.txt" 2>&1 || \
  "$GLTFPACK" -i "$OUT/five-dancer-raw.glb" -o "$OUT/five-dancer-packed.glb" > "$EVIDENCE/gltfpack.txt" 2>&1
[[ -s "$OUT/five-dancer-packed.glb" ]] || die "packed GLB missing"

log "building strict Debian 13 acceptance receipt"
python3 - "$OUT" "$EVIDENCE" <<'PY'
import json,hashlib,pathlib,platform,os,sys
out=pathlib.Path(sys.argv[1]); ev=pathlib.Path(sys.argv[2])
b=json.load(open(out/'blender-receipt.json'))
c=json.load(open(out/'control-openpose.json'))
state=json.load(open(out/'debian13.state.json'))
def meta(p):
    p=pathlib.Path(p); h=hashlib.sha256()
    with p.open('rb') as f:
        for x in iter(lambda:f.read(1048576),b''): h.update(x)
    return {'path':str(p),'bytes':p.stat().st_size,'sha256':h.hexdigest()}
renders={r['label']:r for r in b['renders']}
required=('workbench','eevee','cycles_cpu')
rec={
  'schema':'DANCERS_DEBIAN13_ACCEPTANCE/2',
  'debian':'13',
  'platform':platform.platform(),
  'machine':platform.machine(),
  'cpu_count':os.cpu_count(),
  'state_valid':state.get('valid') is True,
  'actor_count':state.get('actor_count'),
  'blender':b['blender'],
  'control_openpose':{'ok':c['actor_count']==5 and c['source_state_sha256']==meta(out/'debian13.state.json')['sha256'],'artifact':meta(out/'control-openpose.png')},
  'renders':{k:{'status':renders[k]['status'],'seconds':renders[k].get('seconds'),'engine':renders[k].get('engine'),'artifact':meta(out/f'{k}.png')} for k in required},
  'blend':meta(out/'five-dancer.blend'),
  'raw_glb':meta(out/'five-dancer-raw.glb'),
  'packed_glb':meta(out/'five-dancer-packed.glb'),
  'sd_cli':{'probe_ok':True,'ldd_clean':'not found' not in (ev/'sd-ldd.txt').read_text(errors='replace')},
}
rec['pass_core']=rec['state_valid'] and rec['actor_count']==5 and rec['control_openpose']['ok'] and rec['sd_cli']['ldd_clean'] and all(rec['renders'][k]['status']=='ok' for k in required)
(ev/'DEBIAN13_ACCEPTANCE.json').write_text(json.dumps(rec,indent=2)+'\n')
print(json.dumps(rec,indent=2))
if not rec['pass_core']: raise SystemExit(21)
PY

cp "$OUT/control-openpose.png" "$OUT/workbench.png" "$OUT/eevee.png" "$OUT/cycles_cpu.png" \
   "$OUT/five-dancer-packed.glb" "$EVIDENCE/"
(cd "$EVIDENCE" && sha256sum * > SHA256SUMS)
log "PASS: $EVIDENCE/DEBIAN13_ACCEPTANCE.json"
