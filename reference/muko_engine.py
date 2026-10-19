"""
==============================================================
 ムーブ解析by武庫  Web版  解析エンジン (muko_engine.py)

 クライミング・ボルダリング動画の骨格推定・ホールド検出および
 体幹相対座標によるムーブ自動解析・フリーズ出力。

 デスクトップ版 v2.8 のアルゴリズム(体幹座標系 / ムーブ判定 / 時間的安定化 /
 ホールド検出 / 最初のクライマー固定 / ダイアゴナル・フラッギング判定)を
 そのまま引き継ぎ、Webサーバから使いやすいよう以下を再構成しています。

   - 骨格推定を差し替え可能な「バックエンド」に分離
       * LegacyMediaPipeBackend : mp.solutions.pose (従来版と同一の挙動)
       * TasksMediaPipeBackend  : mediapipe Tasks API (新しい mediapipe 向け。
                                  モデルは初回に自動ダウンロード)
     解析ロジック本体は mediapipe に依存しません(単体テスト可能)。
   - 出力動画は ffmpeg(libx264) へパイプ出力 → ブラウザで再生できる H.264。
     ffmpeg が無い場合のみ OpenCV(mp4v) にフォールバック。
   - 骨格線は自前描画(mediapipe の描画ユーティリティ不要)
   - ロガーをインスタンスごとに注入(複数ジョブ同時管理用)
   - 検出したムーブの一覧(出力動画上の時刻つき)を結果として返す
==============================================================
"""

from __future__ import annotations

import glob
import logging
import math
import os
import platform
import shutil
import subprocess
import tempfile
import threading
import urllib.request
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

__version__ = "3.0.0"


Color = Tuple[int, int, int]  # BGR


# ==========================================
# 1. 動作モード
# ==========================================
class OutputMode(Enum):
    HOLDS_ONLY = auto()       # ホールド赤丸のみ描画
    MOVES_AND_PAUSE = auto()  # 顕著なムーブ検出時にムーブ名表示＆フリーズ


# ==========================================
# 2. 設定
# ==========================================
@dataclass(frozen=True)
class MoveThresholds:
    """
    ムーブ判定閾値。座標は体幹相対(骨盤幅相当を1とする単位, +x=人物の右, +y=体の上)、角度は度。
    v2.8: ダイアゴナル判定を誤検出を増やしすぎない範囲で少し緩和。
    v2.5: ヒールフックは v2.4 のまま据え置き。それ以外は初版より厳しくし、
          「顕著なムーブ」だけを検出する(各項目の括弧内は初版の値)。
    """
    # --- ヒールフック（据え置き）: かかとが腰の高さ付近以上 ＋ 膝をしっかり曲げる ＋ 一定時間持続
    heel_knee_angle: Tuple[float, float] = (40.0, 105.0)
    heel_ankle_vs_knee: float = -0.25
    heel_min_rel_y: float = -0.1
    # --- キョン: 膝をはっきり曲げ、膝が足首より大きく内側に入り、膝が腰より十分下
    drop_knee_angle: Tuple[float, float] = (65.0, 115.0)   # (60, 125)
    drop_knee_lateral: float = 0.5       # (0.35)
    drop_knee_max_knee_y: float = -0.2   # (0.0)
    # --- クロス: 手首が中心線を大きく越え、左右が明確に入れ替わる
    cross_midline: float = 0.5           # (v2.1: 0.3)
    cross_separation: float = 0.6        # (0.3)
    # --- フラッギング（v2.6でさらに厳格化）: ほぼ完全に伸ばした脚を、体の真横へ大きく張り出す
    flag_min_knee_angle: float = 160.0   # (v2.5: 150 / v2.1: 140)
    flag_min_lateral: float = 2.2        # (v2.5: 1.7 / v2.1: 1.4)
    flag_ankle_max_rel_y: float = -1.0   # (v2.5: -0.8 / v2.1: -0.6)
    flag_ankle_min_rel_y: float = -2.0   # (v2.5: -2.2 / v2.1: -2.4)
    flag_min_leg_angle: float = 55.0     # 脚(腰→足首)が鉛直から開く角度。新規
    # --- ダイアゴナル: 腕を高く伸ばし、対角の足を低く遠くへ伸ばして体を大きく斜めに張る
    diag_wrist_min_y: float = 2.7        # v2.8: 少しだけ緩和
    diag_ankle_max_y: float = -2.5       # v2.8: 少しだけ緩和
    diag_min_span: float = 1.7           # v2.8: 少しだけ緩和
    diag_other_wrist_drop: float = 1.2   # v2.8: 少しだけ緩和
    diag_leg_min_angle: float = 135.0    # v2.8: 少しだけ緩和
    # --- カウンターバランス(v3.1): ダイアゴナルの緩和版。片手を高く伸ばし、逆側の足を横へ出して体を預ける姿勢。
    #     足が腰よりそれほど低くなくても成立させ、フラッギングへ誤判定されるのを防ぐ。
    #     counter_wrist_min_y を inf にすると無効(= v3.0 までの挙動)
    counter_wrist_min_y: float = 2.0
    counter_ankle_max_y: float = -1.0
    counter_min_span: float = 1.5
    counter_other_wrist_drop: float = 0.6
    counter_foot_lateral: float = 1.2    # 足首が体の中心から逆側へこれ以上離れている
    counter_leg_min_angle: float = 140.0


@dataclass
class AnalyzerConfig:
    app_name: str = "ムーブ解析by武庫"
    app_name_en: str = "Move Analysis by Muko"
    mode: OutputMode = OutputMode.MOVES_AND_PAUSE

    # フリーズ演出
    pause_duration_sec: float = 1.0
    pause_cooldown_sec: float = 2.0

    # 入出力
    input_path: str = "climbing_input.mp4"
    output_path: str = "climbing_analyzed_muko.mp4"
    font_path: Optional[str] = None   # 未指定なら自動検索 (環境変数 MUKO_FONT も可)

    # 骨格推定
    model_complexity: int = 2
    min_detection_confidence: float = 0.6
    min_tracking_confidence: float = 0.6
    min_visibility: float = 0.65
    ema_alpha: float = 0.4
    draw_skeleton: bool = True

    # ホールド検出（速度・距離は体幹長で正規化、時間は秒）
    hold_stop_sec: float = 0.25
    hold_speed_thresh: float = 0.25    # 体幹長/秒
    hold_merge_dist: float = 0.25      # 体幹長
    max_holds: int = 4                 # 表示する赤丸の最大数(新しい順)。0なら無制限

    # 対象クライマーの固定（最初に検出した人を最後まで追う）
    lock_climber: bool = True
    lock_use_appearance: bool = True   # 服の色(胴体ヒストグラム)も照合に使う
    lock_max_jump: float = 1.0         # 1フレームで許容する移動量(体幹長)
    lock_close: float = 0.3            # この距離以内なら同一人物とみなす(体幹長)
    lock_scale_range: Tuple[float, float] = (0.5, 2.0)   # 体幹長の変化許容(比)
    lock_roi_scale: float = 2.2        # 追跡用の切り出し範囲(人物の枠に対する倍率)
    lock_appearance_thresh: float = 0.2  # 服色の相関がこれ未満なら別人
    lock_full_frame_sec: float = 1.0   # 見失ってこの時間後は全画面で再探索
    lock_relax_sec: float = 3.0        # 見失ってこの時間後は位置制約を解除(服色のみ照合)
    initial_roi: Optional[Tuple[float, float, float, float]] = None  # 最初に探す範囲(0〜1 x0,y0,x1,y1)

    # ムーブ安定化
    move_confirm_sec: float = 0.25     # 顕著なムーブのみ: 0.25秒以上持続して確定(初版:即時)
    heel_confirm_sec: float = 0.35     # ヒールフックは長めに持続したときだけ確定
    flag_confirm_sec: float = 0.5      # フラッギングはさらに長く持続したときだけ確定
    move_font_size: int = 44           # ムーブ名のフォントサイズ(短辺720px基準)
    thresholds: MoveThresholds = field(default_factory=MoveThresholds)

    # 堅牢性
    min_torso_ratio: float = 0.03      # 画面短辺に対する最小体幹長
    lost_reset_sec: float = 0.5        # この時間人物を見失ったら状態リセット
    max_consecutive_errors: int = 30

    def validate(self) -> None:
        if not (0.0 < self.ema_alpha <= 1.0):
            raise ValueError("ema_alpha は (0, 1] で指定してください")
        if self.model_complexity not in (0, 1, 2):
            raise ValueError("model_complexity は 0/1/2 のいずれかです")
        if not (0.0 <= self.min_visibility <= 1.0):
            raise ValueError("min_visibility は 0〜1 で指定してください")
        for name in ("pause_duration_sec", "pause_cooldown_sec", "hold_stop_sec",
                     "hold_speed_thresh", "hold_merge_dist", "move_confirm_sec",
                     "lost_reset_sec", "heel_confirm_sec", "flag_confirm_sec"):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} は 0 以上で指定してください")
        if not (self.lock_max_jump > 0 and 0 <= self.lock_close <= self.lock_max_jump):
            raise ValueError("lock_max_jump は正、lock_close は 0〜lock_max_jump で指定してください")
        lo, hi = self.lock_scale_range
        if not (0 < lo < hi):
            raise ValueError("lock_scale_range は 0 < 下限 < 上限 で指定してください")
        if self.lock_roi_scale < 1.1:
            raise ValueError("lock_roi_scale は 1.1 以上です")
        if not (-1.0 <= self.lock_appearance_thresh <= 1.0):
            raise ValueError("lock_appearance_thresh は -1〜1 です")
        if self.lock_full_frame_sec < 0 or self.lock_relax_sec <= 0:
            raise ValueError("lock_full_frame_sec は 0 以上、lock_relax_sec は正です")
        if self.initial_roi is not None:
            r = self.initial_roi
            if len(r) != 4 or not (0 <= r[0] < r[2] <= 1 and 0 <= r[1] < r[3] <= 1):
                raise ValueError("initial_roi は 0 <= x0 < x1 <= 1, 0 <= y0 < y1 <= 1 で指定してください")
        if not (10 <= self.move_font_size <= 200):
            raise ValueError("move_font_size は 10〜200 で指定してください")
        if self.max_holds < 0:
            raise ValueError("max_holds は 0 以上です (0=無制限)")
        if self.max_consecutive_errors < 1:
            raise ValueError("max_consecutive_errors は 1 以上です")
        if not self.input_path:
            raise ValueError("input_path が空です")
        if not self.output_path:
            raise ValueError("output_path が空です")
        if os.path.abspath(self.input_path) == os.path.abspath(self.output_path):
            raise ValueError("入力と出力に同じファイルは指定できません")


# ==========================================
# 3. 日本語テキスト描画 (Pillow連携)
# ==========================================
@dataclass
class TextItem:
    text: str
    pos: Tuple[int, int]      # 左上
    size: int
    color: Color              # BGR


class TextRenderer:
    """日本語フォントを自動検索。未検出時は cv2.putText(英数字)へ安全にフォールバック。"""

    _NAME_HINTS = ("notosanscjk", "notosansjp", "notosansmonocjk", "ipagothic", "ipag",
                   "ipaexg", "takao", "vl-gothic", "meiryo", "yugoth", "msgothic",
                   "hiragino", "ヒラギノ", "migu", "sazanami")

    def __init__(self, font_path: Optional[str] = None,
                 logger: Optional[logging.Logger] = None):
        self.log = logger or logging.getLogger(__name__)
        self._cache: Dict[int, ImageFont.FreeTypeFont] = {}
        self.font_path = self._resolve(font_path or os.environ.get("MUKO_FONT"))
        if self.font_path:
            self.log.info(f"日本語フォント: {self.font_path}")
        else:
            self.log.warning("日本語フォントが見つかりません。英語表記で出力します "
                             "(--font または環境変数 MUKO_FONT で指定可)")

    @property
    def supports_japanese(self) -> bool:
        return self.font_path is not None

    def _candidates(self) -> List[str]:
        system = platform.system()
        if system == "Windows":
            return ["C:/Windows/Fonts/meiryo.ttc", "C:/Windows/Fonts/YuGothM.ttc",
                    "C:/Windows/Fonts/msgothic.ttc"]
        if system == "Darwin":
            return ["/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc",
                    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
                    "/System/Library/Fonts/Hiragino Sans W4.ttc",
                    "/Library/Fonts/Arial Unicode.ttf"]
        return ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
                "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"]

    def _search_dirs(self) -> List[str]:
        system = platform.system()
        if system == "Windows":
            return ["C:/Windows/Fonts"]
        if system == "Darwin":
            return ["/System/Library/Fonts", "/Library/Fonts", os.path.expanduser("~/Library/Fonts")]
        return ["/usr/share/fonts", "/usr/local/share/fonts", os.path.expanduser("~/.fonts"),
                os.path.expanduser("~/.local/share/fonts")]

    @staticmethod
    def _loadable(path: str) -> bool:
        try:
            ImageFont.truetype(path, 16)
            return True
        except Exception:
            return False

    def _resolve(self, explicit: Optional[str]) -> Optional[str]:
        if explicit:
            if os.path.isfile(explicit) and self._loadable(explicit):
                return explicit
            self.log.warning(f"指定フォントを読み込めません: {explicit}")
        # Webサーバ向け: このファイルと同じ場所の fonts/ に置いたフォントを最優先で使う
        bundled = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
        if os.path.isdir(bundled):
            for ext in ("ttc", "otf", "ttf"):
                for p in sorted(glob.glob(os.path.join(bundled, f"*.{ext}"))):
                    if self._loadable(p):
                        return p
        for p in self._candidates():
            if os.path.isfile(p) and self._loadable(p):
                return p
        for d in self._search_dirs():
            if not os.path.isdir(d):
                continue
            for ext in ("ttc", "otf", "ttf"):
                for p in sorted(glob.glob(os.path.join(d, "**", f"*.{ext}"), recursive=True)):
                    if any(h in os.path.basename(p).lower() for h in self._NAME_HINTS) \
                            and self._loadable(p):
                        return p
        return None

    def _font(self, size: int) -> ImageFont.FreeTypeFont:
        size = max(8, int(size))
        if size not in self._cache:
            self._cache[size] = ImageFont.truetype(self.font_path, size)  # type: ignore[arg-type]
        return self._cache[size]

    def measure(self, text: str, size: int) -> Tuple[int, int]:
        if self.font_path:
            try:
                l, t, r, b = self._font(size).getbbox(text)
                return int(r), int(b)      # 描画原点(左上)から右端/下端までの実寸
            except Exception:
                pass
        (w, h), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, size / 30.0,
                                       max(1, size // 12))
        return int(w), int(h + base)

    def draw_batch(self, img: np.ndarray, items: Sequence[TextItem]) -> np.ndarray:
        """複数テキストを1回のPIL変換でまとめて描画。"""
        if not items:
            return img
        if self.font_path:
            try:
                pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
                draw = ImageDraw.Draw(pil)
                for it in items:
                    b, g, r = it.color
                    draw.text(it.pos, it.text, font=self._font(it.size), fill=(r, g, b))
                return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
            except Exception as e:  # フォント実行時エラー → 以後フォールバック
                self.log.warning(f"日本語描画に失敗、英語表記に切替: {e}")
                self.font_path = None
        for it in items:
            x, y = it.pos
            cv2.putText(img, it.text.encode("ascii", "replace").decode("ascii"),
                        (int(x), int(y + it.size)), cv2.FONT_HERSHEY_SIMPLEX,
                        it.size / 30.0, it.color, max(1, it.size // 12), cv2.LINE_AA)
        return img


# ==========================================
# 4. ムーブ定義 & 数学ユーティリティ
# ==========================================
class MoveType(Enum):
    NORMAL = ("通常登攀", "Normal Climbing")
    HEEL_HOOK_R = ("右ヒールフック", "Heel Hook (R)")
    HEEL_HOOK_L = ("左ヒールフック", "Heel Hook (L)")
    DROP_KNEE_R = ("右キョン (ドロップニー)", "Drop Knee (R)")
    DROP_KNEE_L = ("左キョン (ドロップニー)", "Drop Knee (L)")
    CROSS_R_OVER_L = ("右手クロス", "Cross (R > L)")
    CROSS_L_OVER_R = ("左手クロス", "Cross (L > R)")
    FLAG_R = ("右フラッギング", "Flagging (R)")
    FLAG_L = ("左フラッギング", "Flagging (L)")
    DIAGONAL_R = ("右手ダイアゴナル(カウンターバランス)", "Diagonal / Counterbalance (R hand)")
    DIAGONAL_L = ("左手ダイアゴナル(カウンターバランス)", "Diagonal / Counterbalance (L hand)")

    def __init__(self, jp_name: str, en_name: str):
        self.jp_name = jp_name
        self.en_name = en_name


class EMAFilter:
    def __init__(self, alpha: float):
        self.alpha = alpha
        self.value: Optional[np.ndarray] = None

    def update(self, new_value: np.ndarray) -> np.ndarray:
        if self.value is None:
            self.value = new_value.astype(float).copy()
        else:
            self.value = self.alpha * new_value + (1.0 - self.alpha) * self.value
        return self.value

    def reset(self) -> None:
        self.value = None


def calc_angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    ba, bc = a - b, c - b
    nba, nbc = np.linalg.norm(ba), np.linalg.norm(bc)
    if nba < 1e-5 or nbc < 1e-5:
        return 0.0
    cosine = np.clip(np.dot(ba, bc) / (nba * nbc), -1.0, 1.0)
    return float(np.degrees(np.arccos(cosine)))


def sanitize_fps(fps: float) -> float:
    return float(fps) if (fps is not None and math.isfinite(fps) and 1.0 <= fps <= 240.0) else 30.0


# ==========================================
# 5. 体幹座標系
# ==========================================
@dataclass
class BodyFrame:
    origin: np.ndarray
    u_spine: np.ndarray      # 腰→肩 (体の「上」)
    u_lat: np.ndarray        # 左腰→右腰 (体の「右」)
    lateral_valid: bool      # 左右軸が信頼できるか（真横向き等で False）
    torso_len: float         # px
    unit: float              # 骨盤幅相当の長さ px

    def to_rel(self, p: np.ndarray) -> Tuple[float, float]:
        d = p - self.origin
        return float(np.dot(d, self.u_lat) / self.unit), float(np.dot(d, self.u_spine) / self.unit)


def compute_body_frame(pts: Dict[str, np.ndarray], vis: Dict[str, bool],
                       min_torso_px: float) -> Optional[BodyFrame]:
    """
    左右は「人物の解剖学的な右」を +x とする。撮影方向（正面/背面/斜め）に依存しない。
    """
    if not all(vis.get(k, False) for k in ("l_sh", "r_sh", "l_hip", "r_hip")):
        return None
    origin = (pts["l_hip"] + pts["r_hip"]) / 2.0
    spine = (pts["l_sh"] + pts["r_sh"]) / 2.0 - origin
    torso = float(np.linalg.norm(spine))
    if not math.isfinite(torso) or torso < max(min_torso_px, 1.0):
        return None
    u_spine = spine / torso

    lateral_valid = False
    u_lat = np.array([-u_spine[1], u_spine[0]])  # 最終フォールバック(未使用扱い)
    for a, b in (("l_hip", "r_hip"), ("l_sh", "r_sh")):
        v = pts[b] - pts[a]
        v = v - np.dot(v, u_spine) * u_spine     # 脊柱に直交成分のみ
        n = float(np.linalg.norm(v))
        if n / torso >= 0.12:
            u_lat, lateral_valid = v / n, True
            break
    return BodyFrame(origin, u_spine, u_lat, lateral_valid, torso, max(torso * 0.6, 1.0))


# ==========================================
# 6. ムーブ判定（純粋ロジック・mediapipe非依存）
# ==========================================
@dataclass
class Detection:
    move: MoveType = MoveType.NORMAL
    anchor: Optional[np.ndarray] = None
    label: str = ""
    label_en: str = ""
    color: Color = (255, 255, 255)


class MoveDetector:
    def __init__(self, th: MoveThresholds):
        self.th = th

    def detect(self, pts: Dict[str, np.ndarray], vis: Dict[str, bool],
               body: BodyFrame) -> Detection:
        th = self.th
        rel = {k: body.to_rel(v) for k, v in pts.items()}

        def ok(*names: str) -> bool:
            return all(vis.get(n, False) for n in names)

        def knee_angle(side: str) -> float:
            return calc_angle(pts[f"{side}_hip"], pts[f"{side}_knee"], pts[f"{side}_ankle"])

        leg = {}
        for s in ("r", "l"):
            if ok(f"{s}_hip", f"{s}_knee", f"{s}_ankle"):
                leg[s] = knee_angle(s)

        # 1. ヒールフック
        for s, mv, jp, en in (("r", MoveType.HEEL_HOOK_R, "右ヒール", "R Heel"),
                              ("l", MoveType.HEEL_HOOK_L, "左ヒール", "L Heel")):
            if s in leg and ok(f"{s}_heel"):
                ang = leg[s]
                if (th.heel_knee_angle[0] <= ang <= th.heel_knee_angle[1]
                        and rel[f"{s}_ankle"][1] >= rel[f"{s}_knee"][1] + th.heel_ankle_vs_knee
                        and rel[f"{s}_heel"][1] >= th.heel_min_rel_y):
                    return Detection(mv, pts[f"{s}_heel"], jp, en, (255, 0, 255))

        # 1.5 ダイアゴナル / フラッギング（左右軸が必要）。
        #     ダイアゴナルを先に評価し、明瞭なフラッギングだけを後段で採用する。
        if body.lateral_valid:
            for hand, foot, mv, jp, en, dr in (
                    ("r", "l", MoveType.DIAGONAL_R, "対角", "Diagonal", 1.0),
                    ("l", "r", MoveType.DIAGONAL_L, "対角", "Diagonal", -1.0)):
                other = "l" if hand == "r" else "r"
                if foot in leg and ok(f"{hand}_wrist", f"{other}_wrist", f"{foot}_ankle"):
                    wx, wy = rel[f"{hand}_wrist"]
                    ax, ay = rel[f"{foot}_ankle"]
                    if (wy >= th.diag_wrist_min_y and ay <= th.diag_ankle_max_y
                            and leg[foot] >= th.diag_leg_min_angle
                            and (wx - ax) * dr >= th.diag_min_span
                            and rel[f"{other}_wrist"][1] <= wy - th.diag_other_wrist_drop):
                        return Detection(mv, pts[f"{hand}_wrist"], jp, en, (255, 160, 0))

            # カウンターバランス: ダイアゴナルの緩和版。フラッギングより先に評価し、誤判定を防ぐ
            for hand, foot, mv, dr in (("r", "l", MoveType.DIAGONAL_R, 1.0),
                                       ("l", "r", MoveType.DIAGONAL_L, -1.0)):
                other = "l" if hand == "r" else "r"
                if foot in leg and ok(f"{hand}_wrist", f"{other}_wrist", f"{foot}_ankle"):
                    wx, wy = rel[f"{hand}_wrist"]
                    ax, ay = rel[f"{foot}_ankle"]
                    if (wy >= th.counter_wrist_min_y and ay <= th.counter_ankle_max_y
                            and leg[foot] >= th.counter_leg_min_angle
                            and (wx - ax) * dr >= th.counter_min_span
                            and -ax * dr >= th.counter_foot_lateral
                            and rel[f"{other}_wrist"][1] <= wy - th.counter_other_wrist_drop):
                        return Detection(mv, pts[f"{hand}_wrist"], "カウンター", "Counter", (255, 160, 0))

            for s, mv, jp, en in (("r", MoveType.FLAG_R, "右フラッグ", "R Flag"),
                                  ("l", MoveType.FLAG_L, "左フラッグ", "L Flag")):
                if s in leg:
                    ax, ay = rel[f"{s}_ankle"]
                    hx, hy = rel[f"{s}_hip"]
                    leg_angle = math.degrees(math.atan2(abs(ax - hx), -(ay - hy)))
                    if (leg[s] >= th.flag_min_knee_angle
                            and abs(ax) >= th.flag_min_lateral
                            and leg_angle >= th.flag_min_leg_angle
                            and th.flag_ankle_min_rel_y <= ay <= th.flag_ankle_max_rel_y):
                        return Detection(mv, pts[f"{s}_ankle"], jp, en, (0, 140, 255))

        # 3. キョン（左右軸が必要）
        if body.lateral_valid:
            lo, hi = th.drop_knee_angle
            if ("r" in leg and lo <= leg["r"] <= hi
                    and rel["r_ankle"][0] - rel["r_knee"][0] > th.drop_knee_lateral
                    and rel["r_knee"][1] < th.drop_knee_max_knee_y):
                return Detection(MoveType.DROP_KNEE_R)
            if ("l" in leg and lo <= leg["l"] <= hi
                    and rel["l_knee"][0] - rel["l_ankle"][0] > th.drop_knee_lateral
                    and rel["l_knee"][1] < th.drop_knee_max_knee_y):
                return Detection(MoveType.DROP_KNEE_L)

            # 4. クロスムーブ（旧版は両条件が同値で常に左手クロス扱いだった → 中心線越えで区別）
            if ok("l_wrist", "r_wrist"):
                rx, lx = rel["r_wrist"][0], rel["l_wrist"][0]
                if lx - rx > th.cross_separation:   # 左右の手首が入れ替わっている
                    r_over = max(0.0, -rx - th.cross_midline) if rx < -th.cross_midline else 0.0
                    l_over = max(0.0, lx - th.cross_midline) if lx > th.cross_midline else 0.0
                    if r_over > 0 or l_over > 0:
                        return Detection(MoveType.CROSS_R_OVER_L if r_over >= l_over
                                         else MoveType.CROSS_L_OVER_R)

        return Detection()


class MoveStabilizer:
    """N フレーム連続で同じ判定が続いたときだけ確定（ヒステリシス）。"""

    def __init__(self, confirm_frames: int,
                 overrides: Optional[Dict["MoveType", int]] = None):
        self.confirm_frames = max(1, int(confirm_frames))
        self.overrides = {k: max(1, int(v)) for k, v in (overrides or {}).items()}
        self.confirmed = MoveType.NORMAL
        self._cand = MoveType.NORMAL
        self._count = 0

    def update(self, raw: MoveType) -> bool:
        """確定ムーブが変化したら True"""
        if raw == self.confirmed:
            self._cand, self._count = raw, 0
            return False
        if raw == self._cand:
            self._count += 1
        else:
            self._cand, self._count = raw, 1
        if self._count >= self.overrides.get(raw, self.confirm_frames):
            self.confirmed, self._count = raw, 0
            return True
        return False

    def reset(self) -> None:
        self.confirmed = self._cand = MoveType.NORMAL
        self._count = 0


# ==========================================
# 7. ホールド管理
# ==========================================
@dataclass
class Hold:
    x: float
    y: float
    n: int = 1
    id: int = 0

    @property
    def ipos(self) -> Tuple[int, int]:
        return int(round(self.x)), int(round(self.y))


class HoldManager:
    def __init__(self, cfg: AnalyzerConfig, fps: float):
        self.cfg = cfg
        self.stop_frames = max(3, int(round(cfg.hold_stop_sec * fps)))
        self.holds: List[Hold] = []          # 古い順（末尾が最新）
        self.counters: Dict[str, int] = {}
        self.total_registered = 0            # 累計で登録された新規ホールド数
        self._next_id = 1

    def update(self, limb: str, pos: np.ndarray, speed_torso: float, torso_px: float) -> None:
        """speed_torso: 体幹長/秒"""
        if speed_torso < self.cfg.hold_speed_thresh:
            c = self.counters.get(limb, 0) + 1
            self.counters[limb] = c
            if c == self.stop_frames:        # 停止エピソードごとに1回だけ登録
                self._register(pos, torso_px)
            elif c > self.stop_frames:       # 掴み続けている間は「最新」扱いにして消えないようにする
                self._touch(pos, torso_px)
        else:
            self.counters[limb] = 0

    def reset_limb(self, limb: str) -> None:
        self.counters[limb] = 0

    def reset_counters(self) -> None:
        self.counters.clear()

    def _nearest(self, pos: np.ndarray, torso_px: float) -> Optional[Hold]:
        merge = self.cfg.hold_merge_dist * torso_px
        best, best_d = None, merge
        for h in self.holds:
            d = math.hypot(h.x - pos[0], h.y - pos[1])
            if d < best_d:
                best, best_d = h, d
        return best

    def _to_newest(self, hold: Hold) -> None:
        self.holds.remove(hold)
        self.holds.append(hold)

    def _touch(self, pos: np.ndarray, torso_px: float) -> None:
        if not np.all(np.isfinite(pos)):
            return
        h = self._nearest(pos, torso_px)
        if h is not None and self.holds[-1] is not h:
            self._to_newest(h)

    def _register(self, pos: np.ndarray, torso_px: float) -> None:
        if not np.all(np.isfinite(pos)):
            return
        best = self._nearest(pos, torso_px)
        if best is None:
            self.holds.append(Hold(float(pos[0]), float(pos[1]), id=self._next_id))
            self._next_id += 1
            self.total_registered += 1
            limit = self.cfg.max_holds
            if limit > 0:                      # 古い赤丸を削除
                del self.holds[:-limit]
        else:  # 観測回数による移動平均（位置が徐々に安定）＋最新扱い
            best.x = (best.x * best.n + pos[0]) / (best.n + 1)
            best.y = (best.y * best.n + pos[1]) / (best.n + 1)
            best.n += 1
            self._to_newest(best)


# ==========================================
# 7.5 対象クライマーの固定（他の人の映り込み対策）
# ==========================================
@dataclass
class Candidate:
    center: np.ndarray                         # 胴体中心 (px)
    torso: float                               # 体幹長 (px)
    bbox: Tuple[float, float, float, float]    # 人物の外接枠 (px)
    hist: Optional[np.ndarray] = None          # 胴体の色ヒストグラム


def hist_corr(a: np.ndarray, b: np.ndarray) -> float:
    return float(cv2.compareHist(a.astype(np.float32), b.astype(np.float32), cv2.HISTCMP_CORREL))


class ClimberLock:
    """
    最初に検出した人物を記憶し、以降は
      1) その周辺だけを切り出して解析する(ROI。他の人が画面内にいても混ざりにくい)
      2) 検出結果が同一人物か 位置・大きさ・服の色 で照合し、別人なら捨てる
    見失った間は、探索範囲と許容移動量を段階的に広げる。
    """

    def __init__(self, cfg: AnalyzerConfig, fps: float):
        self.cfg = cfg
        self.locked = False
        self.center: Optional[np.ndarray] = None
        self.torso = 0.0
        self.bbox: Optional[Tuple[float, float, float, float]] = None
        self.hist: Optional[np.ndarray] = None
        self.missed = 0
        self._roi: Optional[Tuple[int, int, int, int]] = None
        self.full_frames = max(1, int(round(cfg.lock_full_frame_sec * fps)))
        self.relax_frames = max(1, int(round(cfg.lock_relax_sec * fps)))

    @property
    def relax(self) -> float:
        return min(1.0, self.missed / self.relax_frames)

    # ---- 照合 ----
    def accept(self, c: Candidate) -> bool:
        if not self.locked:
            return True
        relax = self.relax
        lo, hi = self.cfg.lock_scale_range
        ratio = c.torso / max(self.torso, 1e-6)
        if not (lo * (1.0 - 0.5 * relax) <= ratio <= hi * (1.0 + relax)):
            return False
        d = float(np.linalg.norm(c.center - self.center)) / max(self.torso, 1e-6)
        if d <= self.cfg.lock_close:
            return True
        allowed = math.inf if relax >= 1.0 else self.cfg.lock_max_jump * (1.0 + 0.5 * self.missed)
        if d > allowed:
            return False
        if self.cfg.lock_use_appearance and c.hist is not None and self.hist is not None:
            return hist_corr(c.hist, self.hist) >= self.cfg.lock_appearance_thresh
        return True

    def update(self, c: Candidate) -> None:
        close = False
        if self.locked:
            d = float(np.linalg.norm(c.center - self.center)) / max(self.torso, 1e-6)
            close = d <= self.cfg.lock_close
            self.torso = 0.8 * self.torso + 0.2 * c.torso
        else:
            self.torso = c.torso
        self.center = c.center.copy()
        self.bbox = c.bbox
        if c.hist is not None:
            if self.hist is None or not self.locked:
                self.hist = c.hist.copy()
            elif close:                       # 近い検出だけで服色をゆっくり更新
                self.hist = 0.95 * self.hist + 0.05 * c.hist
        self.locked = True
        self.missed = 0

    def miss(self) -> None:
        if self.locked:
            self.missed += 1

    # ---- 切り出し範囲 ----
    def roi_for(self, w: int, h: int, tight: bool = False) -> Optional[Tuple[int, int, int, int]]:
        """None なら全画面。"""
        if not self.locked:
            r = self.cfg.initial_roi
            if r is None:
                return None
            return (int(r[0] * w), int(r[1] * h), max(int(r[2] * w), int(r[0] * w) + 32),
                    max(int(r[3] * h), int(r[1] * h) + 32))
        if not tight and self.missed >= self.full_frames:
            self._roi = None
            return None
        bx0, by0, bx1, by1 = self.bbox  # type: ignore[misc]
        if not tight and self._roi is not None and self.missed == 0:
            rx0, ry0, rx1, ry1 = self._roi   # ヒステリシス: 枠内に余裕があればROIを動かさない
            mx, my = 0.1 * (rx1 - rx0), 0.1 * (ry1 - ry0)
            if bx0 >= rx0 + mx and bx1 <= rx1 - mx and by0 >= ry0 + my and by1 <= ry1 - my:
                return self._roi
        scale = 1.15 if tight else self.cfg.lock_roi_scale * (1.0 + 0.25 * self.missed)
        cx, cy = (bx0 + bx1) / 2.0, (by0 + by1) / 2.0
        hw = max((bx1 - bx0) / 2.0, self.torso * (0.6 if tight else 1.0)) * scale
        hh = max((by1 - by0) / 2.0, self.torso * (0.9 if tight else 1.5)) * scale
        x0, y0 = max(0, int(cx - hw)), max(0, int(cy - hh))
        x1, y1 = min(w, int(cx + hw)), min(h, int(cy + hh))
        if (x1 - x0) < 64 or (y1 - y0) < 64 or (x1 - x0) * (y1 - y0) >= 0.85 * w * h:
            roi = None
        else:
            roi = (x0, y0, x1, y1)
        if not tight:
            self._roi = roi
        return roi



# ==========================================
# 7.8 骨格推定バックエンド（差し替え可能）
# ==========================================
LANDMARK_COUNT = 33

# MediaPipe Pose の標準接続(35本)。mediapipe に依存せず自前で骨格線を描くために保持
POSE_CONNECTIONS: Tuple[Tuple[int, int], ...] = (
    (0, 1), (1, 2), (2, 3), (3, 7), (0, 4), (4, 5), (5, 6), (6, 8), (9, 10),
    (11, 12), (11, 13), (13, 15), (15, 17), (15, 19), (15, 21), (17, 19),
    (12, 14), (14, 16), (16, 18), (16, 20), (16, 22), (18, 20),
    (11, 23), (12, 24), (23, 24), (23, 25), (24, 26), (25, 27), (26, 28),
    (27, 29), (28, 30), (29, 31), (30, 32), (27, 31), (28, 32),
)
_LEFT_IDX = frozenset({1, 2, 3, 7, 9} | {i for i in range(11, 33) if i % 2 == 1})
_RIGHT_IDX = frozenset({4, 5, 6, 8, 10} | {i for i in range(12, 33) if i % 2 == 0})

# 新しい mediapipe (Tasks API) 用のモデル。complexity 0/1/2 = lite/full/heavy
_TASK_MODEL_NAMES = {0: "lite", 1: "full", 2: "heavy"}
_TASK_MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
                   "pose_landmarker_{n}/float16/latest/pose_landmarker_{n}.task")
_MODEL_DL_LOCK = threading.Lock()


class PoseBackend:
    """
    骨格推定バックエンドの共通インターフェース。
    process(rgb) は RGB 画像(H,W,3 uint8)を受け取り、
    形状 (33, 3) = [x, y, visibility] (x,y は入力画像内の 0〜1 正規化座標) を返す。人物なしは None。
    """
    name = "base"

    def begin_video(self, fps: float) -> None:       # 動画ごとに1回呼ばれる(任意実装)
        pass

    def process(self, rgb: np.ndarray) -> Optional[np.ndarray]:
        raise NotImplementedError

    def close(self) -> None:
        pass


class LegacyMediaPipeBackend(PoseBackend):
    """mp.solutions.pose を使う(従来のデスクトップ版と同一の挙動)。"""
    name = "mediapipe-solutions"

    def __init__(self, complexity: int, min_det: float, min_track: float):
        import mediapipe as mp
        if not hasattr(mp, "solutions"):
            raise RuntimeError("この mediapipe には mp.solutions がありません")
        try:
            self._pose = mp.solutions.pose.Pose(
                model_complexity=complexity,
                min_detection_confidence=min_det,
                min_tracking_confidence=min_track)
        except Exception as e:   # complexity 2 は初回にモデル取得が走る
            raise RuntimeError(f"骨格推定モデルを初期化できません (ネットワークを確認、"
                               f"または推定精度を 1 に下げてください): {e}") from e

    def process(self, rgb: np.ndarray) -> Optional[np.ndarray]:
        rgb.flags.writeable = False
        res = self._pose.process(rgb)
        plm = res.pose_landmarks
        if plm is None:
            return None
        return np.array([[n.x, n.y, n.visibility] for n in plm.landmark], dtype=float)

    def close(self) -> None:
        try:
            self._pose.close()
        except Exception:
            pass


def ensure_task_model(complexity: int, model_dir: str,
                      logger: Optional[logging.Logger] = None) -> str:
    """Tasks API 用モデル(.task)のパスを返す。無ければダウンロードする。"""
    log = logger or logging.getLogger(__name__)
    explicit = os.environ.get("MUKO_POSE_MODEL")
    if explicit:
        if os.path.isfile(explicit):
            return explicit
        raise RuntimeError(f"MUKO_POSE_MODEL で指定されたモデルが見つかりません: {explicit}")
    n = _TASK_MODEL_NAMES[complexity]
    path = os.path.join(model_dir, f"pose_landmarker_{n}.task")
    with _MODEL_DL_LOCK:
        if os.path.isfile(path) and os.path.getsize(path) > 1_000_000:
            return path
        url = _TASK_MODEL_URL.format(n=n)
        os.makedirs(model_dir, exist_ok=True)
        tmp = path + ".download"
        log.info(f"骨格推定モデル({n})をダウンロードしています… (初回のみ)")
        try:
            with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
            if os.path.getsize(tmp) < 1_000_000:
                raise RuntimeError("ダウンロードしたファイルが小さすぎます")
            os.replace(tmp, path)
        except Exception as e:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise RuntimeError(
                f"骨格推定モデルを取得できません: {e}\n"
                f"手動で {url} をダウンロードし、{path} として保存してください "
                f"(または環境変数 MUKO_POSE_MODEL にファイルパスを指定)。") from e
        return path


class TasksMediaPipeBackend(PoseBackend):
    """mediapipe Tasks API (PoseLandmarker, VIDEO モード)。mp.solutions が無い新しい版向け。"""
    name = "mediapipe-tasks"

    def __init__(self, complexity: int, min_det: float, min_track: float,
                 model_dir: str, logger: Optional[logging.Logger] = None):
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
        path = ensure_task_model(complexity, model_dir, logger)
        try:
            opts = vision.PoseLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=path),
                running_mode=vision.RunningMode.VIDEO,
                num_poses=1,
                min_pose_detection_confidence=min_det,
                min_pose_presence_confidence=min_det,
                min_tracking_confidence=min_track)
            self._lm = vision.PoseLandmarker.create_from_options(opts)
        except Exception as e:
            raise RuntimeError(f"骨格推定モデルを初期化できません: {e}") from e
        self._mp = mp
        self._ts = 0
        self._step = 33

    def begin_video(self, fps: float) -> None:
        self._step = max(1, int(round(1000.0 / max(fps, 1.0))))
        self._ts = 0

    def process(self, rgb: np.ndarray) -> Optional[np.ndarray]:
        self._ts += self._step          # 同一フレーム内の再試行でも単調増加を保つ
        img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB,
                             data=np.ascontiguousarray(rgb))
        res = self._lm.detect_for_video(img, self._ts)
        if not res.pose_landmarks:
            return None
        lms = res.pose_landmarks[0]
        return np.array([[l.x, l.y, (l.visibility if l.visibility is not None else 0.0)]
                         for l in lms], dtype=float)

    def close(self) -> None:
        try:
            self._lm.close()
        except Exception:
            pass


def create_pose_backend(cfg: "AnalyzerConfig", logger: Optional[logging.Logger] = None,
                        model_dir: Optional[str] = None,
                        name: Optional[str] = None) -> PoseBackend:
    """name: 'auto'(既定) / 'solutions' / 'tasks'。環境変数 MUKO_BACKEND でも指定可。"""
    log = logger or logging.getLogger(__name__)
    name = (name or os.environ.get("MUKO_BACKEND") or "auto").lower()
    try:
        import mediapipe as mp
    except ImportError as e:
        raise RuntimeError("mediapipe が必要です: pip install -r requirements.txt") from e
    if name == "auto":
        name = "solutions" if hasattr(mp, "solutions") else "tasks"
    model_dir = model_dir or os.environ.get("MUKO_MODEL_DIR") or os.path.join(os.getcwd(), "models")
    if name == "solutions":
        return LegacyMediaPipeBackend(cfg.model_complexity, cfg.min_detection_confidence,
                                      cfg.min_tracking_confidence)
    if name == "tasks":
        return TasksMediaPipeBackend(cfg.model_complexity, cfg.min_detection_confidence,
                                     cfg.min_tracking_confidence, model_dir, log)
    raise RuntimeError(f"未知のバックエンド指定です: {name}")


# ==========================================
# 7.9 動画出力シンク (H.264 優先)
# ==========================================
_FFMPEG_CACHE: Dict[str, Optional[str]] = {}


def find_ffmpeg() -> Optional[str]:
    """libx264 を使える ffmpeg を探す。環境変数 MUKO_FFMPEG → PATH → imageio-ffmpeg の順。"""
    if "exe" in _FFMPEG_CACHE:
        return _FFMPEG_CACHE["exe"]
    cands: List[str] = []
    if os.environ.get("MUKO_FFMPEG"):
        cands.append(os.environ["MUKO_FFMPEG"])
    w = shutil.which("ffmpeg")
    if w:
        cands.append(w)
    try:
        import imageio_ffmpeg
        cands.append(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        pass
    found: Optional[str] = None
    for exe in cands:
        try:
            out = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True,
                                 timeout=15, **_no_window()).stdout.decode("utf-8", "ignore")
            if "libx264" in out:
                found = exe
                break
        except Exception:
            continue
    _FFMPEG_CACHE["exe"] = found
    return found


def _no_window() -> dict:
    if os.name == "nt":      # Windows でコンソール窓が出ないように
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


class VideoSink:
    codec = ""

    def write(self, frame: np.ndarray) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError

    def abort(self) -> None:
        pass


class FFmpegSink(VideoSink):
    """BGR フレームを ffmpeg の標準入力へ流して H.264/yuv420p の MP4 を作る。"""
    codec = "h264"

    def __init__(self, exe: str, path: str, fps: float, w: int, h: int):
        self._err = tempfile.TemporaryFile()
        cmd = [exe, "-hide_banner", "-loglevel", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
               "-framerate", f"{fps:.6f}", "-i", "-", "-an",
               "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]
        self._p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                   stderr=self._err, **_no_window())

    def _tail(self) -> str:
        try:
            self._err.flush()
            self._err.seek(0)
            return self._err.read().decode("utf-8", "ignore").strip()[-400:]
        except Exception:
            return ""

    def write(self, frame: np.ndarray) -> None:
        try:
            self._p.stdin.write(frame.tobytes())   # type: ignore[union-attr]
        except (BrokenPipeError, OSError, ValueError) as e:
            raise RuntimeError(f"ffmpeg が異常終了しました: {self._tail()}") from e

    def close(self) -> None:
        try:
            self._p.stdin.close()                  # type: ignore[union-attr]
        except Exception:
            pass
        rc = self._p.wait()
        tail = self._tail()
        self._err.close()
        if rc != 0:
            raise RuntimeError(f"ffmpeg のエンコードに失敗しました (code {rc}): {tail}")

    def abort(self) -> None:
        try:
            self._p.kill()
            self._p.wait(timeout=5)
        except Exception:
            pass
        try:
            self._p.stdin.close()                  # type: ignore[union-attr]
        except Exception:
            pass
        try:
            self._err.close()
        except Exception:
            pass


class CvSink(VideoSink):
    """ffmpeg が無い場合のフォールバック(mp4v。ブラウザでは再生できないことがある)。"""
    codec = "mp4v"

    def __init__(self, path: str, fps: float, w: int, h: int):
        self._w = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
        if not self._w.isOpened():
            raise RuntimeError(f"出力ファイルを作成できません: {path}")

    def write(self, frame: np.ndarray) -> None:
        self._w.write(frame)

    def close(self) -> None:
        self._w.release()

    def abort(self) -> None:
        self._w.release()


def make_sink(path: str, fps: float, w: int, h: int,
              logger: Optional[logging.Logger] = None) -> VideoSink:
    log = logger or logging.getLogger(__name__)
    exe = find_ffmpeg()
    if exe:
        try:
            return FFmpegSink(exe, path, fps, w, h)
        except Exception as e:
            log.warning(f"ffmpeg を起動できません。OpenCV 出力に切り替えます: {e}")
    else:
        log.warning("libx264 対応の ffmpeg が見つかりません。OpenCV(mp4v) で出力します "
                    "(ブラウザでの再生はできない場合があります。pip install imageio-ffmpeg を推奨)")
    return CvSink(path, fps, w, h)


# ==========================================
# 8. メイン解析エンジン
# ==========================================
class ClimbingAnalyzerMuko:
    LIMBS = ("l_wrist", "r_wrist", "l_ankle", "r_ankle")

    # MediaPipe Pose のランドマーク番号
    _LM_INDEX = {
        "l_sh": 11, "r_sh": 12, "l_hip": 23, "r_hip": 24,
        "l_wrist": 15, "r_wrist": 16, "l_knee": 25, "r_knee": 26,
        "l_ankle": 27, "r_ankle": 28, "l_heel": 29, "r_heel": 30,
    }

    def __init__(self, config: AnalyzerConfig, backend: Optional[PoseBackend] = None,
                 logger: Optional[logging.Logger] = None, model_dir: Optional[str] = None):
        config.validate()
        self.cfg = config
        self.logger = logger or logging.getLogger("MoveAnalysisMuko")
        self._lm_index = dict(self._LM_INDEX)
        self.backend: PoseBackend = backend or create_pose_backend(config, self.logger, model_dir)
        self.text = TextRenderer(config.font_path, self.logger)
        self.detector = MoveDetector(config.thresholds)
        self.result: Dict[str, object] = {}
        self.events: List[Dict[str, object]] = []
        self._reset_state(30.0)

    # ---------- 状態管理 ----------
    def _reset_state(self, fps: float) -> None:
        self.fps = fps
        self.hold_manager = HoldManager(self.cfg, fps)

        def nf(sec: float) -> int:
            return max(2, int(round(sec * fps)))
        heel_n = nf(self.cfg.heel_confirm_sec)
        flag_n = nf(self.cfg.flag_confirm_sec)
        self.stabilizer = MoveStabilizer(
            nf(self.cfg.move_confirm_sec),
            overrides={MoveType.HEEL_HOOK_R: heel_n, MoveType.HEEL_HOOK_L: heel_n,
                       MoveType.FLAG_R: flag_n, MoveType.FLAG_L: flag_n})
        self.ema_filters: Dict[str, EMAFilter] = {}
        self.prev_pts: Dict[str, np.ndarray] = {}
        self.cooldown_frames = 0
        self.lost_frames = 0
        self.ui_scale = 1.0
        self.lock = ClimberLock(self.cfg, fps)
        self.rejected_count = 0      # 別人として除外したフレーム数
        self._frame_idx = 0
        self._lock_lost_logged = False
        self.events = []

    def _reset_tracking(self) -> None:
        for f in self.ema_filters.values():
            f.reset()
        self.prev_pts.clear()
        self.hold_manager.reset_counters()
        self.stabilizer.reset()

    # ---------- 動画処理 ----------
    def process_video(self, progress=None, cancel=None) -> bool:
        """
        成功なら True(詳細は self.result / self.events)。
        progress(done_frames, total_frames): 進捗通知(任意, total は不明なら 0)
        cancel: threading.Event 等 (is_set() が True で中止し、出力は破棄)
        """
        cfg = self.cfg
        self.result = {}
        if not os.path.isfile(cfg.input_path):
            self.logger.error(f"入力動画が見つかりません: {cfg.input_path}")
            return False
        cap = cv2.VideoCapture(cfg.input_path)
        if not cap.isOpened():
            self.logger.error(f"入力動画を開けませんでした: {cfg.input_path}")
            return False

        sink: Optional[VideoSink] = None
        tmp_path = ""
        ok_all = False
        try:
            fps = sanitize_fps(cap.get(cv2.CAP_PROP_FPS))
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            self._reset_state(fps)
            self.backend.begin_video(fps)
            dt = 1.0 / fps

            ret, frame = cap.read()
            if not ret or frame is None:
                self.logger.error("動画からフレームを読み込めませんでした")
                return False
            # 回転メタデータ等でプロパティと実フレームがずれるため、実フレームから取得
            h, w = frame.shape[:2]
            self.ui_scale = max(0.5, min(w, h) / 720.0)

            out_dir = os.path.dirname(os.path.abspath(cfg.output_path))
            os.makedirs(out_dir, exist_ok=True)
            root, ext = os.path.splitext(os.path.abspath(cfg.output_path))
            tmp_path = f"{root}.part{ext or '.mp4'}"
            sink = make_sink(tmp_path, fps, w, h, self.logger)

            self.logger.info(f"=== {cfg.app_name_en} v{__version__} 開始 ===")
            self.logger.info(f"モード: {cfg.mode.name} | {w}x{h} | {fps:.2f}FPS | "
                             f"{total if total > 0 else '?'}フレーム | "
                             f"推定: {self.backend.name} | 出力: {sink.codec}")

            idx, errors, pauses, out_count = 0, 0, 0, 0
            while ret:
                if cancel is not None and cancel.is_set():
                    self.logger.warning("キャンセルされました")
                    return False
                if frame.shape[0] != h or frame.shape[1] != w:
                    frame = cv2.resize(frame, (w, h))
                self._frame_idx = idx
                try:
                    frame, trigger = self._analyze_frame(frame, w, h, dt)
                    errors = 0
                except Exception as e:
                    errors += 1
                    trigger = False
                    self.logger.warning(f"フレーム{idx}の解析に失敗(原画像で継続): {e}")
                    if errors >= cfg.max_consecutive_errors:
                        self.logger.error("連続エラーが上限に達したため中断します")
                        return False

                sink.write(frame)
                out_count += 1
                if trigger:
                    pauses += 1
                    mv = self.stabilizer.confirmed
                    self.events.append({
                        "frame": idx,
                        "t_src": round(idx / fps, 3),
                        "t_out": round((out_count - 1) / fps, 3),   # 出力動画上の停止開始時刻
                        "move": mv.name, "jp": mv.jp_name, "en": mv.en_name,
                    })
                    self.logger.info(f"[{idx / fps:7.2f}s] ムーブ検出: 【{mv.jp_name}】 "
                                     f"- {cfg.pause_duration_sec:g}秒停止")
                    for _ in range(int(round(fps * cfg.pause_duration_sec))):
                        sink.write(frame)
                        out_count += 1

                if self.cooldown_frames > 0:
                    self.cooldown_frames -= 1
                idx += 1
                if progress is not None and (idx % 3 == 0 or idx == total):
                    try:
                        progress(idx, total)
                    except Exception:
                        pass
                if idx % 100 == 0:
                    pct = f" ({100 * idx / total:.0f}%)" if total > 0 else ""
                    self.logger.info(f"処理中: {idx}フレーム{pct}")
                ret, frame = cap.read()

            sink.close()
            codec = sink.codec
            sink = None
            os.replace(tmp_path, cfg.output_path)
            tmp_path = ""
            ok_all = True
            if progress is not None:
                try:
                    progress(idx, max(total, idx))
                except Exception:
                    pass
            self.result = {
                "frames": idx, "fps": round(fps, 3), "width": w, "height": h,
                "out_seconds": round(out_count / fps, 2),
                "src_seconds": round(idx / fps, 2),
                "holds_total": self.hold_manager.total_registered,
                "pauses": pauses,
                "rejected_frames": self.rejected_count,
                "codec": codec, "playable": codec == "h264",
                "backend": self.backend.name,
                "mode": cfg.mode.name,
            }
            self.logger.info(f"=== 解析完了 | {idx}フレーム / ホールド累計"
                             f"{self.hold_manager.total_registered}個 / 停止{pauses}回 ===")
            if cfg.lock_climber:
                self.logger.info(f"対象クライマー固定: 別人として除外したフレーム {self.rejected_count}")
            return True
        except Exception as e:
            self.logger.error(f"解析中に致命的な例外: {e}", exc_info=True)
            return False
        finally:
            cap.release()
            if sink is not None:
                sink.abort()
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            if not ok_all:
                self.logger.error("出力は生成されませんでした")

    def close(self) -> None:
        try:
            self.backend.close()
        except Exception:
            pass

    def __enter__(self) -> "ClimbingAnalyzerMuko":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---------- フレーム解析 ----------
    def _analyze_frame(self, frame: np.ndarray, w: int, h: int,
                       dt: float) -> Tuple[np.ndarray, bool]:
        lm = self._get_landmarks(frame, w, h)

        trigger = False
        detection = Detection()

        if lm is not None:
            self.lost_frames = 0
            pts, vis = self._extract_landmarks(lm, w, h)

            if self.cfg.draw_skeleton:
                self._draw_skeleton(frame, lm, w, h)

            body = compute_body_frame(pts, vis, self.cfg.min_torso_ratio * min(w, h))

            # 1. ホールドトラッキング（体幹長で速度を正規化）
            for limb in self.LIMBS:
                if body is not None and vis.get(limb, False):
                    prev = self.prev_pts.get(limb)
                    if prev is not None:
                        speed = float(np.linalg.norm(pts[limb] - prev)) / dt / body.torso_len
                        self.hold_manager.update(limb, pts[limb], speed, body.torso_len)
                    self.prev_pts[limb] = pts[limb].copy()
                else:
                    self.prev_pts.pop(limb, None)   # 欠測区間をまたいで速度を計算しない
                    self.hold_manager.reset_limb(limb)

            # 2. ムーブ判定
            if self.cfg.mode == OutputMode.MOVES_AND_PAUSE:
                raw = Detection()
                if body is not None:
                    raw = self.detector.detect(pts, vis, body)
                changed = self.stabilizer.update(raw.move)
                if (changed and self.stabilizer.confirmed != MoveType.NORMAL
                        and self.cooldown_frames == 0):
                    trigger = True
                    self.cooldown_frames = int(round(self.fps * self.cfg.pause_cooldown_sec))
                if raw.move == self.stabilizer.confirmed:
                    detection = raw
                else:
                    detection = Detection(self.stabilizer.confirmed)
        else:
            self.lost_frames += 1
            if self.lost_frames == max(1, int(round(self.cfg.lost_reset_sec * self.fps))):
                self._reset_tracking()      # 古い骨格位置の亡霊を防ぐ
            if self.cfg.mode == OutputMode.MOVES_AND_PAUSE:
                detection = Detection(self.stabilizer.confirmed)

        return self._render_ui(frame, w, h, detection, trigger), trigger

    # ---------- 対象クライマーの固定（他の人の映り込み対策） ----------
    def _infer(self, frame: np.ndarray, roi, w: int, h: int) -> Optional[np.ndarray]:
        """ROI(切り出し)で骨格推定し、ランドマークを全画面の正規化座標 (33,3) へ戻して返す。"""
        if roi is None:
            sub, x0, y0, cw, ch = frame, 0, 0, w, h
        else:
            x0, y0, x1, y1 = roi
            sub, cw, ch = frame[y0:y1, x0:x1], x1 - x0, y1 - y0
        rgb = cv2.cvtColor(sub, cv2.COLOR_BGR2RGB)
        lm = self.backend.process(rgb)
        if lm is None:
            return None
        lm = np.array(lm, dtype=float)       # 常にコピー(座標を書き換えるため)
        if lm.ndim != 2 or lm.shape[0] < LANDMARK_COUNT or lm.shape[1] < 3:
            return None
        if roi is not None:
            lm[:, 0] = (x0 + lm[:, 0] * cw) / w
            lm[:, 1] = (y0 + lm[:, 1] * ch) / h
        return lm

    def _make_candidate(self, lm: np.ndarray, frame: np.ndarray, w: int, h: int) -> Optional[Candidate]:
        raw = {}
        for name in ("l_sh", "r_sh", "l_hip", "r_hip"):
            node = lm[self._lm_index[name]]
            p = np.array([node[0] * w, node[1] * h], dtype=float)
            if not np.all(np.isfinite(p)) or float(node[2]) < self.cfg.min_visibility:
                return None
            raw[name] = p
        center = np.mean(list(raw.values()), axis=0)
        torso = float(np.linalg.norm((raw["l_sh"] + raw["r_sh"]) / 2.0
                                     - (raw["l_hip"] + raw["r_hip"]) / 2.0))
        if not math.isfinite(torso) or torso < max(self.cfg.min_torso_ratio * min(w, h), 1.0):
            return None
        xs, ys = [], []
        for node in lm:
            if float(node[2]) >= 0.3 and math.isfinite(node[0]) and math.isfinite(node[1]):
                xs.append(node[0] * w)
                ys.append(node[1] * h)
        if len(xs) < 4:
            xs = [p[0] for p in raw.values()]
            ys = [p[1] for p in raw.values()]
        bbox = (max(0.0, min(xs)), max(0.0, min(ys)), min(float(w), max(xs)), min(float(h), max(ys)))
        hist = self._torso_hist(frame, raw) if self.cfg.lock_use_appearance else None
        return Candidate(center, torso, bbox, hist)

    @staticmethod
    def _torso_hist(frame: np.ndarray, raw: Dict[str, np.ndarray]) -> Optional[np.ndarray]:
        xs = [p[0] for p in raw.values()]
        ys = [p[1] for p in raw.values()]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        mx, my = 0.2 * (x1 - x0), 0.2 * (y1 - y0)       # 縁(背景・腕)を避けて内側だけ使う
        ix0, ix1 = max(0, int(x0 + mx)), min(frame.shape[1], int(x1 - mx))
        iy0, iy1 = max(0, int(y0 + my)), min(frame.shape[0], int(y1 - my))
        if ix1 - ix0 < 3 or iy1 - iy0 < 3:
            return None
        hsv = cv2.cvtColor(frame[iy0:iy1, ix0:ix1], cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [18, 8], [0, 180, 0, 256])
        total = float(hist.sum())
        return (hist / total).astype(np.float32) if total > 0 else None

    def _get_landmarks(self, frame: np.ndarray, w: int, h: int) -> Optional[np.ndarray]:
        if not self.cfg.lock_climber:
            return self._infer(frame, None, w, h)
        lock = self.lock
        rois = [lock.roi_for(w, h)]
        if lock.locked:                       # 別人が混ざったら、本人の周りだけで再試行
            tight = lock.roi_for(w, h, tight=True)
            if tight != rois[0]:
                rois.append(tight)
        rejected = False
        for roi in rois:
            lm = self._infer(frame, roi, w, h)
            if lm is None:
                continue
            cand = self._make_candidate(lm, frame, w, h)
            if cand is None:
                continue
            if lock.accept(cand):
                first = not lock.locked
                was_lost = lock.locked and lock.missed >= max(1, int(self.fps))
                lock.update(cand)
                if first:
                    self.logger.info(f"[{self._frame_idx / self.fps:7.2f}s] 対象クライマーを固定しました")
                elif was_lost:
                    self.logger.info(f"[{self._frame_idx / self.fps:7.2f}s] 対象クライマーを再捕捉しました")
                self._lock_lost_logged = False
                return lm
            rejected = True
        if rejected:
            self.rejected_count += 1
        lock.miss()
        if lock.locked and lock.missed == max(1, int(self.fps)) and not self._lock_lost_logged:
            self._lock_lost_logged = True
            self.logger.info(f"[{self._frame_idx / self.fps:7.2f}s] 対象クライマーを見失いました(他の人は無視して探索を続けます)")
        return None

    def _extract_landmarks(self, lm: np.ndarray, w: int, h: int):
        pts: Dict[str, np.ndarray] = {}
        vis: Dict[str, bool] = {}
        for name, idx in self._lm_index.items():
            node = lm[idx]
            raw = np.array([node[0] * w, node[1] * h], dtype=float)
            finite = bool(np.all(np.isfinite(raw)))
            v = finite and float(node[2]) >= self.cfg.min_visibility
            flt = self.ema_filters.setdefault(name, EMAFilter(self.cfg.ema_alpha))
            if v:
                pts[name] = flt.update(raw).copy()
            elif flt.value is not None:
                pts[name] = flt.value.copy()
            else:
                pts[name] = raw if finite else np.zeros(2)
            vis[name] = v
        return pts, vis

    # ---------- 描画 ----------
    def _draw_skeleton(self, frame: np.ndarray, lm: np.ndarray, w: int, h: int) -> None:
        """mediapipe に依存しない骨格線の描画(左=橙 / 右=水色 / 中央=白)。"""
        s = self.ui_scale
        ok = [bool(np.isfinite(lm[i, 0]) and np.isfinite(lm[i, 1]) and lm[i, 2] >= 0.5)
              for i in range(LANDMARK_COUNT)]
        pt = [(int(round(lm[i, 0] * w)), int(round(lm[i, 1] * h))) if ok[i] else None
              for i in range(LANDMARK_COUNT)]
        lt = max(1, int(round(2 * s)))
        for a, b in POSE_CONNECTIONS:
            if pt[a] is not None and pt[b] is not None:
                cv2.line(frame, pt[a], pt[b], (224, 224, 224), lt, cv2.LINE_AA)
        r = max(2, int(round(3 * s)))
        for i in range(LANDMARK_COUNT):
            if pt[i] is None:
                continue
            col = (0, 138, 255) if i in _LEFT_IDX else (231, 217, 0) if i in _RIGHT_IDX \
                else (224, 224, 224)
            cv2.circle(frame, pt[i], r, col, -1, cv2.LINE_AA)

    def _render_ui(self, frame: np.ndarray, w: int, h: int, det: Detection,
                   is_pausing: bool) -> np.ndarray:
        s = self.ui_scale
        jp = self.text.supports_japanese
        cfg = self.cfg
        texts: List[TextItem] = []
        overlay = frame.copy()
        pad = int(10 * s)

        # ウォーターマーク（常時・右上、テキスト幅に追従）
        wm = cfg.app_name if jp else cfg.app_name_en
        wm_size = int(20 * s)
        tw, th_ = self.text.measure(wm, wm_size)
        x1, y0 = w - int(15 * s), int(15 * s)
        x0, y1 = max(0, x1 - tw - 2 * pad), y0 + th_ + 2 * pad
        cv2.rectangle(overlay, (x0, y0), (x1, y1), (20, 20, 20), -1)
        texts.append(TextItem(wm, (x0 + pad, y0 + pad), wm_size, (0, 220, 255)))

        # ムーブパネル（大きな文字。横に収まらなければウォーターマークの下段へ、それでも長ければ縮小）
        if cfg.mode == OutputMode.MOVES_AND_PAUSE:
            move = det.move
            name = move.jp_name if jp else move.en_name
            if is_pausing:
                disp = f"【{name}】"
                color: Color = (0, 255, 255)
            else:
                disp = name
                color_map = {"HEEL": (255, 0, 255), "DROP": (0, 215, 255),
                             "CROSS": (100, 200, 255), "FLAG": (0, 140, 255),
                             "DIAG": (255, 160, 0), "NORMAL": (0, 255, 200)}
                color = next((v for k, v in color_map.items() if k in move.name),
                             (255, 255, 255))
            size = max(12, int(cfg.move_font_size * s))
            margin = int(20 * s)
            px0, py0 = margin, int(15 * s)
            tw, th_ = self.text.measure(disp, size)
            avail = x0 - int(10 * s) - px0 - 2 * pad          # ウォーターマークの左側
            if tw > avail:                                      # 下段へ回す
                py0 = y1 + int(8 * s)
                avail = w - 2 * margin - 2 * pad
            if tw > avail and avail > 0:                        # それでも長ければ縮小
                size = max(12, int(size * avail / tw))
                tw, th_ = self.text.measure(disp, size)
            cv2.rectangle(overlay, (px0, py0), (min(w - 1, px0 + tw + 2 * pad), py0 + th_ + 2 * pad),
                          (20, 20, 20), -1)
            texts.append(TextItem(disp, (px0 + pad, py0 + pad), size, color))

        # パネルのみ半透明合成
        cv2.addWeighted(overlay, 0.65, frame, 0.35, 0, dst=frame)

        # ホールド赤丸（不透明）
        r_out, r_in, thick = int(22 * s), max(2, int(4 * s)), max(2, int(3 * s))
        for hd in self.hold_manager.holds:
            c = hd.ipos
            cv2.circle(frame, c, r_out, (0, 0, 255), thick, cv2.LINE_AA)
            cv2.circle(frame, c, r_in, (0, 0, 255), -1, cv2.LINE_AA)
            cv2.putText(frame, f"H{hd.id}", (c[0] + int(10 * s), c[1] - int(10 * s)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5 * s, (0, 0, 255), max(1, int(2 * s)),
                        cv2.LINE_AA)

        # フック部位の強調
        if cfg.mode == OutputMode.MOVES_AND_PAUSE and det.anchor is not None:
            a = (int(det.anchor[0]), int(det.anchor[1]))
            cv2.circle(frame, a, int(20 * s), det.color, max(2, int(3 * s)), cv2.LINE_AA)
            lab = det.label if jp else det.label_en
            if lab:
                texts.append(TextItem(lab, (a[0] + int(15 * s), a[1] - int(10 * s)),
                                      int(18 * s), det.color))

        return self.text.draw_batch(frame, texts)
