"""
Python版(reference/muko_engine.py = 従来アルゴリズム)を「正解」として、JS移植の照合用データを生成する。
  python tests/gen_golden.py
生成物: tests/golden/*.json (リポジトリにコミット済み。JS側テストは Python 不要)
"""
import json
import math
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "..", "reference"))
from muko_engine import (AnalyzerConfig, Candidate, ClimberLock, ClimbingAnalyzerMuko,  # noqa: E402
                         MoveDetector, MoveThresholds, OutputMode, PoseBackend,
                         compute_body_frame, hist_corr)

OUT = os.path.join(ROOT, "golden")
os.makedirs(OUT, exist_ok=True)
NAMES = ["l_sh", "r_sh", "l_hip", "r_hip", "l_wrist", "r_wrist", "l_knee", "r_knee",
         "l_ankle", "r_ankle", "l_heel", "r_heel"]
IDX = {"l_sh": 11, "r_sh": 12, "l_hip": 23, "r_hip": 24, "l_wrist": 15, "r_wrist": 16,
       "l_knee": 25, "r_knee": 26, "l_ankle": 27, "r_ankle": 28, "l_heel": 29, "r_heel": 30}


def dump(name, obj):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    print(name, os.path.getsize(os.path.join(OUT, name)) // 1024, "KB")


# ---------------- 姿勢(体幹相対: +x=人物の右, +y=上, 単位=骨盤幅) ----------------
def base_pose():
    p = {i: (0.0, 3.0) for i in range(33)}
    p[0] = (0.0, 2.3)
    p.update({11: (-0.5, 1.667), 12: (0.5, 1.667), 13: (-0.7, 2.2), 14: (0.7, 2.2),
              15: (-0.8, 2.6), 16: (0.8, 2.6), 17: (-0.8, 2.8), 18: (0.8, 2.8), 19: (-0.8, 2.8),
              20: (0.8, 2.8), 21: (-0.8, 2.8), 22: (0.8, 2.8), 23: (-0.5, 0.0), 24: (0.5, 0.0),
              25: (-0.5, -1.0), 26: (0.5, -1.0), 27: (-0.5, -2.0), 28: (0.5, -2.0),
              29: (-0.5, -2.1), 30: (0.5, -2.1), 31: (-0.5, -2.2), 32: (0.5, -2.2)})
    return p


def with_(**over):
    p = base_pose()
    names = {"l_wrist": 15, "r_wrist": 16, "l_knee": 25, "r_knee": 26, "l_ankle": 27,
             "r_ankle": 28, "l_heel": 29, "r_heel": 30}
    for k, v in over.items():
        p[names[k]] = v
    return p


def partner(i):
    face = {1: 4, 2: 5, 3: 6, 7: 8, 9: 10}
    face.update({v: k for k, v in list(face.items())})
    if i in face:
        return face[i]
    if i == 0:
        return 0
    return i + 1 if i % 2 == 1 else i - 1


def mirror(p):
    return {i: (-p[partner(i)][0], p[partner(i)][1]) for i in range(33)}


HEEL_R = with_(r_knee=(0.9, -0.8), r_ankle=(1.7, -0.4), r_heel=(1.75, -0.05))
DROP_R = with_(r_knee=(0.3, -1.0), r_ankle=(1.0, -1.2), r_heel=(1.05, -1.3))
CROSS_R = with_(r_wrist=(-0.9, 2.6), l_wrist=(0.9, 2.6))
FLAG_R = with_(r_knee=(1.75, -0.85), r_ankle=(3.0, -1.7), r_heel=(3.05, -1.8))
DIAG_R = with_(r_wrist=(0.6, 3.2), l_wrist=(-0.3, 1.5), l_knee=(-1.15, -1.4), l_ankle=(-1.8, -2.8),
               l_heel=(-1.85, -2.9))
# カウンターバランス: 右手を高く伸ばし、左足を横へ出す(足は腰よりやや下)。修正前はフラッギングと誤判定されていた
COUNTER_R = with_(r_wrist=(0.9, 3.0), l_wrist=(-0.6, 1.8), l_knee=(-1.7, -0.7), l_ankle=(-2.9, -1.4),
                  l_heel=(-2.95, -1.5))
POSES = [base_pose(), HEEL_R, mirror(HEEL_R), DROP_R, mirror(DROP_R), CROSS_R, mirror(CROSS_R),
         FLAG_R, mirror(FLAG_R), DIAG_R, mirror(DIAG_R), COUNTER_R, mirror(COUNTER_R)]


def to_px(rel, cx, cy, unit, theta, flip):
    """体幹相対 → 画像px。flip=True なら背面向き(左右の画像上の並びが逆)。theta は体の傾き。"""
    c, s = math.cos(theta), math.sin(theta)
    x, y = rel
    if flip:
        x = -x
    # 画像: +x(人物の右)は画像の左(正面向き)。体の「上」は画像の -y
    ex, ey = -x * unit, -y * unit
    return (cx + c * ex - s * ey, cy + s * ex + c * ey)


# ---------------- (A) 検出器 ----------------
def gen_detector(n=1800, seed=1):
    rng = np.random.default_rng(seed)
    th = MoveThresholds()
    det = MoveDetector(th)
    cases, counts = [], {}
    for k in range(n):
        base = POSES[rng.integers(len(POSES))] if k % 3 else None
        rel = {}
        for nm, i in IDX.items():
            if base is not None:
                bx, by = base[i]
                rel[nm] = (bx + rng.normal(0, 0.25), by + rng.normal(0, 0.25))
            else:
                rel[nm] = (rng.uniform(-3.5, 3.5), rng.uniform(-3.5, 4.0))
        rel["l_sh"], rel["r_sh"] = (-0.5, 1.667 * rng.uniform(.8, 1.2)), (0.5, 1.667 * rng.uniform(.8, 1.2))
        rel["l_hip"], rel["r_hip"] = (-0.5, 0.0), (0.5, 0.0)
        if k % 11 == 0:      # 真横向き(骨盤幅ほぼ0)
            for nm in ("l_hip", "r_hip", "l_sh", "r_sh"):
                rel[nm] = (rel[nm][0] * 0.05, rel[nm][1])
        cx, cy = rng.uniform(150, 500), rng.uniform(150, 350)
        unit = rng.uniform(25, 140)
        theta = rng.uniform(-0.6, 0.6)
        flip = bool(rng.integers(2))
        pts = {nm: np.array(to_px(rel[nm], cx, cy, unit, theta, flip)) for nm in NAMES}
        vis = {nm: bool(rng.random() < 0.92) for nm in NAMES}
        for nm in ("l_sh", "r_sh", "l_hip", "r_hip"):
            if k % 7 != 0:
                vis[nm] = True
        body = compute_body_frame(pts, vis, 0.03 * 480)
        rec = {"pts": {nm: pts[nm].tolist() for nm in NAMES}, "vis": vis, "min_torso_px": 0.03 * 480}
        if body is None:
            rec["body"] = None
        else:
            d = det.detect(pts, vis, body)
            rec["body"] = {"torso": body.torso_len, "unit": body.unit, "lateral": bool(body.lateral_valid)}
            rec["move"] = d.move.name
            rec["anchor"] = None if d.anchor is None else d.anchor.tolist()
            rec["label"], rec["label_en"] = d.label, d.label_en
            counts[d.move.name] = counts.get(d.move.name, 0) + 1
            if d.label == "カウンター":
                counts["_COUNTER_RELAXED"] = counts.get("_COUNTER_RELAXED", 0) + 1
        cases.append(rec)
    print("detector coverage:", counts)
    for m in ("HEEL_HOOK_R", "HEEL_HOOK_L", "DROP_KNEE_R", "DROP_KNEE_L", "CROSS_R_OVER_L",
              "CROSS_L_OVER_R", "FLAG_R", "FLAG_L", "DIAGONAL_R", "DIAGONAL_L", "NORMAL",
              "_COUNTER_RELAXED"):
        assert counts.get(m, 0) >= 15, f"coverage too low: {m} {counts.get(m, 0)}"
    dump("detector.json", cases)


# ---------------- (B) フレーム列(実エンジンの _analyze_frame を駆動) ----------------
class Dummy(PoseBackend):
    name = "dummy"


def gen_sequence(seed, fps, frames, cfg_over, w=640, h=480):
    rng = np.random.default_rng(seed)
    # シナリオ: 区間ごとに姿勢・遮蔽・見失いを乱択
    seq = []   # 各フレーム: None or (33,3) 正規化座標
    i = 0
    cx, cy, unit = 320.0, 300.0, 60.0
    while i < frames:
        L = int(rng.integers(12, 90))
        kind = rng.random()
        if kind < 0.08:
            seq += [None] * min(L, frames - i)
            i += L
            continue
        pose = POSES[rng.integers(len(POSES))] if rng.random() < 0.7 else POSES[0]
        occl = [rng.integers(11, 33) for _ in range(int(rng.integers(0, 3)))] if rng.random() < 0.3 else []
        for t in range(min(L, frames - i)):
            lm = np.zeros((33, 3))
            for j in range(33):
                rx, ry = pose[j]
                rx += rng.normal(0, 0.004)
                ry += rng.normal(0, 0.004)
                px, py = to_px((rx, ry), cx + 15 * math.sin((i + t) / 45.0), cy, unit, 0.0, False)
                lm[j] = (px / w, py / h, 0.99)
            for j in occl:
                lm[j, 2] = 0.3
            seq.append(lm)
        i += L
    return seq[:frames]


def run_python_sequence(seq, fps, cfg_over, w=640, h=480):
    cfg = AnalyzerConfig(input_path="a.mp4", output_path="b.mp4", **cfg_over)
    a = ClimbingAnalyzerMuko(cfg, backend=Dummy())
    a._reset_state(fps)
    cur = {"i": 0, "det": None}
    a._get_landmarks = lambda f, ww, hh: seq[cur["i"]]
    a._draw_skeleton = lambda *args, **kw: None

    def fake_render(frame, ww, hh, det, pausing):
        cur["det"] = det
        return frame
    a._render_ui = fake_render
    blank = np.zeros((h, w, 3), np.uint8)
    dt = 1.0 / fps
    rows = []
    for i in range(len(seq)):
        cur["i"], cur["det"] = i, None
        _, trig = a._analyze_frame(blank, w, h, dt)
        if a.cooldown_frames > 0:
            a.cooldown_frames -= 1
        d = cur["det"]
        rows.append({
            "t": bool(trig), "c": a.stabilizer.confirmed.name, "d": d.move.name,
            "a": None if d.anchor is None else np.asarray(d.anchor).tolist(),
            "h": [[hd.id, hd.x, hd.y, hd.n] for hd in a.hold_manager.holds],
            "n": a.hold_manager.total_registered,
        })
    return rows


def gen_sequences():
    out = []
    specs = [
        (11, 30.0, 900, {}),
        (12, 29.97, 900, {"max_holds": 0}),
        (13, 25.0, 500, {"mode": OutputMode.HOLDS_ONLY, "max_holds": 3}),
        (14, 60.0, 1000, {"pause_cooldown_sec": 0.5, "min_visibility": 0.5}),
    ]
    for seed, fps, frames, over in specs:
        seq = gen_sequence(seed, fps, frames, over)
        seq = [None if s is None else np.round(s, 6) for s in seq]   # JSON と同じ値で正解を計算
        rows = run_python_sequence(seq, fps, over)
        trig = sum(r["t"] for r in rows)
        kinds = sorted({r["c"] for r in rows})
        print(f"seq seed={seed} fps={fps}: triggers={trig} holds={rows[-1]['n']} moves={kinds}")
        o = dict(over)
        if "mode" in o:
            o["mode"] = o["mode"].name
        out.append({"fps": fps, "cfg": o, "w": 640, "h": 480,
                    "lm": [None if s is None else np.round(s, 6).tolist() for s in seq],
                    "expect": rows})
    assert sum(1 for s in out for r in s["expect"] if r["t"]) >= 8, "too few triggers in golden"
    dump("sequences.json", out)


# ---------------- (C) クライマー固定 ----------------
def gen_lock(seed=5, steps=450):
    rng = np.random.default_rng(seed)
    out = []
    for fps, appearance in ((30.0, False), (30.0, True), (24.0, True)):
        cfg = AnalyzerConfig(input_path="a.mp4", output_path="b.mp4", lock_use_appearance=appearance,
                             initial_roi=(0.2, 0.1, 0.8, 0.9) if appearance and fps == 30.0 else None)
        lock = ClimberLock(cfg, fps)
        w, h = 1280, 720
        base_h = rng.random(144) + 0.05
        base_h /= base_h.sum()
        other_h = rng.random(144) + 0.05
        other_h /= other_h.sum()
        pos = np.array([640.0, 360.0])
        torso = 150.0
        rows = []
        for s in range(steps):
            r = rng.random()
            if r < 0.07:      # 見失い(連続)
                cand = None
            else:
                kind = "me"
                if r < 0.20:
                    kind = "other"
                if kind == "me":
                    pos = pos + rng.normal(0, 10, 2)
                    pos = np.clip(pos, [100, 100], [w - 100, h - 100])
                    c_center, c_torso, hist = pos.copy(), torso * rng.uniform(0.9, 1.1), base_h + rng.normal(0, 0.001, 144)
                else:
                    c_center = pos + rng.normal(0, 400, 2)
                    c_torso = torso * rng.uniform(0.4, 2.4)
                    hist = other_h
                hist = np.abs(hist).astype(np.float32)
                hist = hist / hist.sum()
                bb = (c_center[0] - c_torso * .7, c_center[1] - c_torso * 1.3,
                      c_center[0] + c_torso * .7, c_center[1] + c_torso * 1.3)
                cand = Candidate(c_center, float(c_torso), bb, hist if appearance else None)
            if rng.random() < 0.01:       # 長期見失い
                for _ in range(int(rng.integers(40, 130))):
                    lock.miss()
                    rows.append({"cand": None, "skip": True})
            roi = lock.roi_for(w, h)
            tight = lock.roi_for(w, h, tight=True) if lock.locked else None
            rec = {"roi": roi, "tight": tight, "locked": lock.locked}
            if cand is None:
                lock.miss()
                rec["cand"] = None
            else:
                acc = lock.accept(cand)
                rec["cand"] = {"center": cand.center.tolist(), "torso": cand.torso, "bbox": list(cand.bbox),
                               "hist": None if cand.hist is None else np.round(cand.hist.astype(float), 8).tolist()}
                rec["accept"] = bool(acc)
                if acc:
                    lock.update(cand)
                else:
                    lock.miss()
            rec["missed"] = lock.missed
            rows.append(rec)
        # 長期見失い用の 'skip' 行は miss() だけの合図
        acc_count = sum(1 for r in rows if r.get("accept"))
        rej = sum(1 for r in rows if r.get("cand") and not r.get("accept"))
        print(f"lock fps={fps} appearance={appearance}: accept={acc_count} reject={rej}")
        out.append({"fps": fps, "cfg": {"lock_use_appearance": appearance,
                                        "initial_roi": list(cfg.initial_roi) if cfg.initial_roi else None},
                    "w": w, "h": h, "rows": rows})
    dump("lock.json", out)


# ---------------- (D) ヒストグラム ----------------
def gen_hist(seed=9):
    rng = np.random.default_rng(seed)
    cases = []
    for k in range(6):
        W, H = 160, 120
        img = np.zeros((H, W, 3), np.uint8)
        for _ in range(12):
            x0, y0 = rng.integers(0, W - 20), rng.integers(0, H - 20)
            x1, y1 = x0 + rng.integers(15, 80), y0 + rng.integers(15, 80)
            img[y0:y1, x0:x1] = rng.integers(0, 256, 3)
        img = np.clip(img.astype(int) + rng.integers(-6, 7, img.shape), 0, 255).astype(np.uint8)
        raw = {"l_sh": np.array([50.0, 20.0]) + rng.uniform(0, 10, 2), "r_sh": np.array([110.0, 22.0]) + rng.uniform(0, 10, 2),
               "l_hip": np.array([55.0, 90.0]) + rng.uniform(0, 8, 2), "r_hip": np.array([105.0, 92.0]) + rng.uniform(0, 8, 2)}
        hist = ClimbingAnalyzerMuko._torso_hist(img, raw)
        rgb = img[:, :, ::-1]
        cases.append({"w": W, "h": H, "rgb": rgb.reshape(-1).tolist(),
                      "raw": {k2: v.tolist() for k2, v in raw.items()},
                      "hist": None if hist is None else hist.reshape(-1).astype(float).tolist()})
    corr = []
    for _ in range(50):
        a, b = rng.random(144), rng.random(144)
        if rng.random() < 0.3:
            b = a + rng.normal(0, 0.05, 144)
        corr.append({"a": a.tolist(), "b": b.tolist(), "r": hist_corr(a.astype(np.float32), b.astype(np.float32))})
    dump("hist.json", {"cases": cases, "corr": corr})


if __name__ == "__main__":
    gen_detector()
    gen_sequences()
    gen_lock()
    gen_hist()
