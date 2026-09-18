import csv
import importlib.util
import json
import math
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('package_samples',Path(__file__).resolve().parents[1]/'tools/package_samples.py')
pkg=importlib.util.module_from_spec(spec)
spec.loader.exec_module(pkg)


class PackageTests(unittest.TestCase):
    def csv_file(self, root, columns, rows, directory='observation.state.eef_pose'):
        target=root/directory/'data.csv';target.parent.mkdir(parents=True,exist_ok=True)
        with target.open('w',newline='') as f:
            writer=csv.writer(f);writer.writerow(columns);writer.writerows(rows)
        return target

    def test_rotation_columns_and_degenerate_orientation(self):
        axes=pkg.axes6([0,1,0,-1,0,0])
        self.assertEqual(axes,[[0,1,0],[-1,0,0],[0,0,1]])
        with self.assertRaises(ValueError):pkg.axes6([1,0,0,2,0,0])

    def test_single_arm_missing_gripper_and_invalid_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            path=self.csv_file(root,['timestamp_ms','x','y','z','r1','r2','r3','r4','r5','r6'],[
                [50,1,2,3,1,0,0,0,1,0],[10,2,3,4,0,0,0,0,0,0],[60,'nan',1,2,1,0,0,0,1,0]])
            issues=[];result=pkg.trajectories(path,{},issues)
            self.assertEqual(result[0]['side'],'single');self.assertEqual([p['t'] for p in result[0]['points']],[10,50])
            self.assertIsNone(result[0]['points'][0]['axes']);self.assertIsNone(result[0]['points'][0]['g'])
            self.assertEqual({i['code'] for i in issues},{'reordered_samples','invalid_samples','invalid_rotations'})

    def test_umi_reference_translation_and_rotation(self):
        def pose(x,y,z,qw=1,qz=0):return {'tcp.x':x,'tcp.y':y,'tcp.z':z,'tcp.qw':qw,'tcp.qx':0,'tcp.qy':0,'tcp.qz':qz}
        metadata={'coordinate_reference':{'type':'umi_episode_start_relative_pose','sides':{'left':{'pose':pose(1,2,3)},'right':{'pose':pose(1,3,3,math.sqrt(.5),math.sqrt(.5))}}}}
        transform=pkg.visual_transforms(metadata)
        self.assertAlmostEqual(transform['right'][1][3],1)
        self.assertAlmostEqual(transform['right'][0][0],0)
        self.assertAlmostEqual(transform['right'][1][0],1)
        self.assertEqual(pkg.visual_transforms({'coordinate_reference':{'sides':{}}}),{})

    def test_timing_offsets_duplicates_and_mismatches(self):
        exact=pkg.make_timing([0,.033,.066],[{'timestamp_ms':17},{'timestamp_ms':17},{'timestamp_ms':83}])
        self.assertFalse(exact['estimated']);self.assertEqual(exact['episode'],[17,17,83])
        missing=pkg.make_timing([0,.04,.11],[{'timestamp_ms':100}])
        self.assertTrue(missing['estimated']);self.assertEqual(missing['episode'],[100,140,210])
        invalid=pkg.make_timing([0,.04],[{'timestamp_ms':'nan'},{'timestamp_ms':150}])
        self.assertTrue(invalid['estimated']);self.assertEqual(invalid['episode'],[150,190])
        self.assertEqual(pkg.make_timing([0,.033],[])['episode'],[0,33])

    def test_slash_layout_empty_tactile_and_unknown_units(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            self.csv_file(root,['timestamp_ms','x','y','z'],[], 'observation/state/left_wrist_left_tactile')
            self.csv_file(root,['timestamp_ms','x','y','z'],[[0,1,2,3],[30,4,5,6]], 'observation/state/right_wrist_left_tactile')
            issues=[];result=pkg.signals(root,issues)
            self.assertEqual(len(result),3);self.assertTrue(all(s['unit'] is None for s in result))
            self.assertEqual(issues,[{'code':'empty_signal','channel':'left_wrist_left_tactile'}])

    def test_originals_and_no_qc_filter_for_signal_only_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';source.mkdir();dest=root/'dest';dest.mkdir()
            metadata={'robot':'arx5','task_title':'A sample','quality':{'labels':['something else']}}
            (source/'metadata.json').write_text(json.dumps(metadata))
            self.csv_file(source,['timestamp_ms','gripper'],[[0,.02],[30,.04]],'observation.state.gripper')
            entry=pkg.prepare_episode(source,dest,1)
            self.assertEqual(entry['title'],'A sample');self.assertEqual(entry['media'],[])
            self.assertEqual((source/'metadata.json').read_bytes(),(dest/'originals/sample-001/metadata.json').read_bytes())
            hashes=json.loads((dest/'samples/sample-001/original-checksums.json').read_text())
            self.assertEqual(hashes['originals/sample-001/metadata.json'],pkg.sha256(source/'metadata.json'))

    def test_existing_output_and_symlink_sources_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);out=root/'existing.zip';out.write_bytes(b'keep')
            with self.assertRaisesRegex(ValueError,'already exists'):pkg.build_package([],out)
            self.assertEqual(out.read_bytes(),b'keep')
            source=root/'source';source.mkdir();(source/'metadata.json').write_text('{}');(source/'link').symlink_to(out)
            with self.assertRaisesRegex(ValueError,'symbolic links'):pkg.prepare_episode(source,root/'dest',1)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg integration dependencies unavailable')
    def test_preview_preserves_last_frame_and_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';video=source/'observation.image.left_wrist_view/video.mp4';video.parent.mkdir(parents=True)
            (source/'metadata.json').write_text('{"robot":"synthetic"}')
            pkg.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=64x48:rate=25:duration=0.24',
                '-c:v','libx264','-threads','1',str(video)])
            original=video.read_bytes();entry=pkg.prepare_episode(source,root/'output',1)
            preview=pkg.probe(root/'output'/entry['media'][0]['path']);recorded=pkg.probe(video)
            self.assertEqual(len(preview['pts']),6)
            self.assertEqual(preview['pts'],recorded['pts'])
            self.assertEqual(video.read_bytes(),original)


if __name__=='__main__':unittest.main()
