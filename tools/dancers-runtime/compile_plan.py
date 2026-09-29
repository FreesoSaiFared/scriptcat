#!/usr/bin/env python3
"""Compile normalized DANCESEQ into deterministic actor state keyframes."""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import math
from pathlib import Path
import sys
from typing import Any

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("danceseq", HERE / "danceseq.py")
danceseq = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = danceseq
assert SPEC.loader is not None
SPEC.loader.exec_module(danceseq)


class CompileError(ValueError):
    pass


def _number(arg: Any, units: set[str]) -> float:
    if isinstance(arg, (int, float)):
        if "" not in units:
            raise CompileError(f"unit required; expected one of {sorted(units)}")
        return float(arg)
    if not isinstance(arg, dict) or "value" not in arg:
        raise CompileError(f"numeric argument required, got {arg!r}")
    unit = str(arg.get("unit", ""))
    if unit not in units:
        raise CompileError(f"unexpected unit {unit!r}; expected one of {sorted(units)}")
    return float(arg["value"])


def _meters(arg: Any) -> float:
    if isinstance(arg, (int, float)):
        return float(arg)
    value = _number(arg, {"m", "cm", "mm"})
    return value * {"m": 1.0, "cm": 0.01, "mm": 0.001}[arg["unit"]]


def _degrees(arg: Any) -> float:
    return _number(arg, {"deg"})


def _infer_actor_count(plan: dict[str, Any]) -> int:
    highest = 0
    for ev in plan["events"]:
        for t in ev["targets"]:
            if t != "ALL":
                highest = max(highest, int(t[1:]))
    if highest:
        return highest
    raise CompileError("cannot infer dancer count from ALL-only sequence; name at least D1..Dn")


def _formation(name: str, n: int) -> dict[str, dict[str, Any]]:
    if n < 1:
        raise CompileError("actor count must be positive")
    actors: dict[str, dict[str, Any]] = {}
    center = (n - 1) / 2.0
    for i in range(n):
        x = (i - center) * 1.30
        if name == "V_SHALLOW":
            y = abs(x) * 0.45
        elif name == "V_DEEP":
            y = abs(x) * 0.80
        elif name == "LINE":
            y = 0.0
        elif name == "ARC":
            y = (x * x) * 0.12
        elif name == "STACK":
            x, y = 0.0, i * 0.85
        elif name == "GRID":
            cols = max(1, math.ceil(math.sqrt(n)))
            row, col = divmod(i, cols)
            x = (col - (cols - 1) / 2.0) * 1.15
            y = row * 1.0
        elif name == "FREE":
            y = 0.0
        else:
            raise CompileError(f"unsupported formation {name}")
        actors[f"D{i+1}"] = {
            "root_m": [round(x, 6), round(y, 6), 0.0],
            "pelvis_local_m": [0.0, 0.0, 0.0],
            "pelvis_yaw_deg": 0.0,
            "pose": "neutral",
            "constraints": {},
        }
    return actors


def _expand_targets(targets: list[str] | tuple[str, ...], actors: dict[str, Any]) -> list[str]:
    if targets == ["ALL"] or tuple(targets) == ("ALL",):
        return list(actors)
    missing = [x for x in targets if x not in actors]
    if missing:
        raise CompileError(f"unknown target(s): {', '.join(missing)}")
    return list(targets)


def _apply(actor: dict[str, Any], op: str, args: list[Any], actor_name: str) -> None:
    if op == "pose":
        if len(args) != 1 or not isinstance(args[0], str):
            raise CompileError("pose expects one preset name")
        actor["pose"] = args[0]
        return
    if op == "step":
        if len(args) != 2 or args[0] not in {"inward", "outward", "left", "right", "forward", "back"}:
            raise CompileError("step expects direction and distance")
        d = _meters(args[1])
        x, y, z = actor["root_m"]
        direction = args[0]
        if direction == "inward": x += d if x < 0 else -d if x > 0 else 0
        elif direction == "outward": x += -d if x < 0 else d if x > 0 else 0
        elif direction == "left": x -= d
        elif direction == "right": x += d
        elif direction == "forward": y -= d
        elif direction == "back": y += d
        actor["root_m"] = [round(x, 6), round(y, 6), round(z, 6)]
        return
    if op in {"root.x", "root.y", "root.z"}:
        if len(args) != 1: raise CompileError(f"{op} expects one distance")
        idx = {"root.x": 0, "root.y": 1, "root.z": 2}[op]
        actor["root_m"][idx] = round(actor["root_m"][idx] + _meters(args[0]), 6)
        return
    if op in {"pelvis.x", "pelvis.y", "pelvis.z"}:
        if len(args) != 1: raise CompileError(f"{op} expects one distance")
        idx = {"pelvis.x": 0, "pelvis.y": 1, "pelvis.z": 2}[op]
        actor["pelvis_local_m"][idx] = round(actor["pelvis_local_m"][idx] + _meters(args[0]), 6)
        return
    if op == "pelvis.yaw":
        if len(args) != 1: raise CompileError("pelvis.yaw expects one angle")
        actor["pelvis_yaw_deg"] = round(actor["pelvis_yaw_deg"] + _degrees(args[0]), 6)
        return
    if op == "chest.look":
        if len(args) != 1 or not isinstance(args[0], str):
            raise CompileError("chest.look expects one target token")
        actor["constraints"]["chest.look"] = args[0]
        return
    raise CompileError(f"unsupported operation {op!r} for {actor_name}")


def _diagnostics(frames: list[dict[str, Any]], fps: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for snap in frames:
        names = list(snap["actors"])
        minimum = None
        pair = None
        for i, a in enumerate(names):
            ax, ay, _ = snap["actors"][a]["root_m"]
            for b in names[i+1:]:
                bx, by, _ = snap["actors"][b]["root_m"]
                d = math.hypot(ax-bx, ay-by)
                if minimum is None or d < minimum:
                    minimum, pair = d, (a,b)
        if minimum is not None and minimum < 0.40:
            out.append({"level":"warning","frame":snap["frame"],"kind":"root_proximity","actors":list(pair),"distance_m":round(minimum,6)})
        for name, st in snap["actors"].items():
            if st["root_m"][2] < -1e-9:
                out.append({"level":"error","frame":snap["frame"],"kind":"root_below_floor","actor":name,"root_z_m":st["root_m"][2]})
    for prev, cur in zip(frames, frames[1:]):
        dt=(cur["frame"]-prev["frame"])/fps
        if dt <= 0: continue
        for name in cur["actors"]:
            p=prev["actors"][name]["root_m"]; q=cur["actors"][name]["root_m"]
            speed=math.sqrt(sum((q[i]-p[i])**2 for i in range(3)))/dt
            if speed > 4.0:
                out.append({"level":"warning","frame":cur["frame"],"kind":"root_speed","actor":name,"mps":round(speed,6)})
    return out


def compile_plan(plan: dict[str, Any]) -> dict[str, Any]:
    n = _infer_actor_count(plan)
    state = _formation(plan["formation"], n)
    frames: list[dict[str, Any]] = []
    by_frame: dict[int, list[dict[str, Any]]] = {}
    for ev in plan["events"]:
        by_frame.setdefault(int(ev["frame"]), []).append(ev)
    if 1 not in by_frame:
        frames.append({"frame": 1, "actors": copy.deepcopy(state), "applied": []})
    for frame in sorted(by_frame):
        applied=[]
        for ev in by_frame[frame]:
            targets = _expand_targets(ev["targets"], state)
            for target in targets:
                _apply(state[target], ev["op"], ev["args"], target)
            applied.append({"targets": targets, "op": ev["op"], "args": ev["args"], "source_line": ev["source_line"]})
        frames.append({"frame": frame, "actors": copy.deepcopy(state), "applied": applied})
    diagnostics = _diagnostics(frames, int(plan["meta"]["fps"]))
    return {
        "schema": "DANCESTATE/1",
        "source_schema": plan["schema"],
        "meta": plan["meta"],
        "formation": plan["formation"],
        "actor_count": n,
        "globals": plan["globals"],
        "frames": frames,
        "diagnostics": diagnostics,
        "valid": not any(x["level"] == "error" for x in diagnostics),
    }


def main() -> int:
    ap=argparse.ArgumentParser()
    ap.add_argument("input", type=Path)
    ap.add_argument("-o","--output",type=Path)
    ns=ap.parse_args()
    try:
        plan=danceseq.parse(ns.input.read_text(encoding="utf-8"))
        state=compile_plan(plan)
    except (OSError,danceseq.DanceSeqError,CompileError) as e:
        ap.error(str(e))
    data=json.dumps(state,indent=2)+"\n"
    if ns.output: ns.output.write_text(data,encoding="utf-8")
    else: print(data,end="")
    return 0 if state["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
