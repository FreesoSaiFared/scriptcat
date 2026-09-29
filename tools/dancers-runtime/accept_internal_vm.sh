#!/usr/bin/env bash
set -Eeuo pipefail

BIN_ZIP="${BIN_ZIP:-/mnt/data/dancers-runtime-binaries.zip}"
SRC_ZIP="${SRC_ZIP:-/mnt/data/dancers-runtime-sources.zip}"
ROOT="${DANCERS_ROOT:-/mnt/data/dancers-runtime}"
INCOMING="$ROOT/incoming"
PAYLOAD="$ROOT/payload"
OUT="$ROOT/out"
mkdir -p "$INCOMING/bin" "$INCOMING/src" "$PAYLOAD" "$OUT"

log(){ printf '[dancers-runtime] %s\n' "$*" >&2; }
die(){ log "FATAL: $*"; exit 1; }
trap 'rc=$?; log "failed rc=$rc line=$LINENO"; exit $rc' ERR

[[ -f "$BIN_ZIP" ]] || die "missing $BIN_ZIP"
[[ -f "$SRC_ZIP" ]] || die "missing $SRC_ZIP"
command -v python3 >/dev/null || die "python3 is required"
command -v tar >/dev/null || die "tar is required"
command -v sha256sum >/dev/null || die "sha256sum is required"

BIN_SHA=$(sha256sum "$BIN_ZIP" | awk '{print $1}')
SRC_SHA=$(sha256sum "$SRC_ZIP" | awk '{print $1}')
STAMP="$BIN_SHA $SRC_SHA"

if [[ ! -f "$ROOT/.payload-stamp" || "$(cat "$ROOT/.payload-stamp")" != "$STAMP" ]]; then
  log "extracting staged mailbox artifacts"
  rm -rf "$INCOMING/bin" "$INCOMING/src" "$PAYLOAD"
  mkdir -p "$INCOMING/bin" "$INCOMING/src" "$PAYLOAD"
  python3 - "$BIN_ZIP" "$INCOMING/bin" "$SRC_ZIP" "$INCOMING/src" <<'PY'
import sys, zipfile
for src,dst in ((sys.argv[1],sys.argv[2]),(sys.argv[3],sys.argv[4])):
    with zipfile.ZipFile(src) as z: z.extractall(dst)
PY
  BIN_TAR=$(find "$INCOMING/bin" -type f -name 'dancers-runtime-binaries.tar.gz' -print -quit)
  SRC_TAR=$(find "$INCOMING/src" -type f -name 'dancers-runtime-sources.tar.gz' -print -quit)
  [[ -n "$BIN_TAR" && -n "$SRC_TAR" ]] || die "mailbox tar payload missing"
  for T in "$BIN_TAR" "$SRC_TAR"; do
    P=$(dirname "$T")/packages.sha256
    [[ -f "$P" ]] || die "packages.sha256 missing beside $T"
    WANT=$(grep "  $(basename "$T")$" "$P" | awk '{print $1}' | head -n1)
    [[ -n "$WANT" ]] || die "no expected hash for $(basename "$T")"
    GOT=$(sha256sum "$T" | awk '{print $1}')
    [[ "$GOT" == "$WANT" ]] || die "package hash mismatch: $(basename "$T")"
  done
  tar -xzf "$BIN_TAR" -C "$PAYLOAD"
  tar -xzf "$SRC_TAR" -C "$PAYLOAD"
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

cat > "$OUT/build_scene.py" <<'PY'
import bpy, math, json, os, time, traceback, addon_utils
from mathutils import Vector
OUT=os.environ['DANCERS_OUT']
bpy.ops.wm.read_factory_settings(use_empty=False)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
if scene.world is None: scene.world=bpy.data.worlds.new('DancersWorld')
probe={}
try: probe['cycles_enable_result']=bool(addon_utils.enable('cycles',default_set=False,persistent=False))
except Exception as e: probe['cycles_enable_error']=repr(e)
scene.frame_start=1; scene.frame_end=96
scene.render.resolution_x=512; scene.render.resolution_y=512; scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'; scene.render.film_transparent=False
scene.world.color=(0.015,0.018,0.028)
try: scene.eevee.taa_render_samples=8
except Exception as e: probe['eevee_sample_tune']=repr(e)
def mat(name,c,metal=0.0,rough=.45):
 m=bpy.data.materials.new(name); m.diffuse_color=c; m.use_nodes=True; b=m.node_tree.nodes.get('Principled BSDF')
 if b: b.inputs['Base Color'].default_value=c; b.inputs['Metallic'].default_value=metal; b.inputs['Roughness'].default_value=rough
 return m
mats=[mat('D1',(.95,.18,.40,1)),mat('D2',(.20,.70,1,1)),mat('D3',(.98,.72,.12,1)),mat('D4',(.55,.25,1,1)),mat('D5',(.18,.95,.68,1))]
skin=mat('skin',(.74,.46,.34,1),0,.6); groundmat=mat('ground',(.035,.04,.055,1),.25,.38)
def cube(name,loc,scale,ma,parent):
 bpy.ops.mesh.primitive_cube_add(location=loc); o=bpy.context.object; o.name=name; o.scale=scale; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True); o.data.materials.append(ma); o.parent=parent
def sph(name,loc,r,ma,parent):
 bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=r,location=loc); o=bpy.context.object; o.name=name; o.data.materials.append(ma); o.parent=parent
def limb(name,loc,r,d,ma,parent,rot=(0,0,0)):
 bpy.ops.mesh.primitive_cylinder_add(vertices=16,radius=r,depth=d,location=loc,rotation=rot); o=bpy.context.object; o.name=name; o.data.materials.append(ma); o.parent=parent
starts=[(-2.6,1.2,0),(-1.25,.55,0),(0,0,0),(1.25,.55,0),(2.6,1.2,0)]; roots=[]
for i,(x,y,z) in enumerate(starts,1):
 r=bpy.data.objects.new(f'D{i}_ROOT',None); scene.collection.objects.link(r); r.location=(x,y,z); roots.append(r)
 cube(f'D{i}_torso',(0,0,1.55),(.26,.17,.48),mats[i-1],r); cube(f'D{i}_pelvis',(0,0,.95),(.29,.20,.20),mats[i-1],r)
 sph(f'D{i}_head',(0,0,2.28),.23,skin,r); limb(f'D{i}_legL',(-.15,0,.48),.085,.86,mats[i-1],r); limb(f'D{i}_legR',(.15,0,.48),.085,.86,mats[i-1],r)
 limb(f'D{i}_armL',(-.45,0,1.55),.065,.75,mats[i-1],r,(0,math.radians(72),0)); limb(f'D{i}_armR',(.45,0,1.55),.065,.75,mats[i-1],r,(0,math.radians(108),0))
def key(r,f,loc,yaw=0,sz=1):
 scene.frame_set(f); r.location=loc; r.rotation_euler[2]=math.radians(yaw); r.scale[2]=sz; r.keyframe_insert('location'); r.keyframe_insert('rotation_euler'); r.keyframe_insert('scale')
for i,r in enumerate(roots):
 x,y,z=starts[i]; inward=.31 if i in (0,4) else 0; x2=x+inward*(1 if x<0 else -1 if x>0 else 0); z2=-.19 if i==2 else 0
 key(r,1,(x,y,z)); key(r,24,(x2,y,z2),0,.92 if i==2 else 1); key(r,48,(x2,y,z2),-18); key(r,72,(x2,y-.24,z2+.17),-8); key(r,96,(x,y,z))
for o in scene.objects:
 if o.animation_data and o.animation_data.action:
  for fc in o.animation_data.action.fcurves:
   for kp in fc.keyframe_points: kp.interpolation='BEZIER'
bpy.ops.mesh.primitive_plane_add(size=30,location=(0,0,-.02)); bpy.context.object.data.materials.append(groundmat)
for loc,energy,size in [((0,-2,7),1300,7),((4,3,4),750,5),((-4,2,3),900,4)]:
 bpy.ops.object.light_add(type='AREA',location=loc); bpy.context.object.data.energy=energy; bpy.context.object.data.size=size
bpy.ops.object.camera_add(location=(0,-12.8,4.9)); cam=bpy.context.object; scene.camera=cam; cam.data.lens=52; cam.rotation_euler=(Vector((0,.4,1.25))-cam.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'five-dancer.blend'))
try: enum_engines=sorted(e.identifier for e in scene.render.bl_rna.properties['engine'].enum_items)
except Exception: enum_engines=[]
def resolve(cands):
 errs={}
 for c in cands:
  try: scene.render.engine=c; return c,errs
  except Exception as e: errs[c]=repr(e)
 return None,errs
results=[]
def render(label,cands,samples=None):
 eng,errs=resolve(cands); rec={'label':label,'engine':eng,'set_errors':errs,'status':'skipped' if not eng else 'pending'}
 if not eng: results.append(rec); return
 try:
  if eng=='CYCLES': scene.cycles.device='CPU'; scene.cycles.samples=samples or 8; scene.cycles.use_denoising=False
  if eng.startswith('BLENDER_EEVEE'):
   try: scene.eevee.taa_render_samples=8
   except Exception: pass
  scene.frame_set(48); scene.render.filepath=os.path.join(OUT,label+'.png'); t=time.perf_counter(); bpy.ops.render.render(write_still=True); rec.update(status='ok',seconds=round(time.perf_counter()-t,4),path=scene.render.filepath)
 except Exception as e: rec.update(status='error',error=repr(e),traceback=traceback.format_exc()[-3000:])
 results.append(rec)
render('workbench',['BLENDER_WORKBENCH_NEXT','BLENDER_WORKBENCH']); render('eevee',['BLENDER_EEVEE_NEXT','BLENDER_EEVEE']); render('cycles_cpu',['CYCLES'],8)
scene.frame_set(1); raw=os.path.join(OUT,'five-dancer-raw.glb'); exp={'path':raw,'status':'pending'}
try:
 t=time.perf_counter(); bpy.ops.export_scene.gltf(filepath=raw,export_format='GLB',export_animations=True,export_force_sampling=True); exp.update(status='ok',seconds=round(time.perf_counter()-t,4))
except Exception as e: exp.update(status='error',error=repr(e),traceback=traceback.format_exc()[-3000:])
with open(os.path.join(OUT,'blender-receipt.json'),'w') as f: json.dump({'blender':bpy.app.version_string,'enum_engines':enum_engines,'engine_probe':probe,'renders':results,'glb_export':exp},f,indent=2)
PY

export DANCERS_OUT="$OUT"
"$BLENDER" --version > "$OUT/blender-version.txt"
if command -v xvfb-run >/dev/null 2>&1; then xvfb-run -a "$BLENDER" -b --python "$OUT/build_scene.py"; else "$BLENDER" -b --python "$OUT/build_scene.py"; fi
[[ -s "$OUT/blender-receipt.json" ]] || die "Blender script did not emit receipt"

if [[ -f "$OUT/five-dancer-raw.glb" ]]; then
  "$GLTFPACK" -i "$OUT/five-dancer-raw.glb" -o "$OUT/five-dancer-packed.glb" -cc > "$OUT/gltfpack.txt" 2>&1 || "$GLTFPACK" -i "$OUT/five-dancer-raw.glb" -o "$OUT/five-dancer-packed.glb" > "$OUT/gltfpack.txt" 2>&1
fi
printf '%s\n' "$SD_BIN" > "$OUT/sd-binary.txt"
if [[ -n "$SD_BIN" ]]; then "$SD_BIN" --help > "$OUT/sd-help.txt" 2>&1 || true; ldd "$SD_BIN" > "$OUT/sd-ldd.txt" 2>&1 || true; fi
lscpu > "$OUT/lscpu.txt"; cat /proc/meminfo > "$OUT/meminfo.txt"; uname -a > "$OUT/uname.txt"

python3 - "$OUT" "$BIN_SHA" "$SRC_SHA" <<'PY'
import sys,json,hashlib,os,platform,pathlib
out=pathlib.Path(sys.argv[1]); r=json.loads((out/'blender-receipt.json').read_text())
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1048576),b''): h.update(b)
 return h.hexdigest()
files={p.name:{'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(out.iterdir()) if p.is_file() and p.name not in {'ACCEPTANCE_RECEIPT.json','sha256sums.txt'}}
ok={x.get('label'):x.get('status')=='ok' for x in r.get('renders',[])}
r.update(schema='DANCERS_RUNTIME_ACCEPTANCE/1',host={'platform':platform.platform(),'machine':platform.machine(),'cpu_count':os.cpu_count()},mailbox={'binaries_zip_sha256':sys.argv[2],'sources_zip_sha256':sys.argv[3]},artifacts=files,sd_probe={'binary':(out/'sd-binary.txt').read_text(errors='replace').strip(),'help_captured':(out/'sd-help.txt').exists(),'model_downloaded':False})
r['acceptance']={'blend_created':(out/'five-dancer.blend').exists(),'raw_glb_created':(out/'five-dancer-raw.glb').exists(),'packed_glb_created':(out/'five-dancer-packed.glb').exists(),'workbench_ok':ok.get('workbench',False),'eevee_ok':ok.get('eevee',False),'cycles_cpu_ok':ok.get('cycles_cpu',False)}
r['acceptance']['render_matrix_complete']=all(r['acceptance'][k] for k in ('workbench_ok','eevee_ok','cycles_cpu_ok'))
r['acceptance']['pass_core']=all(r['acceptance'][k] for k in ('blend_created','raw_glb_created','packed_glb_created','cycles_cpu_ok'))
(out/'ACCEPTANCE_RECEIPT.json').write_text(json.dumps(r,indent=2))
print(json.dumps(r['acceptance'],indent=2))
PY
(cd "$OUT" && sha256sum * > sha256sums.txt)
log "complete: $OUT/ACCEPTANCE_RECEIPT.json"
