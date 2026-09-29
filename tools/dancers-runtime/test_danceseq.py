#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("danceseq", HERE / "danceseq.py")
danceseq = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = danceseq
assert SPEC.loader is not None
SPEC.loader.exec_module(danceseq)


GOOD = """DANCESEQ/1
bpm 120
fps 24
duration_frames 96
FORM V_SHALLOW
F001 ALL pose neutral
B02 D1,D5 step inward 0.31m
B03 D3 pelvis.z -19cm
F048 ALL pelvis.yaw -18deg
F072 ALL root.y -0.24m
CONTACT preserve_support
"""


class DanceSeqTests(unittest.TestCase):
    def test_normalization_is_deterministic(self):
        a = danceseq.parse(GOOD)
        b = danceseq.parse(GOOD)
        self.assertEqual(a, b)
        self.assertEqual(a["schema"], "DANCESEQ/1")
        self.assertEqual(a["formation"], "V_SHALLOW")
        self.assertEqual(a["stats"]["event_count"], 5)

    def test_beat_to_frame(self):
        p = danceseq.parse(GOOD)
        frames = [e["frame"] for e in p["events"]]
        self.assertEqual(frames, [1, 13, 25, 48, 72])

    def test_targets_and_units(self):
        p = danceseq.parse(GOOD)
        e = p["events"][1]
        self.assertEqual(tuple(e["targets"]), ("D1", "D5"))
        self.assertEqual(e["args"][1], {"value": 0.31, "unit": "m"})
        self.assertEqual(p["events"][2]["args"][0], {"value": -19.0, "unit": "cm"})

    def test_comments_and_blank_lines(self):
        p = danceseq.parse("# preface\n\n" + GOOD + "\n# tail\n")
        self.assertEqual(p["stats"]["event_count"], 5)

    def test_missing_metadata_rejected(self):
        with self.assertRaises(danceseq.DanceSeqError):
            danceseq.parse("DANCESEQ/1\nbpm 120\nfps 24\nF001 ALL pose neutral\n")

    def test_bad_target_rejected(self):
        bad = GOOD.replace("D1,D5 step", "LEFT,D5 step")
        with self.assertRaises(danceseq.DanceSeqError):
            danceseq.parse(bad)

    def test_out_of_range_frame_rejected(self):
        bad = GOOD + "F200 ALL pose impossible\n"
        with self.assertRaises(danceseq.DanceSeqError):
            danceseq.parse(bad)

    def test_unknown_formation_rejected(self):
        bad = GOOD.replace("FORM V_SHALLOW", "FORM MYSTERY")
        with self.assertRaises(danceseq.DanceSeqError):
            danceseq.parse(bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
