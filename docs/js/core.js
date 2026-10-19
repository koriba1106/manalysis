/**
 * ムーブ解析by武庫 Web版(ブラウザ完結) — 判定ロジック(DOM非依存・純粋ロジック)
 * 実動画向けムーブ判定の再構成 ＋ 脆弱性対策・堅牢性強化版。
 * 座標は [x, y] 配列(px)。Node でもそのまま読み込めるのでテスト可能(tests/ 参照)。
 */

export const VERSION = "4.2.0";
export const LANDMARK_COUNT = 33;

/** Python の round() と同じ偶数丸め(.5 は偶数側へ)。フレーム数計算の一致に必要。 */
export function pyRound(x) {
  if (!Number.isFinite(x)) return 0;
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
  DIAGONAL_R: mk("DIAGONAL_R", "右手ダイアゴナル(カウンターバランス)", "Diagonal / Counterbalance (R hand)"),
  DIAGONAL_L: mk("DIAGONAL_L", "左手ダイアゴナル(カウンターバランス)", "Diagonal / Counterbalance (L hand)"),
});

/** ムーブ判定閾値(体幹相対座標: 基準単位unit=1, +x=人物の右, +y=体の上 / 角度は度) */
export const DEFAULT_THRESHOLDS = Object.freeze({
  // ヒールフック: 膝が曲がり(35〜135°)、かかと(または足首)が腰の高さ付近(-0.35)以上、かつ足先が膝より下がりすぎていない
  heel_knee_angle: Object.freeze([35.0, 135.0]),
  heel_ankle_vs_knee: -0.45,
  heel_min_rel_y: -0.35,

  // キョン(ドロップニー): 膝を曲げ(50〜140°)、足首より膝が内側へ入り、膝が腰より下
  drop_knee_angle: Object.freeze([50.0, 140.0]),
  drop_knee_lateral: 0.30,
  drop_knee_max_knee_y: 0.0,

  // クロス: 左右の手首が入れ替わる、または片手が体幹中心線を明確に越えて反対側の手と交差する
  cross_midline: 0.20,
  cross_separation: 0.25,

  // フラッギング: 脚を伸ばし(膝135°以上)、体の横へ張り出す
  flag_min_knee_angle: 135.0,
  flag_min_lateral: 1.25,
  flag_ankle_max_rel_y: -0.3,
  flag_ankle_min_rel_y: -2.8,
  flag_min_leg_angle: 32.0,

  // ダイアゴナル: 腕を高く伸ばし、対角の足を低く遠くへ張る
  diag_wrist_min_y: 1.9,
  diag_ankle_max_y: -1.4,
  diag_min_span: 1.2,
  diag_other_wrist_drop: 0.5,
  diag_leg_min_angle: 125.0,

  // カウンターバランス: ダイアゴナルの緩和版。片手を高く伸ばし、逆側の足を横へ出して体を預ける姿勢。
  // フラッギングより先に評価して誤判定を防ぐ。counter_wrist_min_y を Infinity にすると無効(従来挙動)。
  counter_wrist_min_y: 1.6,
  counter_ankle_max_y: -0.6,
  counter_min_span: 1.0,
  counter_other_wrist_drop: 0.35,
  counter_foot_lateral: 0.85,
  counter_leg_min_angle: 125.0,
});

export const MODE = Object.freeze({ HOLDS_ONLY: "HOLDS_ONLY", MOVES_AND_PAUSE: "MOVES_AND_PAUSE" });

export const DEFAULT_CONFIG = Object.freeze({
  app_name: "ムーブ解析by武庫",
  app_name_en: "Move Analysis by Muko",
  mode: MODE.MOVES_AND_PAUSE,
  pause_duration_sec: 1.0,
  pause_cooldown_sec: 2.0,
  model_complexity: 2,
  min_detection_confidence: 0.5,
  min_tracking_confidence: 0.5,
  min_visibility: 0.45,
  ema_alpha: 0.4,
  draw_skeleton: true,
  hold_stop_sec: 0.25,
  hold_speed_thresh: 0.25,
  hold_merge_dist: 0.25,
  max_holds: 4,
  lock_climber: true,
  lock_use_appearance: true,
  lock_max_jump: 1.0,
  lock_close: 0.3,
  lock_scale_range: Object.freeze([0.5, 2.0]),
  lock_roi_scale: 2.2,
  lock_appearance_thresh: 0.2,
  lock_full_frame_sec: 1.0,
  lock_relax_sec: 3.0,
  initial_roi: null,
  move_confirm_sec: 0.20,
  heel_confirm_sec: 0.25,
  flag_confirm_sec: 0.30,
  move_font_size: 44,
  thresholds: DEFAULT_THRESHOLDS,
  min_torso_ratio: 0.03,
  lost_reset_sec: 0.5,
  max_consecutive_errors: 30,
});

/** プロトタイプ汚染を防ぎながら既知のキーのみを安全にマージする */
function safeMerge(base, over) {
  const out = Object.assign(Object.create(null), base);
  if (over && typeof over === "object") {
    for (const k of Object.keys(base)) {
      if (Object.hasOwn(over, k) && over[k] !== undefined) {
        out[k] = over[k];
      }
    }
  }
  return out;
}

export function makeConfig(over = {}) {
  if (over === null || typeof over !== "object" || Array.isArray(over)) {
    throw new Error("設定オブジェクトの形式が不正です");
  }
  const cfg = safeMerge(DEFAULT_CONFIG, over);
  cfg.thresholds = safeMerge(
    DEFAULT_THRESHOLDS,
    over.thresholds && typeof over.thresholds === "object" ? over.thresholds : null
  );
  if (Array.isArray(cfg.thresholds.heel_knee_angle)) {
    cfg.thresholds.heel_knee_angle = Object.freeze([...cfg.thresholds.heel_knee_angle]);
  }
  if (Array.isArray(cfg.thresholds.drop_knee_angle)) {
    cfg.thresholds.drop_knee_angle = Object.freeze([...cfg.thresholds.drop_knee_angle]);
  }
  if (Array.isArray(cfg.lock_scale_range)) {
    cfg.lock_scale_range = Object.freeze([...cfg.lock_scale_range]);
  }
  if (Array.isArray(cfg.initial_roi)) {
    cfg.initial_roi = Object.freeze([...cfg.initial_roi]);
  }
  Object.freeze(cfg.thresholds);
  validateConfig(cfg);
  return Object.freeze(cfg);
}

export function validateConfig(c) {
  const bad = (m) => { throw new Error(m); };
  if (!c || typeof c !== "object") bad("設定オブジェクトが空です");
  if (c.mode !== MODE.HOLDS_ONLY && c.mode !== MODE.MOVES_AND_PAUSE) bad("動作モードの指定が不正です");
  if (!(Number.isFinite(c.ema_alpha) && c.ema_alpha > 0 && c.ema_alpha <= 1)) bad("ema_alpha は (0, 1] で指定してください");
  if (![0, 1, 2].includes(c.model_complexity)) bad("推定精度は 0/1/2 のいずれかです");
  if (!(Number.isFinite(c.min_visibility) && c.min_visibility >= 0 && c.min_visibility <= 1)) bad("min_visibility は 0〜1 で指定してください");
  if (!(Number.isFinite(c.min_detection_confidence) && c.min_detection_confidence >= 0 && c.min_detection_confidence <= 1)) {
    bad("min_detection_confidence は 0〜1 で指定してください");
  }
  if (!(Number.isFinite(c.min_tracking_confidence) && c.min_tracking_confidence >= 0 && c.min_tracking_confidence <= 1)) {
    bad("min_tracking_confidence は 0〜1 で指定してください");
  }
  for (const k of [
    "pause_duration_sec", "pause_cooldown_sec", "hold_stop_sec", "hold_speed_thresh",
    "hold_merge_dist", "move_confirm_sec", "lost_reset_sec", "heel_confirm_sec", "flag_confirm_sec",
  ]) {
    if (!Number.isFinite(c[k]) || c[k] < 0) bad(`${k} は 0 以上の数値で指定してください`);
  }
  if (c.pause_duration_sec > 10) bad("停止秒数は10秒以下にしてください");
  if (c.pause_cooldown_sec > 60) bad("次の停止までは60秒以下にしてください");
  if (!(Number.isFinite(c.lock_max_jump) && c.lock_max_jump > 0 && Number.isFinite(c.lock_close) && c.lock_close >= 0 && c.lock_close <= c.lock_max_jump)) {
    bad("lock_max_jump / lock_close の指定が不正です");
  }
  if (!Array.isArray(c.lock_scale_range) || c.lock_scale_range.length !== 2) bad("lock_scale_range の指定が不正です");
  const [lo, hi] = c.lock_scale_range;
  if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && lo < hi)) bad("lock_scale_range の指定が不正です");
  if (!(Number.isFinite(c.lock_roi_scale) && c.lock_roi_scale >= 1.1)) bad("lock_roi_scale は 1.1 以上です");
  if (!(Number.isFinite(c.lock_appearance_thresh) && c.lock_appearance_thresh >= -1 && c.lock_appearance_thresh <= 1)) {
    bad("lock_appearance_thresh は -1〜1 で指定してください");
  }
  if (!(Number.isFinite(c.lock_full_frame_sec) && c.lock_full_frame_sec >= 0 && Number.isFinite(c.lock_relax_sec) && c.lock_relax_sec > 0)) {
    bad("lock_full_frame_sec / lock_relax_sec の指定が不正です");
  }
  if (c.initial_roi !== null) {
    const r = c.initial_roi;
    if (
      !Array.isArray(r) || r.length !== 4 ||
      !r.every((v) => Number.isFinite(v)) ||
      !(r[0] >= 0 && r[0] < r[2] && r[2] <= 1 && r[1] >= 0 && r[1] < r[3] && r[3] <= 1)
    ) {
      bad("クライマーの範囲の指定が不正です");
    }
  }
  if (!Number.isInteger(c.max_holds) || c.max_holds < 0 || c.max_holds > 1000) {
    bad("赤丸の表示数は 0〜1000 の整数です");
  }
  if (!(Number.isFinite(c.move_font_size) && c.move_font_size >= 10 && c.move_font_size <= 200)) {
    bad("move_font_size は 10〜200 で指定してください");
  }
  if (!(Number.isFinite(c.min_torso_ratio) && c.min_torso_ratio > 0 && c.min_torso_ratio < 1)) {
    bad("min_torso_ratio は (0, 1) で指定してください");
  }
  if (!Number.isInteger(c.max_consecutive_errors) || c.max_consecutive_errors < 1 || c.max_consecutive_errors > 10000) {
    bad("max_consecutive_errors は 1〜10000 の整数で指定してください");
  }

  // 閾値の妥当性検証
  const th = c.thresholds;
  if (!th || typeof th !== "object") bad("thresholds の指定が不正です");
  for (const pairKey of ["heel_knee_angle", "drop_knee_angle"]) {
    const arr = th[pairKey];
    if (!Array.isArray(arr) || arr.length !== 2 || !Number.isFinite(arr[0]) || !Number.isFinite(arr[1]) || arr[0] < 0 || arr[0] > arr[1] || arr[1] > 180) {
      bad(`thresholds.${pairKey} の角度範囲が不正です`);
    }
  }
  for (const [k, v] of Object.entries(th)) {
    if (k === "heel_knee_angle" || k === "drop_knee_angle") continue;
    if (k === "counter_wrist_min_y" && v === Infinity) continue; // カウンター無効化用の Infinity を許可
    if (!Number.isFinite(v)) bad(`thresholds.${k} は有限の数値で指定してください`);
  }
}

export function sanitizeFps(fps) {
  return Number.isFinite(fps) && fps >= 1.0 && fps <= 240.0 ? fps : 30.0;
}

// ---------- 数学ユーティリティ ----------
const isValidPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const norm = (a) => Math.hypot(a[0], a[1]);

export function calcAngle(a, b, c) {
  if (!isValidPt(a) || !isValidPt(b) || !isValidPt(c)) return 0.0;
  const ba = sub(a, b), bc = sub(c, b);
  const nba = norm(ba), nbc = norm(bc);
  if (!(nba >= 1e-5 && nbc >= 1e-5)) return 0.0;
  const cosine = Math.min(1, Math.max(-1, dot(ba, bc) / (nba * nbc)));
  const deg = (Math.acos(cosine) * 180) / Math.PI;
  return Number.isFinite(deg) ? deg : 0.0;
}

export class EMAFilter {
  constructor(alpha) {
    this.alpha = Number.isFinite(alpha) && alpha > 0 && alpha <= 1 ? alpha : 0.4;
    this.value = null;
  }
  update(v) {
    if (!isValidPt(v)) return this.value ? [this.value[0], this.value[1]] : [0, 0];
    if (this.value === null) {
      this.value = [v[0], v[1]];
    } else {
      this.value = [
        this.alpha * v[0] + (1 - this.alpha) * this.value[0],
        this.alpha * v[1] + (1 - this.alpha) * this.value[1],
      ];
    }
    return [this.value[0], this.value[1]];
  }
  reset() { this.value = null; }
}

// ---------- 体幹座標系 ----------
export class BodyFrame {
  constructor(origin, uSpine, uLat, lateralValid, torsoLen, unit) {
    Object.assign(this, { origin, uSpine, uLat, lateralValid, torsoLen, unit });
  }
  toRel(p) {
    if (!isValidPt(p) || !(this.unit > 0)) return [0, 0];
    const d = sub(p, this.origin);
    return [dot(d, this.uLat) / this.unit, dot(d, this.uSpine) / this.unit];
  }
}

export function computeBodyFrame(pts, vis, minTorsoPx) {
  if (!pts || !vis) return null;
  for (const k of ["l_sh", "r_sh", "l_hip", "r_hip"]) {
    if (vis[k] !== true || !isValidPt(pts[k])) return null;
  }
  const origin = [(pts.l_hip[0] + pts.r_hip[0]) / 2, (pts.l_hip[1] + pts.r_hip[1]) / 2];
  const mid = [(pts.l_sh[0] + pts.r_sh[0]) / 2, (pts.l_sh[1] + pts.r_sh[1]) / 2];
  const spine = sub(mid, origin);
  const torso = norm(spine);
  const minPx = Number.isFinite(minTorsoPx) ? Math.max(minTorsoPx, 1.0) : 1.0;
  if (!Number.isFinite(torso) || torso < minPx) return null;
  const uSpine = [spine[0] / torso, spine[1] / torso];

  let lateralValid = false;
  let uLat = [-uSpine[1], uSpine[0]];
  let maxLatSpan = 0;

  for (const [a, b] of [["l_hip", "r_hip"], ["l_sh", "r_sh"]]) {
    let v = sub(pts[b], pts[a]);
    const proj = dot(v, uSpine);
    v = [v[0] - proj * uSpine[0], v[1] - proj * uSpine[1]];
    const n = norm(v);
    if (Number.isFinite(n)) {
      if (n > maxLatSpan) maxLatSpan = n;
      if (!lateralValid && n / torso >= 0.08) {
        uLat = [v[0] / n, v[1] / n];
        lateralValid = true;
      }
    }
  }

  // 従来の torso * 0.6 は実際の骨盤幅の約2倍になり相対座標が縮小されすぎるため、
  // 実測の横幅(腰幅・肩幅)と体幹長をブレンドし torso * 0.32〜0.42 の範囲に安定化させる
  const unit = Math.max(
    Math.min(torso * 0.42, Math.max(torso * 0.32, maxLatSpan * 0.85)),
    1.0
  );
  return new BodyFrame(origin, uSpine, uLat, lateralValid, torso, unit);
}

// ---------- ムーブ判定 ----------
export function makeDetection(move = MoveType.NORMAL, anchor = null, label = "", labelEn = "", color = [255, 255, 255]) {
  const safeAnchor = isValidPt(anchor) ? [anchor[0], anchor[1]] : null;
  return { move: move || MoveType.NORMAL, anchor: safeAnchor, label: String(label), labelEn: String(labelEn), color };
}

export class MoveDetector {
  constructor(th = DEFAULT_THRESHOLDS) {
    this.th = safeMerge(DEFAULT_THRESHOLDS, th);
  }

  detect(pts, vis, body) {
    if (!pts || !vis || !body) return makeDetection();
    const th = this.th;
    const rel = Object.create(null);
    for (const k of Object.keys(pts)) {
      rel[k] = body.toRel(pts[k]);
    }
    const ok = (...names) => names.every((n) => vis[n] === true && isValidPt(pts[n]) && isValidPt(rel[n]));
    const leg = Object.create(null);
    for (const s of ["r", "l"]) {
      if (ok(`${s}_hip`, `${s}_knee`, `${s}_ankle`)) {
        leg[s] = calcAngle(pts[`${s}_hip`], pts[`${s}_knee`], pts[`${s}_ankle`]);
      }
    }

    // 1. ヒールフック (かかとがホールドの陰に隠れて visibility が落ちた場合は足首で代替)
    for (const [s, mv, jp, en] of [
      ["r", MoveType.HEEL_HOOK_R, "右ヒール", "R Heel"],
      ["l", MoveType.HEEL_HOOK_L, "左ヒール", "L Heel"],
    ]) {
      if (leg[s] !== undefined) {
        const ang = leg[s];
        const hasHeel = ok(`${s}_heel`);
        const footRelY = hasHeel ? Math.max(rel[`${s}_heel`][1], rel[`${s}_ankle`][1]) : rel[`${s}_ankle`][1];
        const anchorPt = hasHeel ? pts[`${s}_heel`] : pts[`${s}_ankle`];
        const latDist = Math.abs(rel[`${s}_ankle`][0] - rel[`${s}_hip`][0]);
        if (
          th.heel_knee_angle[0] <= ang && ang <= th.heel_knee_angle[1] &&
          rel[`${s}_ankle`][1] >= rel[`${s}_knee`][1] + th.heel_ankle_vs_knee &&
          footRelY >= th.heel_min_rel_y &&
          latDist >= 0.35
        ) {
          return makeDetection(mv, anchorPt, jp, en, [255, 0, 255]);
        }
      }
    }

    // 1.5 ダイアゴナル / カウンターバランス / フラッギング
    if (body.lateralValid) {
      // ダイアゴナル (厳しい対角条件)
      for (const [hand, foot, mv, dr] of [
        ["r", "l", MoveType.DIAGONAL_R, 1.0],
        ["l", "r", MoveType.DIAGONAL_L, -1.0],
      ]) {
        const other = hand === "r" ? "l" : "r";
        if (leg[foot] !== undefined && ok(`${hand}_wrist`, `${foot}_ankle`)) {
          const [wx, wy] = rel[`${hand}_wrist`];
          const [ax, ay] = rel[`${foot}_ankle`];
          const otherDropOk = !ok(`${other}_wrist`) || rel[`${other}_wrist`][1] <= wy - th.diag_other_wrist_drop;
          if (
            wy >= th.diag_wrist_min_y &&
            ay <= th.diag_ankle_max_y &&
            leg[foot] >= th.diag_leg_min_angle &&
            (wx - ax) * dr >= th.diag_min_span &&
            otherDropOk
          ) {
            return makeDetection(mv, pts[`${hand}_wrist`], "対角", "Diagonal", [0, 160, 255]);
          }
        }
      }

      // カウンターバランス: ダイアゴナルの緩和版。フラッギングより先に評価する
      for (const [hand, foot, mv, dr] of [
        ["r", "l", MoveType.DIAGONAL_R, 1.0],
        ["l", "r", MoveType.DIAGONAL_L, -1.0],
      ]) {
        const other = hand === "r" ? "l" : "r";
        if (leg[foot] !== undefined && ok(`${hand}_wrist`, `${foot}_ankle`)) {
          const [wx, wy] = rel[`${hand}_wrist`];
          const [ax, ay] = rel[`${foot}_ankle`];
          const otherDropOk = !ok(`${other}_wrist`) || rel[`${other}_wrist`][1] <= wy - th.counter_other_wrist_drop;
          if (
            wy >= th.counter_wrist_min_y &&
            ay <= th.counter_ankle_max_y &&
            leg[foot] >= th.counter_leg_min_angle &&
            (wx - ax) * dr >= th.counter_min_span &&
            -ax * dr >= th.counter_foot_lateral &&
            otherDropOk
          ) {
            return makeDetection(mv, pts[`${hand}_wrist`], "カウンター", "Counter", [0, 160, 255]);
          }
        }
      }

      // フラッギング
      for (const [s, mv, jp, en] of [
        ["r", MoveType.FLAG_R, "右フラッグ", "R Flag"],
        ["l", MoveType.FLAG_L, "左フラッグ", "L Flag"],
      ]) {
        if (leg[s] !== undefined) {
          const [ax, ay] = rel[`${s}_ankle`];
          const [hx, hy] = rel[`${s}_hip`];
          const legAngle = (Math.atan2(Math.abs(ax - hx), Math.max(0.1, -(ay - hy))) * 180) / Math.PI;
          if (
            leg[s] >= th.flag_min_knee_angle &&
            Math.abs(ax) >= th.flag_min_lateral &&
            legAngle >= th.flag_min_leg_angle &&
            th.flag_ankle_min_rel_y <= ay && ay <= th.flag_ankle_max_rel_y
          ) {
            return makeDetection(mv, pts[`${s}_ankle`], jp, en, [255, 140, 0]);
          }
        }
      }
    }

    // 3. キョン(ドロップニー) / 4. クロス (左右軸が必要)
    if (body.lateralValid) {
      const [lo, hi] = th.drop_knee_angle;
      if (
        leg.r !== undefined && lo <= leg.r && leg.r <= hi &&
        rel.r_ankle[0] - rel.r_knee[0] > th.drop_knee_lateral &&
        rel.r_knee[1] < th.drop_knee_max_knee_y
      ) {
        return makeDetection(MoveType.DROP_KNEE_R, pts.r_knee, "右キョン", "R Drop Knee", [255, 215, 0]);
      }
      if (
        leg.l !== undefined && lo <= leg.l && leg.l <= hi &&
        rel.l_knee[0] - rel.l_ankle[0] > th.drop_knee_lateral &&
        rel.l_knee[1] < th.drop_knee_max_knee_y
      ) {
        return makeDetection(MoveType.DROP_KNEE_L, pts.l_knee, "左キョン", "L Drop Knee", [255, 215, 0]);
      }

      if (ok("l_wrist", "r_wrist")) {
        const rx = rel.r_wrist[0], lx = rel.l_wrist[0];
        if (lx - rx > th.cross_separation) {
          const rOver = rx < -th.cross_midline ? Math.max(0, -rx - th.cross_midline) : 0;
          const lOver = lx > th.cross_midline ? Math.max(0, lx - th.cross_midline) : 0;
          if (rOver > 0 || lOver > 0) {
            const isROver = rOver >= lOver;
            return makeDetection(
              isROver ? MoveType.CROSS_R_OVER_L : MoveType.CROSS_L_OVER_R,
              isROver ? pts.r_wrist : pts.l_wrist,
              isROver ? "右クロス" : "左クロス",
              isROver ? "R Cross" : "L Cross",
              [255, 200, 100]
            );
          }
        }
      }
    }
    return makeDetection();
  }
}

/**
 * N フレーム連続で同じ判定が続いたとき確定(ヒステリシス)。
 * 実動画での1〜2フレームの推論瞬き(NORMALへの一時的な落ち込み)ではカウントをリセットしない。
 */
export class MoveStabilizer {
  constructor(confirmFrames, overrides = {}) {
    this.confirmFrames = Math.max(1, Math.trunc(Number.isFinite(confirmFrames) ? confirmFrames : 1));
    this.overrides = Object.create(null);
    if (overrides && typeof overrides === "object") {
      for (const [k, v] of Object.entries(overrides)) {
        if (Number.isFinite(v)) this.overrides[k] = Math.max(1, Math.trunc(v));
      }
    }
    this.confirmed = MoveType.NORMAL;
    this._cand = MoveType.NORMAL;
    this._count = 0;
    this._miss = 0;
  }
  update(raw) {
    const mv = raw && typeof raw === "object" && typeof raw.id === "string" ? raw : MoveType.NORMAL;
    if (mv === this.confirmed) {
      this._cand = mv;
      this._count = 0;
      this._miss = 0;
      return false;
    }
    if (mv === this._cand) {
      this._count += 1;
      this._miss = 0;
    } else if (mv === MoveType.NORMAL && this._cand !== MoveType.NORMAL && this._miss < 2) {
      this._miss += 1;
      return false;
    } else {
      this._cand = mv;
      this._count = 1;
      this._miss = 0;
    }
    const need = Object.hasOwn(this.overrides, this._cand.id)
      ? this.overrides[this._cand.id]
      : this.confirmFrames;
    if (this._count >= need) {
      this.confirmed = this._cand;
      this._count = 0;
      this._miss = 0;
      return true;
    }
    return false;
  }
  reset() {
    this.confirmed = this._cand = MoveType.NORMAL;
    this._count = 0;
    this._miss = 0;
  }
}

// ---------- ホールド管理 ----------
export class HoldManager {
  constructor(cfg, fps) {
    this.cfg = cfg;
    this.stopFrames = Math.max(3, pyRound(cfg.hold_stop_sec * sanitizeFps(fps)));
    this.holds = []; // 古い順(末尾が最新)
    this.counters = Object.create(null);
    this.totalRegistered = 0;
    this._nextId = 1;
  }
  update(limb, pos, speedTorso, torsoPx) {
    if (typeof limb !== "string" || !isValidPt(pos) || !Number.isFinite(speedTorso) || !(torsoPx > 0)) return;
    if (speedTorso < this.cfg.hold_speed_thresh) {
      const c = (this.counters[limb] || 0) + 1;
      this.counters[limb] = c;
      if (c === this.stopFrames) this._register(pos, torsoPx);
      else if (c > this.stopFrames) this._touch(pos, torsoPx);
    } else {
      this.counters[limb] = 0;
    }
  }
  resetLimb(limb) {
    if (typeof limb === "string") this.counters[limb] = 0;
  }
  resetCounters() {
    this.counters = Object.create(null);
  }
  _nearest(pos, torsoPx) {
    const merge = this.cfg.hold_merge_dist * torsoPx;
    let best = null, bestD = merge;
    for (const h of this.holds) {
      const d = Math.hypot(h.x - pos[0], h.y - pos[1]);
      if (d < bestD) { best = h; bestD = d; }
    }
    return best;
  }
  _toNewest(hold) {
    const idx = this.holds.indexOf(hold);
    if (idx !== -1) {
      this.holds.splice(idx, 1);
      this.holds.push(hold);
    }
  }
  _touch(pos, torsoPx) {
    if (!isValidPt(pos)) return;
    const h = this._nearest(pos, torsoPx);
    if (h !== null && this.holds[this.holds.length - 1] !== h) this._toNewest(h);
  }
  _register(pos, torsoPx) {
    if (!isValidPt(pos)) return;
    const best = this._nearest(pos, torsoPx);
    if (best === null) {
      this.holds.push({ x: pos[0], y: pos[1], n: 1, id: this._nextId });
      this._nextId += 1;
      this.totalRegistered += 1;
      const limit = this.cfg.max_holds;
      if (limit > 0 && this.holds.length > limit) {
        this.holds.splice(0, this.holds.length - limit);
      }
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
  if (!a || !b || a.length !== b.length || a.length === 0) return 0.0;
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    const va = Number.isFinite(a[i]) ? a[i] : 0;
    const vb = Number.isFinite(b[i]) ? b[i] : 0;
    ma += va;
    mb += vb;
  }
  ma /= n;
  mb /= n;
  let s12 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const va = Number.isFinite(a[i]) ? a[i] : 0;
    const vb = Number.isFinite(b[i]) ? b[i] : 0;
    const da = va - ma, db = vb - mb;
    s12 += da * db;
    s1 += da * da;
    s2 += db * db;
  }
  return Math.abs(s1 * s2) > 2.220446049250313e-16 ? s12 / Math.sqrt(s1 * s2) : 1.0;
}

export class ClimberLock {
  constructor(cfg, fps) {
    const safeFps = sanitizeFps(fps);
    this.cfg = cfg;
    this.locked = false;
    this.center = null;
    this.torso = 0.0;
    this.bbox = null;
    this.hist = null;
    this.missed = 0;
    this._roi = null;
    this.fullFrames = Math.max(1, pyRound(cfg.lock_full_frame_sec * safeFps));
    this.relaxFrames = Math.max(1, pyRound(cfg.lock_relax_sec * safeFps));
  }
  get relax() { return Math.min(1.0, this.missed / this.relaxFrames); }

  accept(c) {
    if (!c || !isValidPt(c.center) || !(c.torso > 0) || !Array.isArray(c.bbox) || c.bbox.length !== 4) {
      return false;
    }
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
    if (!c || !isValidPt(c.center) || !(c.torso > 0) || !Array.isArray(c.bbox) || c.bbox.length !== 4) return;
    let close = false;
    if (this.locked) {
      const d = norm(sub(c.center, this.center)) / Math.max(this.torso, 1e-6);
      close = d <= this.cfg.lock_close;
      this.torso = 0.8 * this.torso + 0.2 * c.torso;
    } else {
      this.torso = c.torso;
    }
    this.center = [c.center[0], c.center[1]];
    this.bbox = [c.bbox[0], c.bbox[1], c.bbox[2], c.bbox[3]];
    if (c.hist && c.hist.length > 0) {
      if (!this.hist || !this.locked || this.hist.length !== c.hist.length) {
        this.hist = Float32Array.from(c.hist);
      } else if (close) {
        const h = new Float32Array(this.hist.length);
        for (let i = 0; i < h.length; i++) h[i] = 0.95 * this.hist[i] + 0.05 * c.hist[i];
        this.hist = h;
      }
    }
    this.locked = true;
    this.missed = 0;
  }

  miss() { if (this.locked) this.missed += 1; }

  /** null なら全画面。戻り値は整数の [x0,y0,x1,y1] */
  roiFor(w, h, tight = false) {
    if (!(w > 0 && h > 0)) return null;
    if (!this.locked) {
      const r = this.cfg.initial_roi;
      if (!r) return null;
      const x0 = Math.max(0, Math.trunc(r[0] * w));
      const y0 = Math.max(0, Math.trunc(r[1] * h));
      const x1 = Math.min(w, Math.max(Math.trunc(r[2] * w), x0 + 32));
      const y1 = Math.min(h, Math.max(Math.trunc(r[3] * h), y0 + 32));
      return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
    }
    if (!tight && this.missed >= this.fullFrames) {
      this._roi = null;
      return null;
    }
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
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// ---------- 服の色ヒストグラム(胴体内側, HSV 18x8) ----------
/** 胴体の内側(縁・背景・腕を避ける)の矩形 [x0,y0,x1,y1](整数)。小さすぎれば null。 */
export function torsoBox(raw, imgW, imgH) {
  if (!raw || !(imgW > 0 && imgH > 0)) return null;
  const ps = [raw.l_sh, raw.r_sh, raw.l_hip, raw.r_hip];
  if (!ps.every(isValidPt)) return null;
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
  const n = Math.trunc(regionW) * Math.trunc(regionH);
  if (!rgba || !(n > 0) || rgba.length < n * 4) return null;
  const hist = new Float32Array(18 * 8);
  let total = 0;
  for (let i = 0; i < n; i++) {
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
    const hBin = Math.max(0, Math.min(17, Math.floor(h180 / 10)));
    const sBin = Math.max(0, Math.min(7, Math.floor(s / 32)));
    hist[hBin * 8 + sBin] += 1;
    total += 1;
  }
  if (total <= 0) return null;
  for (let i = 0; i < hist.length; i++) hist[i] /= total;
  return hist;
}

/** 画像全体の rgba(幅 imgW, 高さ imgH)から計算する版(テスト・小さな画像用)。 */
export function torsoHist(rgba, imgW, imgH, raw) {
  if (!rgba || !(imgW > 0 && imgH > 0) || rgba.length < imgW * imgH * 4) return null;
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
export const LIMBS = Object.freeze(["l_wrist", "r_wrist", "l_ankle", "r_ankle"]);

export class Tracker {
  constructor(cfg, fps) {
    this.cfg = cfg;
    this.detector = new MoveDetector(cfg.thresholds);
    this.reset(fps);
  }

  reset(fps) {
    const cfg = this.cfg;
    this.fps = sanitizeFps(fps);
    this.holdManager = new HoldManager(cfg, this.fps);
    const nf = (sec) => Math.max(2, pyRound(sec * this.fps));
    const heelN = nf(cfg.heel_confirm_sec), flagN = nf(cfg.flag_confirm_sec);
    this.stabilizer = new MoveStabilizer(nf(cfg.move_confirm_sec), {
      HEEL_HOOK_R: heelN, HEEL_HOOK_L: heelN, FLAG_R: flagN, FLAG_L: flagN,
    });
    this.ema = Object.create(null);
    this.prevPts = Object.create(null);
    this.cooldownFrames = 0;
    this.lostFrames = 0;
  }

  resetTracking() {
    for (const f of Object.values(this.ema)) f.reset();
    this.prevPts = Object.create(null);
    this.holdManager.resetCounters();
    this.stabilizer.reset();
  }

  extract(lm, w, h) {
    const pts = Object.create(null), vis = Object.create(null);
    for (const [name, idx] of Object.entries(LM_INDEX)) {
      const node = Array.isArray(lm) && Array.isArray(lm[idx]) ? lm[idx] : null;
      const nx = node ? Number(node[0]) : NaN;
      const ny = node ? Number(node[1]) : NaN;
      const nv = node && node.length > 2 ? Number(node[2]) : 0;
      const raw = [nx * w, ny * h];
      const finite = Number.isFinite(raw[0]) && Number.isFinite(raw[1]);
      const v = finite && Number.isFinite(nv) && nv >= this.cfg.min_visibility;
      const flt = this.ema[name] || (this.ema[name] = new EMAFilter(this.cfg.ema_alpha));
      if (v) pts[name] = flt.update(raw);
      else if (flt.value !== null) pts[name] = [flt.value[0], flt.value[1]];
      else pts[name] = finite ? raw : [0, 0];
      vis[name] = v;
    }
    return { pts, vis };
  }

  /** lm: 全画面の正規化座標 [[x,y,vis]*33] または null。dt は秒。 */
  step(lm, w, h, dt) {
    const cfg = this.cfg;
    const safeW = Number.isFinite(w) && w > 0 ? w : 1;
    const safeH = Number.isFinite(h) && h > 0 ? h : 1;
    const safeDt = Number.isFinite(dt) && dt > 1e-6 ? dt : 1 / this.fps;

    let trigger = false;
    let detection = makeDetection();
    let pts = null, vis = null;

    if (Array.isArray(lm) && lm.length >= LANDMARK_COUNT) {
      this.lostFrames = 0;
      ({ pts, vis } = this.extract(lm, safeW, safeH));
      const body = computeBodyFrame(pts, vis, cfg.min_torso_ratio * Math.min(safeW, safeH));
      for (const limb of LIMBS) {
        if (body !== null && vis[limb]) {
          const prev = this.prevPts[limb];
          if (prev !== undefined) {
            const speed = norm(sub(pts[limb], prev)) / safeDt / Math.max(body.torsoLen, 1e-6);
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
      if (this.lostFrames === Math.max(1, pyRound(cfg.lost_reset_sec * this.fps))) {
        this.resetTracking();
      }
      if (cfg.mode === MODE.MOVES_AND_PAUSE) {
        detection = makeDetection(this.stabilizer.confirmed);
      }
    }
    if (this.cooldownFrames > 0) this.cooldownFrames -= 1;
    return { trigger, detection, pts, vis };
  }
}
