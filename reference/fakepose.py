"""テスト用: 動画内の目印(マゼンタの点=骨盤中心)を手がかりに、既知の骨格を返す模擬バックエンド。"""
import numpy as np
from muko_engine import LANDMARK_COUNT, PoseBackend

U = 60.0  # 骨盤幅 = 1 単位 = 60px


def base_pose():
    """体幹相対(+x=人物の右, +y=上, 単位=骨盤幅)の標準姿勢(ぶら下がり)。"""
    p = {i: (0.0, 3.0) for i in range(LANDMARK_COUNT)}      # 顔など
    p[0] = (0.0, 2.3)
    p.update({
        11: (-0.5, 1.667), 12: (0.5, 1.667),     # l_sh, r_sh
        13: (-0.7, 2.2), 14: (0.7, 2.2),         # elbows
        15: (-0.8, 2.6), 16: (0.8, 2.6),         # wrists
        17: (-0.8, 2.8), 18: (0.8, 2.8), 19: (-0.8, 2.8), 20: (0.8, 2.8),
        21: (-0.8, 2.8), 22: (0.8, 2.8),
        23: (-0.5, 0.0), 24: (0.5, 0.0),         # hips
        25: (-0.5, -1.0), 26: (0.5, -1.0),       # knees
        27: (-0.5, -2.0), 28: (0.5, -2.0),       # ankles
        29: (-0.5, -2.1), 30: (0.5, -2.1),       # heels
        31: (-0.5, -2.2), 32: (0.5, -2.2),       # foot index
    })
    return p


def pose_with(**over):
    p = base_pose()
    names = {"l_wrist": 15, "r_wrist": 16, "l_knee": 25, "r_knee": 26,
             "l_ankle": 27, "r_ankle": 28, "l_heel": 29, "r_heel": 30}
    for k, v in over.items():
        p[names[k]] = v
    return p


NEUTRAL = base_pose()
HEEL_R = pose_with(r_knee=(0.9, -0.8), r_ankle=(1.7, -0.4), r_heel=(1.75, -0.05))
DROP_R = pose_with(r_knee=(0.3, -1.0), r_ankle=(1.0, -1.2), r_heel=(1.05, -1.3))
CROSS_R = pose_with(r_wrist=(-0.9, 2.6), l_wrist=(0.9, 2.6))


class FakePose(PoseBackend):
    name = "fake"

    def __init__(self, script, get_idx):
        self.script = script          # frame_idx -> pose dict | None
        self.get_idx = get_idx
        self.calls = 0
        self.closed = False
        self.fps_seen = None

    def begin_video(self, fps):
        self.fps_seen = fps

    def process(self, rgb):
        self.calls += 1
        pose = self.script(self.get_idx())
        if pose is None:
            return None
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        ys, xs = np.nonzero((r > 180) & (b > 180) & (g < 90))
        if len(xs) < 5:
            return None
        cx, cy = float(xs.mean()), float(ys.mean())
        h, w = rgb.shape[:2]
        out = np.zeros((LANDMARK_COUNT, 3))
        for i, (rx, ry) in pose.items():
            out[i] = ((cx - rx * U) / w, (cy - ry * U) / h, 0.99)   # +x(人物の右)は画像の左側
        return out

    def close(self):
        self.closed = True
