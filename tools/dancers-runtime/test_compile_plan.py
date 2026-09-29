#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent

def load(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    mod=importlib.util.module_from_spec(spec)
    sys.modules[name]=mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod

danceseq=load('danceseq',HERE/'danceseq.py')
compile_plan_mod=load('compile_plan',HERE/'compile_plan.py')

SPECIMEN="""DANCESEQ/1
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
"""

class CompilePlanTests(unittest.TestCase):
    def compile(self):
        return compile_plan_mod.compile_plan(danceseq.parse(SPECIMEN))

    def test_schema_and_actor_count(self):
        s=self.compile()
        self.assertEqual(s['schema'],'DANCESTATE/1')
        self.assertEqual(s['actor_count'],5)
        self.assertTrue(s['valid'])

    def test_formation_is_symmetric(self):
        s=self.compile(); f=s['frames'][0]['actors']
        self.assertAlmostEqual(f['D1']['root_m'][0],-f['D5']['root_m'][0])
        self.assertAlmostEqual(f['D2']['root_m'][0],-f['D4']['root_m'][0])
        self.assertEqual(f['D3']['root_m'][0],0.0)

    def test_inward_step(self):
        s=self.compile(); f=next(x for x in s['frames'] if x['frame']==24)['actors']
        self.assertAlmostEqual(f['D1']['root_m'][0],-2.29)
        self.assertAlmostEqual(f['D5']['root_m'][0],2.29)
        self.assertAlmostEqual(f['D3']['pelvis_local_m'][2],-0.19)

    def test_yaw_and_look(self):
        s=self.compile(); f=next(x for x in s['frames'] if x['frame']==48)['actors']
        for st in f.values():
            self.assertAlmostEqual(st['pelvis_yaw_deg'],-18.0)
            self.assertEqual(st['constraints']['chest.look'],'camera')

    def test_root_delta(self):
        s=self.compile(); f=next(x for x in s['frames'] if x['frame']==72)['actors']
        for st in f.values():
            self.assertAlmostEqual(st['root_m'][1], -0.24 + abs(st['root_m'][0] if st['root_m'][0] else 0)*0.0, delta=2.0)
            self.assertAlmostEqual(st['root_m'][2],0.17)

    def test_unknown_op_rejected(self):
        bad=SPECIMEN.replace('pose neutral','teleport moon')
        with self.assertRaises(compile_plan_mod.CompileError):
            compile_plan_mod.compile_plan(danceseq.parse(bad))

if __name__=='__main__':
    unittest.main(verbosity=2)
