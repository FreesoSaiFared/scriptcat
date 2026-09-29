#!/usr/bin/env python3
"""Render a deterministic OpenPose-style PNG from DANCESTATE/1.

This is deliberately dependency-free so it runs in the air-gapped Debian
runtime before Blender or PyTorch are involved.  It projects the canonical
proxy dancer skeleton through the same default camera used by the Blender
adapter and produces a ControlNet-ready control image plus a receipt.
"""
from __future__ import annotations

import argparse
import binascii
import hashlib
import json
import math
from pathlib import Path
import struct
import zlib


def vadd(a, b): return tuple(x + y for x, y in zip(a, b))
def vsub(a, b): return tuple(x - y for x, y in zip(a, b))
def vmul(a, s): return tuple(x * s for x in a)
def dot(a, b): return sum(x * y for x, y in zip(a, b))
def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def norm(a):
    n = math.sqrt(dot(a, a))
    if n <= 1e-12: raise ValueError("zero-length vector")
    return tuple(x / n for x in a)


def rotate_z(p, deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    return (c*p[0]-s*p[1], s*p[0]+c*p[1], p[2])


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", binascii.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: Path, width: int, height: int, rgb: bytearray) -> None:
    rows = []
    stride = width * 3
    for y in range(height):
        rows.append(b"\x00" + bytes(rgb[y*stride:(y+1)*stride]))
    payload = zlib.compress(b"".join(rows), level=6)
    data = b"\x89PNG\r\n\x1a\n"
    data += png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    data += png_chunk(b"IDAT", payload)
    data += png_chunk(b"IEND", b"")
    path.write_bytes(data)


def set_px(buf: bytearray, w: int, h: int, x: int, y: int, color):
    if 0 <= x < w and 0 <= y < h:
        i = (y*w + x)*3
        buf[i:i+3] = bytes(color)


def disk(buf, w, h, cx, cy, r, color):
    r2 = r*r
    for y in range(cy-r, cy+r+1):
        for x in range(cx-r, cx+r+1):
            if (x-cx)*(x-cx)+(y-cy)*(y-cy) <= r2:
                set_px(buf, w, h, x, y, color)


def line(buf, w, h, a, b, width, color):
    x0, y0 = a; x1, y1 = b
    dx, dy = x1-x0, y1-y0
    steps = max(abs(dx), abs(dy), 1)
    radius = max(1, width//2)
    for i in range(steps+1):
        t = i/steps
        x = round(x0 + dx*t); y = round(y0 + dy*t)
        disk(buf, w, h, x, y, radius, color)


# COCO/OpenPose-ish canonical local joints for the current proxy rig.
BASE_JOINTS = {
    "nose": (0.0, 0.0, 2.30),
    "neck": (0.0, 0.0, 1.93),
    "rshoulder": (0.30, 0.0, 1.72),
    "relbow": (0.52, 0.0, 1.52),
    "rwrist": (0.72, 0.0, 1.37),
    "lshoulder": (-0.30, 0.0, 1.72),
    "lelbow": (-0.52, 0.0, 1.52),
    "lwrist": (-0.72, 0.0, 1.37),
    "rhip": (0.17, 0.0, 0.99),
    "rknee": (0.15, 0.0, 0.49),
    "rankle": (0.15, 0.0, 0.06),
    "lhip": (-0.17, 0.0, 0.99),
    "lknee": (-0.15, 0.0, 0.49),
    "lankle": (-0.15, 0.0, 0.06),
}

# OpenPose-like segment palette.  Colors encode body part, not dancer identity.
SEGMENTS = [
    ("nose", "neck", (255, 0, 0)),
    ("neck", "rshoulder", (255, 85, 0)),
    ("rshoulder", "relbow", (255, 170, 0)),
    ("relbow", "rwrist", (255, 255, 0)),
    ("neck", "lshoulder", (170, 255, 0)),
    ("lshoulder", "lelbow", (85, 255, 0)),
    ("lelbow", "lwrist", (0, 255, 0)),
    ("neck", "rhip", (0, 255, 85)),
    ("rhip", "rknee", (0, 255, 170)),
    ("rknee", "rankle", (0, 255, 255)),
    ("neck", "lhip", (0, 170, 255)),
    ("lhip", "lknee", (0, 85, 255)),
    ("lknee", "lankle", (0, 0, 255)),
    ("rhip", "lhip", (170, 0, 255)),
]


def nearest_snapshot(frames, wanted):
    return min(frames, key=lambda f: abs(int(f["frame"]) - wanted))


def actor_joints(st):
    root = tuple(float(x) for x in st["root_m"])
    yaw = float(st.get("pelvis_yaw_deg", 0.0))
    pelvis_local = st.get("pelvis_local_m", [0, 0, 0])
    dz = float(pelvis_local[2]) if len(pelvis_local) > 2 else 0.0
    joints = {}
    for name, local in BASE_JOINTS.items():
        p = local
        if name in {"rhip","rknee","rankle","lhip","lknee","lankle"}:
            p = (p[0], p[1], p[2] + dz)
        joints[name] = vadd(root, rotate_z(p, yaw))
    return joints


def make_camera(width, height, focal_mm=52.0, sensor_width_mm=36.0):
    loc = (0.0, -12.8, 4.9)
    target = (0.0, 0.4, 1.25)
    forward = norm(vsub(target, loc))
    world_up = (0.0, 0.0, 1.0)
    right = norm(cross(forward, world_up))
    up = norm(cross(right, forward))
    focal_px = width * focal_mm / sensor_width_mm
    def project(p):
        q = vsub(p, loc)
        z = dot(q, forward)
        if z <= 1e-6: return None
        x = width/2.0 + focal_px * dot(q, right) / z
        y_up = height/2.0 + focal_px * dot(q, up) / z
        # PNG rows are top-to-bottom.
        return (round(x), round((height-1)-y_up))
    return project, {"location":loc,"target":target,"focal_mm":focal_mm,"sensor_width_mm":sensor_width_mm}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("state", type=Path)
    ap.add_argument("-o", "--output", type=Path, required=True)
    ap.add_argument("--frame", type=int, default=48)
    ap.add_argument("--width", type=int, default=512)
    ap.add_argument("--height", type=int, default=512)
    ap.add_argument("--receipt", type=Path)
    ns = ap.parse_args()

    state = json.loads(ns.state.read_text(encoding="utf-8"))
    if state.get("schema") != "DANCESTATE/1" or not state.get("valid", False):
        raise SystemExit("state must be valid DANCESTATE/1")
    frames = state.get("frames") or []
    if not frames: raise SystemExit("state has no frames")
    snap = nearest_snapshot(frames, ns.frame)
    project, camera = make_camera(ns.width, ns.height)
    buf = bytearray(ns.width * ns.height * 3)
    actor_receipt = {}
    for actor, st in snap["actors"].items():
        joints3 = actor_joints(st)
        joints2 = {k: project(v) for k,v in joints3.items()}
        for a,b,c in SEGMENTS:
            pa,pb=joints2.get(a),joints2.get(b)
            if pa is not None and pb is not None:
                line(buf, ns.width, ns.height, pa, pb, 5, c)
        for p in joints2.values():
            if p is not None: disk(buf, ns.width, ns.height, p[0], p[1], 4, (255,255,255))
        actor_receipt[actor] = {k:list(v) if v is not None else None for k,v in joints2.items()}

    ns.output.parent.mkdir(parents=True, exist_ok=True)
    write_png(ns.output, ns.width, ns.height, buf)
    receipt = {
        "schema":"DANCERS_OPENPOSE_CONTROL/1",
        "source_state":str(ns.state.resolve()),
        "source_state_sha256":sha256(ns.state),
        "requested_frame":ns.frame,
        "state_frame":int(snap["frame"]),
        "width":ns.width,"height":ns.height,
        "camera":camera,
        "actor_count":len(actor_receipt),
        "joints_px":actor_receipt,
        "output":str(ns.output.resolve()),
        "output_sha256":sha256(ns.output),
    }
    rp = ns.receipt or ns.output.with_suffix(".json")
    rp.write_text(json.dumps(receipt,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"output":str(ns.output),"frame":snap["frame"],"actors":len(actor_receipt),"sha256":receipt["output_sha256"]},sort_keys=True))

if __name__ == "__main__":
    main()
