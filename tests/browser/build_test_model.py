"""
(任意・手動) 実モデルでの通しテスト用に、旧版 mediapipe の wheel に同梱された骨格推定モデルから
Tasks 形式の .task を組み立てる。ネットワークで Google の配布 URL に届かない環境向け。
  python build_test_model.py <出力.task> [wheelのパス]
必要: pip install tflite-support(Python 3.12 では imp モジュールの互換シムを内蔵)
"""
import glob, os, subprocess, sys, tempfile, types, zipfile

out = sys.argv[1]
wheel = sys.argv[2] if len(sys.argv) > 2 else None
if wheel is None:
    d = tempfile.mkdtemp()
    subprocess.run([sys.executable, "-m", "pip", "download", "--no-deps", "--only-binary=:all:", "--python-version", "3.11",
                    "--platform", "manylinux2014_x86_64", "mediapipe==0.10.14", "-d", d], check=True)
    wheel = glob.glob(os.path.join(d, "*.whl"))[0]

if "imp" not in sys.modules:                        # Python 3.12 で削除された imp の最小互換(tflite_support が参照)
    import importlib.util
    shim = types.ModuleType("imp")
    def find_module(name, path=None):
        spec = importlib.util.find_spec(name)
        if spec is None: raise ImportError(name)
        return (None, spec.origin, ("", "", 0))
    shim.find_module = find_module
    sys.modules["imp"] = shim

import flatbuffers
from tflite_support import metadata as _md
from tflite_support import metadata_schema_py_generated as fb


def with_norm(model_bytes, mean, std, name):
    """Tasks が要求する入力の正規化メタデータ(NormalizationOptions)を埋め込む。"""
    md = fb.ModelMetadataT(); md.name = name
    sg = fb.SubGraphMetadataT()
    t = fb.TensorMetadataT(); t.name = "image"
    t.content = fb.ContentT()
    t.content.contentPropertiesType = fb.ContentProperties.ImageProperties
    t.content.contentProperties = fb.ImagePropertiesT()
    t.content.contentProperties.colorSpace = fb.ColorSpaceType.RGB
    pu = fb.ProcessUnitT()
    pu.optionsType = fb.ProcessUnitOptions.NormalizationOptions
    pu.options = fb.NormalizationOptionsT(); pu.options.mean = [mean]; pu.options.std = [std]
    t.processUnits = [pu]
    sg.inputTensorMetadata = [t]
    md.subgraphMetadata = [sg]
    b = flatbuffers.Builder(0); b.Finish(md.Pack(b), _md.MetadataPopulator.METADATA_FILE_IDENTIFIER)
    pop = _md.MetadataPopulator.with_model_buffer(bytearray(model_bytes))
    pop.load_metadata_buffer(bytes(b.Output()))
    pop.populate()
    return bytes(pop.get_model_buffer())


w = zipfile.ZipFile(wheel)
det = with_norm(w.read("mediapipe/modules/pose_detection/pose_detection.tflite"), 127.5, 127.5, "pose_detector")
lmk = with_norm(w.read("mediapipe/modules/pose_landmark/pose_landmark_full.tflite"), 0.0, 255.0, "pose_landmarks_detector")
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    z.writestr("pose_detector.tflite", det)
    z.writestr("pose_landmarks_detector.tflite", lmk)
print("OK", out, os.path.getsize(out), "bytes (complexity 1 = full 用)")
