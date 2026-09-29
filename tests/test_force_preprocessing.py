import importlib.util
from pathlib import Path
import unittest
import numpy as np
import cv2

path=Path(__file__).resolve().parents[1]/'tools/force/model.py'
spec=importlib.util.spec_from_file_location('force_reference_adapter',path)
model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)

class ForcePreprocessingTests(unittest.TestCase):
    def test_first_frame_is_fixed_and_inputs_unchanged(self):
        rng=np.random.default_rng(17)
        reference=rng.integers(30,180,(93,161,3),dtype=np.uint8)
        current=reference.copy();current[20:50,60:100]=210
        original=reference.copy();copy=current.copy()
        processor=model.Preprocessor(reference)
        first=processor(reference);self.assertEqual(first.shape,(1,3,360,640))
        np.testing.assert_array_equal(first,0)
        a=processor(current);processor(reference);b=processor(current)
        np.testing.assert_array_equal(a,b)
        np.testing.assert_array_equal(reference,original);np.testing.assert_array_equal(current,copy)

    def test_relative_difference_uses_signed_gray_and_numpy_rounding(self):
        reference=np.zeros((360,640,3),np.uint8);reference[:,200:]=120
        current=reference.copy();current[:,:200]=1;current[:,200:]=117
        tensor=model.Preprocessor(reference)(current)
        np.testing.assert_array_equal(tensor[0,2,:,:200],1)
        np.testing.assert_allclose(tensor[0,2,:,200:],np.float32(-.02),atol=0,rtol=0)

    def test_contact_gate_and_physical_scaling(self):
        self.assertEqual(model.forces([1,1],.099999),(0,0))
        self.assertEqual(model.forces([1,1],.1),(2.6,5.7))
        self.assertEqual(model.forces([-1,-1],1),(0,0))

if __name__=='__main__':unittest.main()
