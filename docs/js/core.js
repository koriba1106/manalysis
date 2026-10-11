/**
 * ムーブ解析by武庫 Web版(ブラウザ完結) — 判定ロジック(DOM非依存・純粋ロジック)
 * Python版 muko_engine.py (v2.8 アルゴリズム) の忠実な移植。座標は [x, y] 配列(px)。
 * Node でもそのまま読み込めるのでテスト可能(tests/ 参照)。
 */

export const VERSION = "4.0.0";
export const LANDMARK_COUNT = 33;

/** Python の round() と同じ偶数丸め(.5 は偶数側へ)。フレーム数計算の一致に必要。 */
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

const mk = (id, jp, en) => Object.freeze({ id, jp, en });
export const MoveType = Object.freeze({
  NORMAL: mk("NORMAL", "通常登攀", "Normal Climbing"),
  HEEL_HOOK_R: mk("HEEL_HOOK_R", "右ヒールフック", "Heel Hook (R)"),
  HEEL_HOOK_L: mk("HEEL_HOOK_L", "左ヒールフック", "Heel Hook (L)"),
  DROP_KNEE_R: mk("DROP_KNEE_R", "右キョン (ドロップニー)", "Drop Knee (R)"),
  DROP_KNEE_L: mk("DROP_KNEE_L", "左キョン (ドロップニー)", "Drop Knee (L)"),
  CROSS_R_OVER_L: mk("CROSS_R_OVER_L", "右手クロス", "Cross (R > L)"),
  CROSS_L_OVER_R: mk("CROSS_L_OVER_R", "左手クロス", "Cross (L > R)"),
  FLAG_R: mk("FLAG_R", "右フラッギング", "Flagging (R)"),
  FLAG_L: mk("FLAG_L", "左フラッギング", "Flagging (L)"),
  DIAGONAL_R: mk("DIAGONAL_R", "右手ダイアゴナル", "Diagonal (R hand/L foot)"),
  DIAGONAL_L: mk("DIAGONAL_L", "左手ダイアゴナル", "Diagonal (L hand/R foot)"),
});

/** ムーブ判定閾値(体幹相対座標: 骨盤幅=1, +x=人物の右, +y=体の上 / 角度は度) */
export const DEFAULT_THRESHOLDS = Object.freeze({
  heel_knee_angle: [40.0, 105.0], heel_ankle_vs_knee: -0.25, heel_min_rel_y: -0.1,
  drop_knee_angle: [65.0, 115.0], drop_knee_lateral: 0.5, drop_knee_max_knee_y: -0.2,
  cross_midline: 0.5, cross_separation: 0.6,
  flag_min_knee_angle: 160.0, flag_min_lateral: 2.2, flag_ankle_max_rel_y: -1.0,
  flag_ankle_min_rel_y: -2.0, flag_min_leg_angle: 55.0,
  diag_wrist_min_y: 2.7, diag_ankle_max_y: -2.5, diag_min_span: 1.7,
  diag_other_wrist_drop: 1.2, diag_leg_min_angle: 135.0,
});

export const MODE = Object.freeze({ HOLDS_ONLY: "HOLDS_ONLY", MOVES_AND_PAUSE: "MOVES_AND_PAUSE" });

export const DEFAULT_CONFIG = Object.freeze({
  app_name: "ムーブ解析by武庫", app_name_en: "Move Analysis by Muko",
  mode: MODE.MOVES_AND_PAUSE,
  pause_duration_sec: 1.0, pause_cooldown_sec: 2.0,
  model_complexity: 2, min_detection_confidence: 0.6, min_tracking_confidence: 0.6,
  min_visibility: 0.65, ema_alpha: 0.4, draw_skeleton: true,
  hold_stop_sec: 0.25, hold_speed_thresh: 0.25, hold_merge_dist: 0.25, max_holds: 4,
  lock_climber: true, lock_use_appearance: true, lock_max_jump: 1.0, lock_close: 0.3,
  lock_scale_range: [0.5, 2.0], lock_roi_scale: 2.2, lock_appearance_thresh: 0.2,
  lock_full_frame_sec: 1.0, lock_relax_sec: 3.0, initial_roi: null,
  move_confirm_sec: 0.25, heel_confirm_sec: 0.35, flag_confirm_sec: 0.5, move_font_size: 44,
  thresholds: DEFAULT_THRESHOLDS,
  min_torso_ratio: 0.03, lost_reset_sec: 0.5, max_consecutive_errors: 30,
});

export function makeConfig(over = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...over };
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(c) {
  const bad = (m) => { throw new Error(m); };
  if (!(c.ema_alpha > 0 && c.ema_alpha <= 1)) bad("ema_alpha は (0, 1] で指定してください");
  if (![0, 1, 2].includes(c.model_complexity)) bad("推定精度は 0/1/2 のいずれかです");
  if (!(c.min_visibility >= 0 && c.min_visibility <= 1)) bad("min_visibility は 0〜1 で指定してください");
  for (const k of ["pause_duration_sec", "pause_cooldown_sec", "hold_stop_sec", "hold_speed_thresh",
    "hold_merge_dist", "move_confirm_sec", "lost_reset_sec", "heel_confirm_sec", "flag_confirm_sec"]) {
    if (!Number.isFinite(c[k]) || c[k] < 0) bad(`${k} は 0 以上の数値で指定してください`);
  }
  if (c.pause_duration_sec > 10) bad("停止秒数は10秒以下にしてください");
  if (c.pause_cooldown_sec > 60) bad("次の停止までは60秒以下にしてください");
  if (!(c.lock_max_jump > 0 && c.lock_close >= 0 && c.lock_close <= c.lock_max_jump)) bad("lock_max_jump / lock_close の指定が不正です");
  const [lo, hi] = c.lock_scale_range;
  if (!(lo > 0 && lo < hi)) bad("lock_scale_range の指定が不正です");
  if (c.lock_roi_scale < 1.1) bad("lock_roi_scale は 1.1 以上です");
  if (c.lock_full_frame_sec < 0 || c.lock_relax_sec <= 0) bad("lock_full_frame_sec / lock_relax_sec の指定が不正です");
  if (c.initial_roi) {
    const r = c.initial_roi;
    if (r.length !== 4 || !(r[0] >= 0 && r[0] < r[2] && r[2] <= 1 && r[1] >= 0 && r[1] < r[3] && r[3] <= 1)) bad("クライマーの範囲の指定が不正です");
  }
  if (!Number.isInteger(c.max_holds) || c.max_holds < 0) bad("赤丸の表示数は 0 以上の整数です");
}

export function sanitizeFps(fps) {
  return Number.isFinite(fps) && fps >= 1.0 && fps <= 240.0 ? fps : 30.0;
}

// ---------- 数学ユーティリティ ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const norm = (a) => Math.hypot(a[0], a[1]);

export function calcAngle(a, b, c) {
  const ba = sub(a, b), bc = sub(c, b);
  const nba = norm(ba), nbc = norm(bc);
  if (nba < 1e-5 || nbc < 1e-5) return 0.0;
  const cosine = Math.min(1, Math.max(-1, dot(ba, bc) / (nba * nbc)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

export class EMAFilter {
  constructor(alpha) { this.alpha = alpha; this.value = null; }
  update(v) {
    if (this.value === null) this.value = [v[0], v[1]];
    else this.value = [this.alpha * v[0] + (1 - this.alpha) * this.value[0],
      this.alpha * v[1] + (1 - this.alpha) * this.value[1]];
    return this.value;
  }
  reset() { this.value = null; }
}

// ---------- 体幹座標系 ----------
export class BodyFrame {
  constructor(origin, uSpine, uLat, lateralValid, torsoLen, unit) {
    Object.assign(this, { origin, uSpine, uLat, lateralValid, torsoLen, unit });
  }
  toRel(p) {
    const d = sub(p, this.origin);
    return [dot(d, this.uLat) / this.unit, dot(d, this.uSpine) / this.unit];
  }
}

export function computeBodyFrame(pts, vis, minTorsoPx) {
  for (const k of ["l_sh", "r_sh", "l_hip", "r_hip"]) if (vis[k] !== true) return null;
  const origin = [(pts.l_hip[0] + pts.r_hip[0]) / 2, (pts.l_hip[1] + pts.r_hip[1]) / 2];
  const mid = [(pts.l_sh[0] + pts.r_sh[0]) / 2, (pts.l_sh[1] + pts.r_sh[1]) / 2];
  const spine = sub(mid, origin);
  const torso = norm(spine);
  if (!Number.isFinite(torso) || torso < Math.max(minTorsoPx, 1.0)) return null;
  const uSpine = [spine[0] / torso, spine[1] / torso];
  let lateralValid = false;
  let uLat = [-uSpine[1], uSpine[0]];
  for (const [a, b] of [["l_hip", "r_hip"], ["l_sh", "r_sh"]]) {
    let v = sub(pts[b], pts[a]);
    const proj = dot(v, uSpine);
    v = [v[0] - proj * uSpine[0], v[1] - proj * uSpine[1]];
    const n = norm(v);
    if (n / torso >= 0.12) { uLat = [v[0] / n, v[1] / n]; lateralValid = true; break; }
  }
  return new BodyFrame(origin, uSpine, uLat, lateralValid, torso, Math.max(torso * 0.6, 1.0));
}

// ---------- ムーブ判定 ----------
export function makeDetection(move = MoveType.NORMAL, anchor = null, label = "", labelEn = "", color = [255, 255, 255]) {
  return { move, anchor, label, labelEn, color };
}

export class MoveDetector {
  constructor(th = DEFAULT_THRESHOLDS) { this.th = th; }

  detect(pts, vis, body) {
    const th = this.th;
    const rel = {};
    for (const k of Object.keys(pts)) rel[k] = body.toRel(pts[k]);
    const ok = (...names) => names.every((n) => vis[n] === true);
    const leg = {};
    for (const s of ["r", "l"]) {
      if (ok(`${s}_hip`, `${s}_knee`, `${s}_ankle`)) leg[s] = calcAngle(pts[`${s}_hip`], pts[`${s}_knee`], pts[`${s}_ankle`]);
    }

    // 1. ヒールフック
    for (const [s, mv, jp, en] of [["r", MoveType.HEEL_HOOK_R, "右ヒール", "R Heel"],
      ["l", MoveType.HEEL_HOOK_L, "左ヒール", "L Heel"]]) {
      if (leg[s] !== undefined && ok(`${s}_heel`)) {
        const ang = leg[s];
        if (th.heel_knee_angle[0] <= ang && ang <= th.heel_knee_angle[1]
          && rel[`${s}_ankle`][1] >= rel[`${s}_knee`][1] + th.heel_ankle_vs_knee
          && rel[`${s}_heel`][1] >= th.heel_min_rel_y) {
          return makeDetection(mv, pts[`${s}_heel`], jp, en, [255, 0, 255]);
        }
      }
    }

    // 1.5 ダイアゴナル / フラッギング
    if (body.lateralValid) {
      for (const [hand, foot, mv, dr] of [["r", "l", MoveType.DIAGONAL_R, 1.0], ["l", "r", MoveType.DIAGONAL_L, -1.0]]) {
        const other = hand === "r" ? "l" : "r";
        if (leg[foot] !== undefined && ok(`${hand}_wrist`, `${other}_wrist`, `${foot}_ankle`)) {
          const [wx, wy] = rel[`${hand}_wrist`];
          const [ax, ay] = rel[`${foot}_ankle`];
          if (wy >= th.diag_wrist_min_y && ay <= th.diag_ankle_max_y
            && leg[foot] >= th.diag_leg_min_angle
            && (wx - ax) * dr >= th.diag_min_span
            && rel[`${other}_wrist`][1] <= wy - th.diag_other_wrist_drop) {
            return makeDetection(mv, pts[`${hand}_wrist`], "対角", "Diagonal", [0, 160, 255]);
          }
        }
      }
      for (const [s, mv, jp, en] of [["r", MoveType.FLAG_R, "右フラッグ", "R Flag"],
        ["l", MoveType.FLAG_L, "左フラッグ", "L Flag"]]) {
        if (leg[s] !== undefined) {
          const [ax, ay] = rel[`${s}_ankle`];
          const [hx, hy] = rel[`${s}_hip`];
          const legAngle = (Math.atan2(Math.abs(ax - hx), -(ay - hy)) * 180) / Math.PI;
          if (leg[s] >= th.flag_min_knee_angle
            && Math.abs(ax) >= th.flag_min_lateral
            && legAngle >= th.flag_min_leg_angle
            && th.flag_ankle_min_rel_y <= ay && ay <= th.flag_ankle_max_rel_y) {
            return makeDetection(mv, pts[`${s}_ankle`], jp, en, [255, 140, 0]);
          }
        }
      }
    }

    // 3. キョン / 4. クロス(左右軸が必要)
    if (body.lateralValid) {
      const [lo, hi] = th.drop_knee_angle;
      if (leg.r !== undefined && lo <= leg.r && leg.r <= hi
        && rel.r_ankle[0] - rel.r_knee[0] > th.drop_knee_lateral
        && rel.r_knee[1] < th.drop_knee_max_knee_y) return makeDetection(MoveType.DROP_KNEE_R);
      if (leg.l !== undefined && lo <= leg.l && leg.l <= hi
        && rel.l_knee[0] - rel.l_ankle[0] > th.drop_knee_lateral
        && rel.l_knee[1] < th.drop_knee_max_knee_y) return makeDetection(MoveType.DROP_KNEE_L);

      if (ok("l_wrist", "r_wrist")) {
        const rx = rel.r_wrist[0], lx = rel.l_wrist[0];
        if (lx - rx > th.cross_separation) {
          const rOver = rx < -th.cross_midline ? Math.max(0, -rx - th.cross_midline) : 0;
          const lOver = lx > th.cross_midline ? Math.max(0, lx - th.cross_midline) : 0;
          if (rOver > 0 || lOver > 0) {
            return makeDetection(rOver >= lOver ? MoveType.CROSS_R_OVER_L : MoveType.CROSS_L_OVER_R);
          }
        }
      }
    }
    return makeDetection();
  }
}

/** N フレーム連続で同じ判定が続いたときだけ確定(ヒステリシス) */
export class MoveStabilizer {
  constructor(confirmFrames, overrides = {}) {
    this.confirmFrames = Math.max(1, Math.trunc(confirmFrames));
    this.overrides = {};
    for (const [k, v] of Object.entries(overrides)) this.overrides[k] = Math.max(1, Math.trunc(v));
    this.confirmed = MoveType.NORMAL; this._cand = MoveType.NORMAL; this._count = 0;
  }
  update(raw) {
    if (raw === this.confirmed) { this._cand = raw; this._count = 0; return false; }
    if (raw === this._cand) this._count += 1; else { this._cand = raw; this._count = 1; }
    const need = this.overrides[raw.id] !== undefined ? this.overrides[raw.id] : this.confirmFrames;
    if (this._count >= need) { this.confirmed = raw; this._count = 0; return true; }
    return false;
  }
  reset() { this.confirmed = this._cand = MoveType.NORMAL; this._count = 0; }
}

// ---------- ホールド管理 ----------
export class HoldManager {
  constructor(cfg, fps) {
    this.cfg = cfg;
    this.stopFrames = Math.max(3, pyRound(cfg.hold_stop_sec * fps));
    this.holds = [];            // 古い順(末尾が最新)
    this.counters = {};
    this.totalRegistered = 0;
    this._nextId = 1;
  }
  update(limb, pos, speedTorso, torsoPx) {
    if (speedTorso < this.cfg.hold_speed_thresh) {
      const c = (this.counters[limb] || 0) + 1;
      this.counters[limb] = c;
      if (c === this.stopFrames) this._register(pos, torsoPx);
      else if (c > this.stopFrames) this._touch(pos, torsoPx);
    } else this.counters[limb] = 0;
  }
  resetLimb(limb) { this.counters[limb] = 0; }
  resetCounters() { this.counters = {}; }
  _nearest(pos, torsoPx) {
    const merge = this.cfg.hold_merge_dist * torsoPx;
    let best = null, bestD = merge;
    for (const h of this.holds) {
      const d = Math.hypot(h.x - pos[0], h.y - pos[1]);
      if (d < bestD) { best = h; bestD = d; }
    }
    return best;
  }
  _toNewest(hold) { this.holds.splice(this.holds.indexOf(hold), 1); this.holds.push(hold); }
  _touch(pos, torsoPx) {
    if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return;
    const h = this._nearest(pos, torsoPx);
    if (h !== null && this.holds[this.holds.length - 1] !== h) this._toNewest(h);
  }
  _register(pos, torsoPx) {
    if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return;
    const best = this._nearest(pos, torsoPx);
    if (best === null) {
      this.holds.push({ x: pos[0], y: pos[1], n: 1, id: this._nextId });
      this._nextId += 1;
      this.totalRegistered += 1;
      const limit = this.cfg.max_holds;
      if (limit > 0 && this.holds.length > limit) this.holds.splice(0, this.holds.length - limit);
    } else {
      best.x = (best.x * best.n + pos[0]) / (best.n + 1);
      best.y = (best.y * best.n + pos[1]) / (best.n + 1);
      best.n += 1;
      this._toNewest(best);
    }
  }
}

// ---------- 対象クライマーの固定 ----------
/** cv2.compareHist(HISTCMP_CORREL) と同じ相関係数 */
export function histCorr(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let s12 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    s12 += da * db; s1 += da * da; s2 += db * db;
  }
  return Math.abs(s1 * s2) > 2.220446049250313e-16 ? s12 / Math.sqrt(s1 * s2) : 1.0;
}

export class ClimberLock {
  constructor(cfg, fps) {
    this.cfg = cfg;
    this.locked = false; this.center = null; this.torso = 0.0; this.bbox = null; this.hist = null;
    this.missed = 0; this._roi = null;
    this.fullFrames = Math.max(1, pyRound(cfg.lock_full_frame_sec * fps));
    this.relaxFrames = Math.max(1, pyRound(cfg.lock_relax_sec * fps));
  }
  get relax() { return Math.min(1.0, this.missed / this.relaxFrames); }

  accept(c) {
    if (!this.locked) return true;
    const relax = this.relax;
    const [lo, hi] = this.cfg.lock_scale_range;
    const ratio = c.torso / Math.max(this.torso, 1e-6);
    if (!(lo * (1.0 - 0.5 * relax) <= ratio && ratio <= hi * (1.0 + relax))) return false;
    const d = norm(sub(c.center, this.center)) / Math.max(this.torso, 1e-6);
    if (d <= this.cfg.lock_close) return true;
    const allowed = relax >= 1.0 ? Infinity : this.cfg.lock_max_jump * (1.0 + 0.5 * this.missed);
    if (d > allowed) return false;
    if (this.cfg.lock_use_appearance && c.hist && this.hist) {
      return histCorr(c.hist, this.hist) >= this.cfg.lock_appearance_thresh;
    }
    return true;
  }

  update(c) {
    let close = false;
    if (this.locked) {
      const d = norm(sub(c.center, this.center)) / Math.max(this.torso, 1e-6);
      close = d <= this.cfg.lock_close;
      this.torso = 0.8 * this.torso + 0.2 * c.torso;
    } else this.torso = c.torso;
    this.center = [c.center[0], c.center[1]];
    this.bbox = c.bbox;
    if (c.hist) {
      if (!this.hist || !this.locked) this.hist = Float32Array.from(c.hist);
      else if (close) {
        const h = new Float32Array(this.hist.length);
        for (let i = 0; i < h.length; i++) h[i] = 0.95 * this.hist[i] + 0.05 * c.hist[i];
        this.hist = h;
      }
    }
    this.locked = true; this.missed = 0;
  }

  miss() { if (this.locked) this.missed += 1; }

  /** null なら全画面。戻り値は整数の [x0,y0,x1,y1] */
  roiFor(w, h, tight = false) {
    if (!this.locked) {
      const r = this.cfg.initial_roi;
      if (!r) return null;
      const x0 = Math.trunc(r[0] * w), y0 = Math.trunc(r[1] * h);
      return [x0, y0, Math.max(Math.trunc(r[2] * w), x0 + 32), Math.max(Math.trunc(r[3] * h), y0 + 32)];
    }
    if (!tight && this.missed >= this.fullFrames) { this._roi = null; return null; }
    const [bx0, by0, bx1, by1] = this.bbox;
    if (!tight && this._roi !== null && this.missed === 0) {
      const [rx0, ry0, rx1, ry1] = this._roi;
      const mx = 0.1 * (rx1 - rx0), my = 0.1 * (ry1 - ry0);
      if (bx0 >= rx0 + mx && bx1 <= rx1 - mx && by0 >= ry0 + my && by1 <= ry1 - my) return this._roi;
    }
    const scale = tight ? 1.15 : this.cfg.lock_roi_scale * (1.0 + 0.25 * this.missed);
    const cx = (bx0 + bx1) / 2.0, cy = (by0 + by1) / 2.0;
    const hw = Math.max((bx1 - bx0) / 2.0, this.torso * (tight ? 0.6 : 1.0)) * scale;
    const hh = Math.max((by1 - by0) / 2.0, this.torso * (tight ? 0.9 : 1.5)) * scale;
    const x0 = Math.max(0, Math.trunc(cx - hw)), y0 = Math.max(0, Math.trunc(cy - hh));
    const x1 = Math.min(w, Math.trunc(cx + hw)), y1 = Math.min(h, Math.trunc(cy + hh));
    let roi;
    if ((x1 - x0) < 64 || (y1 - y0) < 64 || (x1 - x0) * (y1 - y0) >= 0.85 * w * h) roi = null;
    else roi = [x0, y0, x1, y1];
    if (!tight) this._roi = roi;
    return roi;
  }
}

export function roiEqual(a, b) {
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// ---------- 服の色ヒストグラム(胴体内側, HSV 18x8) ----------
/** 胴体の内側(縁・背景・腕を避ける)の矩形 [x0,y0,x1,y1](整数)。小さすぎれば null。 */
export function torsoBox(raw, imgW, imgH) {
  const ps = [raw.l_sh, raw.r_sh, raw.l_hip, raw.r_hip];
  const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const mx = 0.2 * (x1 - x0), my = 0.2 * (y1 - y0);
  const ix0 = Math.max(0, Math.trunc(x0 + mx)), ix1 = Math.min(imgW, Math.trunc(x1 - mx));
  const iy0 = Math.max(0, Math.trunc(y0 + my)), iy1 = Math.min(imgH, Math.trunc(y1 - my));
  if (ix1 - ix0 < 3 || iy1 - iy0 < 3) return null;
  return [ix0, iy0, ix1, iy1];
}

/** rgba(その領域だけのピクセル列)から cv2.calcHist([H,S],[18,8]) 相当を正規化して返す。 */
export function histFromRegion(rgba, regionW, regionH) {
  const hist = new Float32Array(18 * 8);
  let total = 0;
  for (let i = 0, n = regionW * regionH; i < n; i++) {
    const o = i * 4;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    const v = Math.max(r, g, b), m = Math.min(r, g, b), diff = v - m;
    const s = v === 0 ? 0 : Math.round((255 * diff) / v);
    let h = 0;
    if (diff > 0) {
      if (v === r) h = (60 * (g - b)) / diff;
      else if (v === g) h = 120 + (60 * (b - r)) / diff;
      else h = 240 + (60 * (r - g)) / diff;
      if (h < 0) h += 360;
    }
    let h180 = Math.round(h / 2);
    if (h180 >= 180) h180 -= 180;
    hist[Math.min(17, Math.floor(h180 / 10)) * 8 + Math.min(7, Math.floor(s / 32))] += 1;
    total += 1;
  }
  if (total <= 0) return null;
  for (let i = 0; i < hist.length; i++) hist[i] /= total;
  return hist;
}

/** 画像全体の rgba(幅 imgW, 高さ imgH)から計算する版(テスト・小さな画像用)。 */
export function torsoHist(rgba, imgW, imgH, raw) {
  const box = torsoBox(raw, imgW, imgH);
  if (!box) return null;
  const [x0, y0, x1, y1] = box, w = x1 - x0, h = y1 - y0;
  const region = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * imgW + x0) * 4;
    region.set(rgba.subarray(src, src + w * 4), y * w * 4);
  }
  return histFromRegion(region, w, h);
}

// ---------- フレーム単位の状態機械(描画・推論は含まない) ----------
export const LM_INDEX = Object.freeze({
  l_sh: 11, r_sh: 12, l_hip: 23, r_hip: 24, l_wrist: 15, r_wrist: 16,
  l_knee: 25, r_knee: 26, l_ankle: 27, r_ankle: 28, l_heel: 29, r_heel: 30,
});
export const LIMBS = ["l_wrist", "r_wrist", "l_ankle", "r_ankle"];

export class Tracker {
  constructor(cfg, fps) { this.cfg = cfg; this.detector = new MoveDetector(cfg.thresholds); this.reset(fps); }

  reset(fps) {
    const cfg = this.cfg;
    this.fps = fps;
    this.holdManager = new HoldManager(cfg, fps);
    const nf = (sec) => Math.max(2, pyRound(sec * fps));
    const heelN = nf(cfg.heel_confirm_sec), flagN = nf(cfg.flag_confirm_sec);
    this.stabilizer = new MoveStabilizer(nf(cfg.move_confirm_sec), {
      HEEL_HOOK_R: heelN, HEEL_HOOK_L: heelN, FLAG_R: flagN, FLAG_L: flagN });
    this.ema = {};
    this.prevPts = {};
    this.cooldownFrames = 0;
    this.lostFrames = 0;
  }

  resetTracking() {
    for (const f of Object.values(this.ema)) f.reset();
    this.prevPts = {};
    this.holdManager.resetCounters();
    this.stabilizer.reset();
  }

  extract(lm, w, h) {
    const pts = {}, vis = {};
    for (const [name, idx] of Object.entries(LM_INDEX)) {
      const node = lm[idx];
      const raw = [node[0] * w, node[1] * h];
      const finite = Number.isFinite(raw[0]) && Number.isFinite(raw[1]);
      const v = finite && node[2] >= this.cfg.min_visibility;
      const flt = this.ema[name] || (this.ema[name] = new EMAFilter(this.cfg.ema_alpha));
      if (v) pts[name] = [...flt.update(raw)];
      else if (flt.value !== null) pts[name] = [...flt.value];
      else pts[name] = finite ? raw : [0, 0];
      vis[name] = v;
    }
    return { pts, vis };
  }

  /** lm: 全画面の正規化座標 [[x,y,vis]*33] または null。dt は秒。 */
  step(lm, w, h, dt) {
    const cfg = this.cfg;
    let trigger = false;
    let detection = makeDetection();
    let pts = null, vis = null;
    if (lm !== null) {
      this.lostFrames = 0;
      ({ pts, vis } = this.extract(lm, w, h));
      const body = computeBodyFrame(pts, vis, cfg.min_torso_ratio * Math.min(w, h));
      for (const limb of LIMBS) {
        if (body !== null && vis[limb]) {
          const prev = this.prevPts[limb];
          if (prev !== undefined) {
            const speed = norm(sub(pts[limb], prev)) / dt / body.torsoLen;
            this.holdManager.update(limb, pts[limb], speed, body.torsoLen);
          }
          this.prevPts[limb] = [pts[limb][0], pts[limb][1]];
        } else {
          delete this.prevPts[limb];
          this.holdManager.resetLimb(limb);
        }
      }
      if (cfg.mode === MODE.MOVES_AND_PAUSE) {
        let raw = makeDetection();
        if (body !== null) raw = this.detector.detect(pts, vis, body);
        const changed = this.stabilizer.update(raw.move);
        if (changed && this.stabilizer.confirmed !== MoveType.NORMAL && this.cooldownFrames === 0) {
          trigger = true;
          this.cooldownFrames = pyRound(this.fps * cfg.pause_cooldown_sec);
        }
        detection = raw.move === this.stabilizer.confirmed ? raw : makeDetection(this.stabilizer.confirmed);
      }
    } else {
      this.lostFrames += 1;
      if (this.lostFrames === Math.max(1, pyRound(cfg.lost_reset_sec * this.fps))) this.resetTracking();
      if (cfg.mode === MODE.MOVES_AND_PAUSE) detection = makeDetection(this.stabilizer.confirmed);
    }
    if (this.cooldownFrames > 0) this.cooldownFrames -= 1;   // Python版は1フレーム書き出し後に減算
    return { trigger, detection, pts, vis };
  }
}
