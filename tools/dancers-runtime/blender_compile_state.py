#!/usr/bin/env python3
"""Blender-side adapter: DANCESTATE/1 -> animated scene, renders, GLB, receipt.

Run with Blender, e.g.:
  blender -b --python blender_compile_state.py -- --state plan.json --out out
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import traceback

import addon_utils
import bpy
from mathutils import Vector


def args_from_blender() -> argparse.Namespace:
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--preview-frame", type=int, default=48)
    return ap.parse_args(argv)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def main() -> int:
    ns = args_from_blender()
    out = ns.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    state_path = ns.state.resolve()
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if state.get("schema") != "DANCESTATE/1":
        raise RuntimeError("expected DANCESTATE/1")
    if not state.get("valid", False):
        raise RuntimeError("refusing invalid DANCESTATE plan")
    frames = state.get("frames") or []
    if not frames:
        raise RuntimeError("DANCESTATE has no frames")

    bpy.ops.wm.read_factory_settings(use_empty=False)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new("DancersWorld")

    engine_probe = {}
    try:
        engine_probe["cycles_enable_result"] = bool(addon_utils.enable("cycles", default_set=False, persistent=False))
    except Exception as e:
        engine_probe["cycles_enable_error"] = repr(e)

    meta = state["meta"]
    scene.frame_start = 1
    scene.frame_end = int(meta["duration_frames"])
    scene.render.fps = int(meta["fps"])
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world.color = (0.015, 0.018, 0.028)
    try:
        scene.eevee.taa_render_samples = 8
    except Exception as e:
        engine_probe["eevee_sample_tune"] = repr(e)

    def material(name, rgba, metallic=0.0, rough=0.45):
        m = bpy.data.materials.new(name)
        m.diffuse_color = rgba
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = rgba
            bsdf.inputs["Metallic"].default_value = metallic
            bsdf.inputs["Roughness"].default_value = rough
        return m

    palette = [
        (0.95, 0.18, 0.40, 1), (0.20, 0.70, 1.00, 1),
        (0.98, 0.72, 0.12, 1), (0.55, 0.25, 1.00, 1),
        (0.18, 0.95, 0.68, 1), (1.00, 0.38, 0.82, 1),
        (0.30, 0.92, 0.95, 1), (0.96, 0.52, 0.16, 1),
    ]
    dancer_mats = [material(f"D{i+1}", palette[i % len(palette)]) for i in range(int(state["actor_count"]))]
    skin = material("skin", (0.74, 0.46, 0.34, 1), 0.0, 0.6)
    ground_mat = material("ground", (0.035, 0.04, 0.055, 1), 0.25, 0.38)

    def cube(name, loc, scale, mat, parent):
        bpy.ops.mesh.primitive_cube_add(location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.data.materials.append(mat)
        obj.parent = parent
        return obj

    def sphere(name, loc, radius, mat, parent):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=radius, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.data.materials.append(mat)
        obj.parent = parent
        return obj

    def limb(name, loc, radius, depth, mat, parent, rot=(0, 0, 0)):
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=radius, depth=depth, location=loc, rotation=rot)
        obj = bpy.context.object
        obj.name = name
        obj.data.materials.append(mat)
        obj.parent = parent
        return obj

    roots = {}
    pelvises = {}
    torsos = {}
    actor_names = list(frames[0]["actors"])
    for i, name in enumerate(actor_names):
        st = frames[0]["actors"][name]
        root = bpy.data.objects.new(f"{name}_ROOT", None)
        scene.collection.objects.link(root)
        root.location = st["root_m"]
        roots[name] = root
        torso = cube(f"{name}_torso", (0, 0, 1.55), (0.26, 0.17, 0.48), dancer_mats[i], root)
        pelvis = cube(f"{name}_pelvis", (0, 0, 0.95), (0.29, 0.20, 0.20), dancer_mats[i], root)
        torsos[name] = torso
        pelvises[name] = pelvis
        sphere(f"{name}_head", (0, 0, 2.28), 0.23, skin, root)
        limb(f"{name}_legL", (-0.15, 0, 0.48), 0.085, 0.86, dancer_mats[i], root)
        limb(f"{name}_legR", (0.15, 0, 0.48), 0.085, 0.86, dancer_mats[i], root)
        limb(f"{name}_armL", (-0.45, 0, 1.55), 0.065, 0.75, dancer_mats[i], root, (0, math.radians(72), 0))
        limb(f"{name}_armR", (0.45, 0, 1.55), 0.065, 0.75, dancer_mats[i], root, (0, math.radians(108), 0))

    for snap in frames:
        frame = int(snap["frame"])
        scene.frame_set(frame)
        for name, st in snap["actors"].items():
            root = roots[name]
            pelvis = pelvises[name]
            torso = torsos[name]
            yaw = float(st["pelvis_yaw_deg"])
            root.location = st["root_m"]
            root.rotation_euler[2] = math.radians(yaw)
            root["pose_preset"] = st.get("pose", "neutral")
            root.keyframe_insert("location")
            root.keyframe_insert("rotation_euler")
            p = st.get("pelvis_local_m", [0, 0, 0])
            pelvis.location = (p[0], p[1], 0.95 + p[2])
            pelvis.keyframe_insert("location")
            if st.get("constraints", {}).get("chest.look") == "camera":
                torso.rotation_euler[2] = math.radians(-yaw)
            else:
                torso.rotation_euler[2] = 0.0
            torso.keyframe_insert("rotation_euler")

    for obj in scene.objects:
        if obj.animation_data and obj.animation_data.action:
            for fc in obj.animation_data.action.fcurves:
                for kp in fc.keyframe_points:
                    kp.interpolation = "BEZIER"

    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -0.02))
    ground = bpy.context.object
    ground.name = "GROUND"
    ground.data.materials.append(ground_mat)

    for loc, energy, size in [((0, -2, 7), 1300, 7), ((4, 3, 4), 750, 5), ((-4, 2, 3), 900, 4)]:
        bpy.ops.object.light_add(type="AREA", location=loc)
        light = bpy.context.object
        light.data.energy = energy
        light.data.size = size

    bpy.ops.object.camera_add(location=(0, -12.8, 4.9))
    cam = bpy.context.object
    scene.camera = cam
    cam.data.lens = 52
    target = Vector((0, 0.4, 1.25))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()

    blend_path = out / "five-dancer.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    try:
        enum_engines = sorted(e.identifier for e in scene.render.bl_rna.properties["engine"].enum_items)
    except Exception:
        enum_engines = []

    def resolve_engine(candidates):
        errors = {}
        for candidate in candidates:
            try:
                scene.render.engine = candidate
                return candidate, errors
            except Exception as e:
                errors[candidate] = repr(e)
        return None, errors

    render_results = []
    preview_frame = max(scene.frame_start, min(scene.frame_end, int(ns.preview_frame)))

    def render_case(label, candidates, samples=None):
        engine, set_errors = resolve_engine(candidates)
        rec = {"label": label, "engine": engine, "set_errors": set_errors, "status": "skipped" if not engine else "pending"}
        if not engine:
            render_results.append(rec)
            return
        try:
            if engine == "CYCLES":
                scene.cycles.device = "CPU"
                scene.cycles.samples = samples or 8
                scene.cycles.use_denoising = False
            if engine.startswith("BLENDER_EEVEE"):
                try:
                    scene.eevee.taa_render_samples = 8
                except Exception:
                    pass
            scene.frame_set(preview_frame)
            path = out / f"{label}.png"
            scene.render.filepath = str(path)
            t = time.perf_counter()
            bpy.ops.render.render(write_still=True)
            rec.update(status="ok", seconds=round(time.perf_counter() - t, 4), path=str(path))
        except Exception as e:
            rec.update(status="error", error=repr(e), traceback=traceback.format_exc()[-3000:])
        render_results.append(rec)

    render_case("workbench", ["BLENDER_WORKBENCH_NEXT", "BLENDER_WORKBENCH"])
    render_case("eevee", ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"])
    render_case("cycles_cpu", ["CYCLES"], 8)

    scene.frame_set(scene.frame_start)
    raw_glb = out / "five-dancer-raw.glb"
    export_rec = {"status": "pending", "path": str(raw_glb)}
    try:
        t = time.perf_counter()
        bpy.ops.export_scene.gltf(filepath=str(raw_glb), export_format="GLB", export_animations=True, export_force_sampling=True)
        export_rec.update(status="ok", seconds=round(time.perf_counter() - t, 4))
    except Exception as e:
        export_rec.update(status="error", error=repr(e), traceback=traceback.format_exc()[-3000:])

    receipt = {
        "schema": "BLENDER_DANCESTATE_RECEIPT/1",
        "blender": bpy.app.version_string,
        "source_state": str(state_path),
        "source_state_sha256": sha256(state_path),
        "state_valid": bool(state.get("valid")),
        "state_diagnostics": state.get("diagnostics", []),
        "actor_count": int(state["actor_count"]),
        "state_frames": len(frames),
        "enum_engines": enum_engines,
        "engine_probe": engine_probe,
        "preview_frame": preview_frame,
        "renders": render_results,
        "glb_export": export_rec,
    }
    (out / "blender-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
