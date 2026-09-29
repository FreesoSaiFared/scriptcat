#!/usr/bin/env python3
"""DANCESEQ/1 parser and deterministic normalizer.

The text format stays compact and human/LLM-writable. This module turns it
into a strict JSON plan that Blender or another renderer can consume without
having to interpret natural language at execution time.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path
import argparse
import json
import math
import re
from typing import Any

HEADER = "DANCESEQ/1"
META_KEYS = {"bpm", "fps", "duration_frames"}
FORMATIONS = {"V_SHALLOW", "V_DEEP", "LINE", "ARC", "GRID", "STACK", "FREE"}
FRAME_RE = re.compile(r"^F(?P<n>\d+)$", re.I)
BEAT_RE = re.compile(r"^B(?P<n>\d+(?:\.\d+)?)$", re.I)
NUMBER_UNIT_RE = re.compile(r"^(?P<n>[+-]?(?:\d+(?:\.\d*)?|\.\d+))(?P<u>deg|m|cm|mm|s|%)?$", re.I)


class DanceSeqError(ValueError):
    pass


@dataclass(frozen=True)
class Event:
    frame: int
    targets: tuple[str, ...]
    op: str
    args: tuple[Any, ...]
    source_line: int
    source: str


def _strip_comment(line: str) -> str:
    return line.split("#", 1)[0].strip()


def _parse_scalar(token: str) -> Any:
    m = NUMBER_UNIT_RE.match(token)
    if not m:
        return token
    n = float(m.group("n"))
    unit = (m.group("u") or "").lower()
    if not unit and n.is_integer():
        return int(n)
    return {"value": n, "unit": unit} if unit else n


def _targets(token: str) -> tuple[str, ...]:
    if token.upper() == "ALL":
        return ("ALL",)
    out = tuple(x.strip().upper() for x in token.split(",") if x.strip())
    if not out:
        raise DanceSeqError("empty target selector")
    for x in out:
        if not re.fullmatch(r"D\d+", x):
            raise DanceSeqError(f"invalid target {x!r}")
    return out


def _beat_to_frame(beat: float, bpm: float, fps: float) -> int:
    if beat < 1:
        raise DanceSeqError("beat numbers start at 1")
    seconds = (beat - 1.0) * 60.0 / bpm
    return int(round(seconds * fps)) + 1


def parse(text: str) -> dict[str, Any]:
    raw_lines = text.splitlines()
    lines = [(i + 1, _strip_comment(s), s.rstrip()) for i, s in enumerate(raw_lines)]
    meaningful = [(n, s, raw) for n, s, raw in lines if s]
    if not meaningful or meaningful[0][1].upper() != HEADER:
        raise DanceSeqError(f"first meaningful line must be {HEADER}")

    meta: dict[str, Any] = {}
    formation = "FREE"
    deferred: list[tuple[int, str, str]] = []

    for lineno, line, raw in meaningful[1:]:
        parts = line.split()
        head = parts[0]
        low = head.lower()
        if low in META_KEYS:
            if len(parts) != 2:
                raise DanceSeqError(f"line {lineno}: {low} expects one value")
            if low in meta:
                raise DanceSeqError(f"line {lineno}: duplicate metadata {low}")
            try:
                meta[low] = float(parts[1]) if low == "bpm" else int(parts[1])
            except ValueError as e:
                raise DanceSeqError(f"line {lineno}: invalid {low}") from e
        elif head.upper() == "FORM":
            if len(parts) != 2:
                raise DanceSeqError(f"line {lineno}: FORM expects one name")
            formation = parts[1].upper()
            if formation not in FORMATIONS:
                raise DanceSeqError(f"line {lineno}: unknown formation {formation}")
        else:
            deferred.append((lineno, line, raw))

    missing = META_KEYS - meta.keys()
    if missing:
        raise DanceSeqError(f"missing metadata: {', '.join(sorted(missing))}")
    if meta["bpm"] <= 0 or meta["fps"] <= 0 or meta["duration_frames"] < 1:
        raise DanceSeqError("bpm/fps must be positive and duration_frames >= 1")

    events: list[Event] = []
    globals_: list[dict[str, Any]] = []
    for lineno, line, raw in deferred:
        parts = line.split()
        head = parts[0].upper()
        if head == "CONTACT":
            if len(parts) < 2:
                raise DanceSeqError(f"line {lineno}: CONTACT requires a policy")
            globals_.append({"op": "CONTACT", "args": [_parse_scalar(x) for x in parts[1:]], "source_line": lineno})
            continue

        fm = FRAME_RE.match(parts[0])
        bm = BEAT_RE.match(parts[0])
        if not fm and not bm:
            raise DanceSeqError(f"line {lineno}: expected F###, B##, FORM, metadata, or CONTACT")
        if len(parts) < 3:
            raise DanceSeqError(f"line {lineno}: event requires selector and operation")
        if fm:
            frame = int(fm.group("n"))
        else:
            frame = _beat_to_frame(float(bm.group("n")), float(meta["bpm"]), float(meta["fps"]))
        if not (1 <= frame <= int(meta["duration_frames"])):
            raise DanceSeqError(f"line {lineno}: event frame {frame} outside sequence")
        events.append(Event(frame, _targets(parts[1]), parts[2], tuple(_parse_scalar(x) for x in parts[3:]), lineno, raw))

    # Stable ordering is part of the execution contract: frame first, then source order.
    events.sort(key=lambda e: (e.frame, e.source_line))
    normalized = {
        "schema": HEADER,
        "meta": {"bpm": float(meta["bpm"]), "fps": int(meta["fps"]), "duration_frames": int(meta["duration_frames"])},
        "formation": formation,
        "events": [asdict(e) for e in events],
        "globals": globals_,
    }
    normalized["stats"] = {
        "event_count": len(events),
        "first_frame": events[0].frame if events else None,
        "last_frame": events[-1].frame if events else None,
        "duration_seconds": round(int(meta["duration_frames"]) / int(meta["fps"]), 6),
    }
    return normalized


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", type=Path)
    ap.add_argument("-o", "--output", type=Path)
    ap.add_argument("--compact", action="store_true")
    ns = ap.parse_args()
    try:
        plan = parse(ns.input.read_text(encoding="utf-8"))
    except (OSError, DanceSeqError) as e:
        ap.error(str(e))
    rendered = json.dumps(plan, separators=(",", ":") if ns.compact else None, indent=None if ns.compact else 2)
    if ns.output:
        ns.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
