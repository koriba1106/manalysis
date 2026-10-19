/**
 * ムーブ解析by武庫 Web版(ブラウザ完結) — 判定ロジック(DOM非依存・純粋ロジック)
 * Python版 muko_engine.py (v2.8 アルゴリズム) の忠実な移植。座標は [x, y] 配列(px)。
 * Node でもそのまま読み込めるのでテスト可能(tests/ 参照)。
 */

export const VERSION = "4.2.0";
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
  DIAGONAL_R: mk("DIAGONAL_R", "右手ダイアゴナル(カウンターバランス)", "Diagonal / Counterbalance (R hand)"),
  DIAGONAL_L: mk("DIAGONAL_L", "左手ダイアゴナル(カウンターバランス)", "Diagonal / Counterbalance (L hand)"),
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
  // カウンターバランス(v3.1): ダイアゴナルの緩和版。片手を高く伸ばし、逆側の足を横へ出して体を預ける姿勢。
  // フラッギングより先に評価して誤判定を防ぐ。counter_wrist_min_y を Infinity にすると無効(従来挙動)。
  counter_wrist_min_y: 2.0, counter_ankle_max_y: -1.0, counter_min_span: 1.5,
  counter_other_wrist_drop: 0.6, counter_foot_lateral: 1.2, counter_leg_min_angle: 140.0,
  // 左右の軸が取れない(横向き・ねじり)ときもフラッギングを評価するか(足の開き具合は向きに依らないため)
  flag_allow_no_lateral: false,
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
  // v4.2: 実際の動画への耐性(既定は従来と同じ。SENSITIVITY のプロファイルで有効化する)
  min_visibility_torso: null,      // 肩・腰の信頼度の下限(null なら min_visibility)
  min_visibility_limb: null,       // 手首・膝・足首・踵の信頼度の下限(null なら min_visibility)
  vis_hold_sec: 0.0,               // 信頼度が一時的に下がっても、この時間は直前の位置で「見えている」とみなす
  stabilize_ratio: 1.0,            // 1.0=連続Nフレーム(従来)、<1.0=直近の ceil(N/ratio) フレームのうち N フレーム以上
  diagnostics: false,              // 判定の診断(なぜムーブが出ないか)を集計する
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
  for (const k of ["min_visibility_torso", "min_visibility_limb"]) {
    if (c[k] !== null && !(c[k] >= 0 && c[k] <= 1)) bad(`${k} は 0〜1 で指定してください`);
  }
  if (!(c.vis_hold_sec >= 0 && c.vis_hold_sec <= 2)) bad("vis_hold_sec は 0〜2 秒で指定してください");
  if (!(c.stabilize_ratio >= 0.3 && c.stabilize_ratio <= 1)) bad("stabilize_ratio は 0.3〜1 で指定してください");
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

// ---------- ムーブ判定(宣言的なルール表) ----------
export function makeDetection(move = MoveType.NORMAL, anchor = null, label = "", labelEn = "", color = [255, 255, 255]) {
  return { move, anchor, label, labelEn, color };
}

/** 条件1つ。margin は「満たしている余裕」(正=成立、負=不足)。不足の大きさを診断に使う */
const CMP = { ">=": (v, t) => v >= t, "<=": (v, t) => v <= t, ">": (v, t) => v > t, "<": (v, t) => v < t };
const chk = (key, value, op, thr) => ({
  key, value, thr, pass: CMP[op](value, thr),
  margin: op === ">=" || op === ">" ? value - thr : thr - value,
});
const skip = (reason) => ({ status: "skip", reason });                       // 前提(見えている/左右の軸)が足りず評価できない
const evaluated = (checks, det) => ({ status: "eval", checks, pass: checks.every((c) => c.pass), det });

/** 条件の説明(診断の表示用)。unit: "度" は角度、"幅" は骨盤幅を 1 とした長さ */
export const CHECK_INFO = Object.freeze({
  heel_knee_min: { label: "膝の曲げが浅すぎない(角度の下限)", unit: "度" },
  heel_knee_max: { label: "膝がしっかり曲がっている(角度の上限)", unit: "度" },
  heel_vs_knee: { label: "足首が膝より十分高い", unit: "幅" },
  heel_height: { label: "踵が腰の高さ付近まで上がっている", unit: "幅" },
  flag_knee: { label: "足がまっすぐ伸びている(膝の角度)", unit: "度" },
  flag_lateral: { label: "足首が体の中心から横へ十分離れている", unit: "幅" },
  flag_leg_angle: { label: "足が体から十分開いている(角度)", unit: "度" },
  flag_ankle_low: { label: "足首が低すぎない", unit: "幅" },
  flag_ankle_high: { label: "足首が高すぎない", unit: "幅" },
  diag_wrist_high: { label: "手が高く伸びている", unit: "幅" },
  diag_ankle_low: { label: "逆の足首が十分低い", unit: "幅" },
  diag_leg_straight: { label: "その足がまっすぐ(膝の角度)", unit: "度" },
  diag_span: { label: "手と足が横に十分離れている", unit: "幅" },
  diag_other_wrist_low: { label: "もう片方の手が十分低い", unit: "幅" },
  counter_wrist_high: { label: "手が高く伸びている", unit: "幅" },
  counter_ankle_low: { label: "逆の足首が腰より下にある", unit: "幅" },
  counter_leg_straight: { label: "その足がまっすぐ(膝の角度)", unit: "度" },
  counter_span: { label: "手と足が横に十分離れている", unit: "幅" },
  counter_foot_side: { label: "足が手と逆側へ十分出ている", unit: "幅" },
  counter_other_wrist_low: { label: "もう片方の手が低い", unit: "幅" },
  drop_knee_min: { label: "膝の曲げが浅すぎない(角度の下限)", unit: "度" },
  drop_knee_max: { label: "膝がしっかり曲がっている(角度の上限)", unit: "度" },
  drop_lateral: { label: "膝が体の内側へ入り、足首が外へ出ている", unit: "幅" },
  drop_knee_low: { label: "膝が腰より下にある", unit: "幅" },
  cross_sep: { label: "左右の手の位置が逆転している", unit: "幅" },
  cross_over: { label: "手が体の中心線を越えている", unit: "幅" },
  cross_dominant: { label: "こちらの手の方が深く越えている", unit: "幅" },
});

function heelRule(s, move, jp, en, name) {
  return {
    id: move.id, move, name,
    run(c) {
      if (c.leg[s] === undefined || !c.ok(`${s}_heel`)) return skip("visibility");
      const th = c.th, ang = c.leg[s];
      return evaluated([
        chk("heel_knee_min", ang, ">=", th.heel_knee_angle[0]),
        chk("heel_knee_max", ang, "<=", th.heel_knee_angle[1]),
        chk("heel_vs_knee", c.rel[`${s}_ankle`][1], ">=", c.rel[`${s}_knee`][1] + th.heel_ankle_vs_knee),
        chk("heel_height", c.rel[`${s}_heel`][1], ">=", th.heel_min_rel_y),
      ], () => makeDetection(move, c.pts[`${s}_heel`], jp, en, [255, 0, 255]));
    },
  };
}

/** 手と逆側の足で作るダイアゴナル(厳)/カウンターバランス(緩) */
function handFootRule(strict, hand, foot, move, dr, name) {
  const k = strict ? "diag" : "counter";
  return {
    id: `${move.id}#${k}`, move, name,
    run(c) {
      if (!c.body.lateralValid) return skip("lateral");
      const other = hand === "r" ? "l" : "r";
      if (c.leg[foot] === undefined || !c.ok(`${hand}_wrist`, `${other}_wrist`, `${foot}_ankle`)) return skip("visibility");
      const th = c.th;
      const [wx, wy] = c.rel[`${hand}_wrist`];
      const [ax, ay] = c.rel[`${foot}_ankle`];
      const oy = c.rel[`${other}_wrist`][1];
      const p = strict
        ? { wrist: th.diag_wrist_min_y, ankle: th.diag_ankle_max_y, leg: th.diag_leg_min_angle, span: th.diag_min_span, drop: th.diag_other_wrist_drop }
        : { wrist: th.counter_wrist_min_y, ankle: th.counter_ankle_max_y, leg: th.counter_leg_min_angle, span: th.counter_min_span, drop: th.counter_other_wrist_drop };
      const checks = [
        chk(`${k}_wrist_high`, wy, ">=", p.wrist),
        chk(`${k}_ankle_low`, ay, "<=", p.ankle),
        chk(`${k}_leg_straight`, c.leg[foot], ">=", p.leg),
        chk(`${k}_span`, (wx - ax) * dr, ">=", p.span),
      ];
      if (!strict) checks.push(chk("counter_foot_side", -ax * dr, ">=", th.counter_foot_lateral));
      checks.push(chk(`${k}_other_wrist_low`, oy, "<=", wy - p.drop));
      return evaluated(checks, () => makeDetection(move, c.pts[`${hand}_wrist`], strict ? "対角" : "カウンター", strict ? "Diagonal" : "Counter", [0, 160, 255]));
    },
  };
}

function flagRule(s, move, jp, en, name) {
  return {
    id: move.id, move, name,
    run(c) {
      if (!(c.body.lateralValid || c.th.flag_allow_no_lateral)) return skip("lateral");
      if (c.leg[s] === undefined) return skip("visibility");
      const th = c.th;
      const [ax, ay] = c.rel[`${s}_ankle`];
      const [hx, hy] = c.rel[`${s}_hip`];
      const legAngle = (Math.atan2(Math.abs(ax - hx), -(ay - hy)) * 180) / Math.PI;
      return evaluated([
        chk("flag_knee", c.leg[s], ">=", th.flag_min_knee_angle),
        chk("flag_lateral", Math.abs(ax), ">=", th.flag_min_lateral),
        chk("flag_leg_angle", legAngle, ">=", th.flag_min_leg_angle),
        chk("flag_ankle_low", ay, ">=", th.flag_ankle_min_rel_y),
        chk("flag_ankle_high", ay, "<=", th.flag_ankle_max_rel_y),
      ], () => makeDetection(move, c.pts[`${s}_ankle`], jp, en, [255, 140, 0]));
    },
  };
}

function dropRule(s, move, name) {
  return {
    id: move.id, move, name,
    run(c) {
      if (!c.body.lateralValid) return skip("lateral");
      if (c.leg[s] === undefined) return skip("visibility");
      const th = c.th, [lo, hi] = th.drop_knee_angle;
      const lat = s === "r" ? c.rel.r_ankle[0] - c.rel.r_knee[0] : c.rel.l_knee[0] - c.rel.l_ankle[0];
      return evaluated([
        chk("drop_knee_min", c.leg[s], ">=", lo),
        chk("drop_knee_max", c.leg[s], "<=", hi),
        chk("drop_lateral", lat, ">", th.drop_knee_lateral),
        chk("drop_knee_low", c.rel[`${s}_knee`][1], "<", th.drop_knee_max_knee_y),
      ], () => makeDetection(move));
    },
  };
}

function crossRule(rightOverLeft, move, name) {
  return {
    id: move.id, move, name,
    run(c) {
      if (!c.body.lateralValid) return skip("lateral");
      if (!c.ok("l_wrist", "r_wrist")) return skip("visibility");
      const th = c.th, rx = c.rel.r_wrist[0], lx = c.rel.l_wrist[0];
      const rOver = rx < -th.cross_midline ? Math.max(0, -rx - th.cross_midline) : 0;
      const lOver = lx > th.cross_midline ? Math.max(0, lx - th.cross_midline) : 0;
      return evaluated([
        chk("cross_sep", lx - rx, ">", th.cross_separation),
        rightOverLeft ? chk("cross_over", rOver, ">", 0) : chk("cross_over", lOver, ">", 0),
        rightOverLeft ? chk("cross_dominant", rOver, ">=", lOver) : chk("cross_dominant", lOver, ">", rOver),
      ], () => makeDetection(move));
    },
  };
}

/** 評価の順序(最初に成立したものを採用)。従来の if の連なりと同じ順 */
export const RULES = Object.freeze([
  heelRule("r", MoveType.HEEL_HOOK_R, "右ヒール", "R Heel", "右ヒールフック"),
  heelRule("l", MoveType.HEEL_HOOK_L, "左ヒール", "L Heel", "左ヒールフック"),
  handFootRule(true, "r", "l", MoveType.DIAGONAL_R, 1.0, "右手ダイアゴナル(厳)"),
  handFootRule(true, "l", "r", MoveType.DIAGONAL_L, -1.0, "左手ダイアゴナル(厳)"),
  handFootRule(false, "r", "l", MoveType.DIAGONAL_R, 1.0, "右手カウンターバランス"),
  handFootRule(false, "l", "r", MoveType.DIAGONAL_L, -1.0, "左手カウンターバランス"),
  flagRule("r", MoveType.FLAG_R, "右フラッグ", "R Flag", "右フラッギング"),
  flagRule("l", MoveType.FLAG_L, "左フラッグ", "L Flag", "左フラッギング"),
  dropRule("r", MoveType.DROP_KNEE_R, "右キョン"),
  dropRule("l", MoveType.DROP_KNEE_L, "左キョン"),
  crossRule(true, MoveType.CROSS_R_OVER_L, "右手クロス"),
  crossRule(false, MoveType.CROSS_L_OVER_R, "左手クロス"),
]);

export class MoveDetector {
  constructor(th = DEFAULT_THRESHOLDS) { this.th = th; }

  /** 全ルールを評価する。detection は最初に成立したもの(なければ通常登攀)。results は診断用 */
  evaluate(pts, vis, body) {
    const rel = {};
    for (const k of Object.keys(pts)) rel[k] = body.toRel(pts[k]);
    const ok = (...names) => names.every((n) => vis[n] === true);
    const leg = {};
    for (const s of ["r", "l"]) {
      if (ok(`${s}_hip`, `${s}_knee`, `${s}_ankle`)) leg[s] = calcAngle(pts[`${s}_hip`], pts[`${s}_knee`], pts[`${s}_ankle`]);
    }
    const c = { pts, rel, vis, leg, body, th: this.th, ok };
    const results = [];
    let detection = null;
    for (const rule of RULES) {
      const r = rule.run(c);
      results.push({ rule, ...r });
      if (detection === null && r.status === "eval" && r.pass) detection = r.det();
    }
    return { detection: detection || makeDetection(), results };
  }

  detect(pts, vis, body) { return this.evaluate(pts, vis, body).detection; }
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

/**
 * 揺らぎに強い確定。実際の骨格はしきい値付近で 1〜2 フレーム揺れるため、「連続 N フレーム」だと
 * 1 回途切れるだけで数え直しになる。直近 ceil(N/ratio) フレームのうち N フレーム以上が同じ判定で、
 * かつ現在のフレームもそうであれば確定する(ratio=1 なら従来の「連続 N フレーム」と同じ)。
 * 確定した状態から抜けるときも同じ基準で、1〜2 フレームの途切れでは解除されない。
 */
export class TolerantStabilizer {
  constructor(confirmFrames, overrides = {}, ratio = 0.7) {
    this.confirmFrames = Math.max(1, Math.trunc(confirmFrames));
    this.overrides = {};
    for (const [k, v] of Object.entries(overrides)) this.overrides[k] = Math.max(1, Math.trunc(v));
    this.ratio = Math.min(1, Math.max(0.3, ratio));
    const maxNeed = Math.max(this.confirmFrames, ...Object.values(this.overrides));
    this._cap = Math.ceil(maxNeed / this.ratio) + 1;
    this.confirmed = MoveType.NORMAL; this._hist = [];
  }
  update(raw) {
    this._hist.push(raw);
    if (this._hist.length > this._cap) this._hist.shift();
    if (raw === this.confirmed) return false;
    const need = this.overrides[raw.id] !== undefined ? this.overrides[raw.id] : this.confirmFrames;
    const win = Math.ceil(need / this.ratio);
    let n = 0;
    for (let i = this._hist.length - 1, left = win; i >= 0 && left > 0; i--, left--) if (this._hist[i] === raw) n++;
    if (n >= need) { this.confirmed = raw; return true; }
    return false;
  }
  reset() { this.confirmed = MoveType.NORMAL; this._hist = []; }
}

// ---------- 判定の診断("なぜムーブが出ないか"を動画のデータで見る) ----------
const JOINT_NAMES = Object.freeze({
  l_sh: "左肩", r_sh: "右肩", l_hip: "左腰", r_hip: "右腰", l_wrist: "左手首", r_wrist: "右手首",
  l_knee: "左膝", r_knee: "右膝", l_ankle: "左足首", r_ankle: "右足首", l_heel: "左踵", r_heel: "右踵",
});
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

const NEAR_ANGLE = 25, NEAR_LENGTH = 0.8;      // 診断で「惜しい」とみなす不足の上限(度 / 骨盤幅)

export class Diagnostics {
  constructor() {
    this.frames = 0; this.poseFrames = 0; this.torsoFrames = 0; this.lateralFrames = 0;
    this.joint = {}; for (const k of Object.keys(JOINT_NAMES)) this.joint[k] = 0;
    this.rules = {};
  }
  /** 1 フレームの骨格の状況。vis/body は骨格が取れたときだけ渡す */
  frame(hasPose, vis, body) {
    this.frames += 1;
    if (!hasPose) return;
    this.poseFrames += 1;
    for (const k of Object.keys(JOINT_NAMES)) if (vis[k]) this.joint[k] += 1;
    if (body) { this.torsoFrames += 1; if (body.lateralValid) this.lateralFrames += 1; }
  }
  /** ルールごとの結果(MoveDetector.evaluate の results)を集計 */
  record(results) {
    for (const r of results) {
      const s = this.rules[r.rule.id + "|" + r.rule.name] || (this.rules[r.rule.id + "|" + r.rule.name] =
        { name: r.rule.name, evaluated: 0, passed: 0, skipVisibility: 0, skipLateral: 0, near: {}, near2: {}, fails: {} });
      if (r.status === "skip") { if (r.reason === "lateral") s.skipLateral += 1; else s.skipVisibility += 1; continue; }
      s.evaluated += 1;
      if (r.pass) { s.passed += 1; continue; }
      const failed = r.checks.filter((c) => !c.pass);
      for (const c of failed) s.fails[c.key] = (s.fails[c.key] || 0) + 1;
      // 「惜しい」= 不足が 1〜2 条件で、しかも不足の大きさが小さい(角度は 25 度以内、長さは骨盤幅の 0.8 以内)。
      // 個数だけで数えると、姿勢がかけ離れているものまで「惜しい」に入ってしまう
      const close = failed.every((c) => -c.margin <= (CHECK_INFO[c.key] && CHECK_INFO[c.key].unit === "度" ? NEAR_ANGLE : NEAR_LENGTH));
      if ((failed.length === 1 || failed.length === 2) && close) {   // あと 1〜2 条件で成立していたフレーム
        const bucket = failed.length === 1 ? s.near : s.near2;
        for (const c of failed) {
          const n = bucket[c.key] || (bucket[c.key] = { n: 0, margins: [] });
          n.n += 1;
          if (n.margins.length < 1500) n.margins.push(c.margin);
        }
      }
    }
  }
  summary() {
    const pct = (a, b) => (b > 0 ? Math.round((1000 * a) / b) / 10 : 0);
    const rules = Object.values(this.rules).map((s) => ({
      name: s.name, evaluated: s.evaluated, passed: s.passed,
      skipVisibility: s.skipVisibility, skipLateral: s.skipLateral,
      nearMisses: Object.entries(s.near).map(([key, v]) => ({ key, n: v.n, medianMargin: median(v.margins) }))
        .sort((a, b) => b.n - a.n).slice(0, 3),
      near2Misses: Object.entries(s.near2).map(([key, v]) => ({ key, n: v.n, medianMargin: median(v.margins) }))
        .sort((a, b) => b.n - a.n).slice(0, 3),
      topFails: Object.entries(s.fails).map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n).slice(0, 3),
    }));
    return {
      frames: this.frames, poseFrames: this.poseFrames, torsoFrames: this.torsoFrames, lateralFrames: this.lateralFrames,
      posePct: pct(this.poseFrames, this.frames), torsoPct: pct(this.torsoFrames, this.poseFrames),
      lateralPct: pct(this.lateralFrames, this.torsoFrames),
      joints: Object.entries(JOINT_NAMES).map(([k, name]) => ({ key: k, name, pct: pct(this.joint[k], this.poseFrames) })),
      rules,
    };
  }
}

// ---------- 判定の感度(プロファイル) ----------
/**
 * standard : 従来どおり(v4.1 までの設定。照合テストの基準)
 * relaxed  : 実際の動画向けに緩めた設定(推奨)。しきい値の緩和に加え、骨格の揺らぎ・一時的な見えなさ・
 *            横向きにも強くする(信頼度の下限を下げる、短い見えなさは直前の位置で補う、連続でなくても確定、
 *            左右の軸が取れないときもフラッギングは評価)
 * loose    : さらに緩める。見逃しは減るが、普通の動きをムーブと誤認しやすくなる
 */
export const SENSITIVITY = Object.freeze({
  standard: Object.freeze({ label: "標準(従来)", thresholds: {}, config: {} }),
  relaxed: Object.freeze({
    label: "ゆるめ(推奨)",
    thresholds: {
      heel_knee_angle: [30.0, 125.0], heel_ankle_vs_knee: -0.5, heel_min_rel_y: -0.5,
      drop_knee_angle: [55.0, 130.0], drop_knee_lateral: 0.3, drop_knee_max_knee_y: 0.0,
      cross_midline: 0.3, cross_separation: 0.3,
      flag_min_knee_angle: 145.0, flag_min_lateral: 1.5, flag_ankle_max_rel_y: -0.5, flag_ankle_min_rel_y: -2.3,
      flag_min_leg_angle: 35.0, flag_allow_no_lateral: true,
      diag_wrist_min_y: 2.4, diag_ankle_max_y: -2.0, diag_min_span: 1.4, diag_other_wrist_drop: 0.8, diag_leg_min_angle: 125.0,
      counter_wrist_min_y: 1.6, counter_ankle_max_y: -0.7, counter_min_span: 1.2, counter_other_wrist_drop: 0.4,
      counter_foot_lateral: 0.9, counter_leg_min_angle: 130.0,
    },
    config: {
      min_visibility_torso: 0.5, min_visibility_limb: 0.4, vis_hold_sec: 0.3, stabilize_ratio: 0.7,
      move_confirm_sec: 0.2, heel_confirm_sec: 0.25, flag_confirm_sec: 0.3,
    },
  }),
  loose: Object.freeze({
    label: "かなりゆるめ(誤検出が増えます)",
    thresholds: {
      heel_knee_angle: [25.0, 140.0], heel_ankle_vs_knee: -0.8, heel_min_rel_y: -0.8,
      drop_knee_angle: [50.0, 140.0], drop_knee_lateral: 0.2, drop_knee_max_knee_y: 0.3,
      cross_midline: 0.2, cross_separation: 0.2,
      flag_min_knee_angle: 135.0, flag_min_lateral: 1.2, flag_ankle_max_rel_y: 0.0, flag_ankle_min_rel_y: -2.5,
      flag_min_leg_angle: 25.0, flag_allow_no_lateral: true,
      diag_wrist_min_y: 2.2, diag_ankle_max_y: -1.6, diag_min_span: 1.2, diag_other_wrist_drop: 0.6, diag_leg_min_angle: 120.0,
      counter_wrist_min_y: 1.3, counter_ankle_max_y: -0.4, counter_min_span: 1.0, counter_other_wrist_drop: 0.3,
      counter_foot_lateral: 0.7, counter_leg_min_angle: 120.0,
    },
    config: {
      min_visibility_torso: 0.4, min_visibility_limb: 0.3, vis_hold_sec: 0.4, stabilize_ratio: 0.6,
      move_confirm_sec: 0.15, heel_confirm_sec: 0.2, flag_confirm_sec: 0.25,
    },
  }),
});

/** プロファイルから makeConfig に渡す上書きを作る。counter=false ならカウンターバランスの区別を無効にする */
export function profileOverrides(name, { counter = true } = {}) {
  const p = SENSITIVITY[name] || SENSITIVITY.standard;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...p.thresholds };
  if (!counter) thresholds.counter_wrist_min_y = Infinity;
  return { ...p.config, thresholds };
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

const TORSO_NAMES = new Set(["l_sh", "r_sh", "l_hip", "r_hip"]);

export class Tracker {
  constructor(cfg, fps) {
    this.cfg = cfg; this.detector = new MoveDetector(cfg.thresholds);
    this.diag = cfg.diagnostics ? new Diagnostics() : null;
    this.reset(fps);
  }

  reset(fps) {
    const cfg = this.cfg;
    this.fps = fps;
    this.holdManager = new HoldManager(cfg, fps);
    const nf = (sec) => Math.max(2, pyRound(sec * fps));
    const heelN = nf(cfg.heel_confirm_sec), flagN = nf(cfg.flag_confirm_sec);
    const overrides = { HEEL_HOOK_R: heelN, HEEL_HOOK_L: heelN, FLAG_R: flagN, FLAG_L: flagN };
    this.stabilizer = cfg.stabilize_ratio < 1
      ? new TolerantStabilizer(nf(cfg.move_confirm_sec), overrides, cfg.stabilize_ratio)
      : new MoveStabilizer(nf(cfg.move_confirm_sec), overrides);
    this.torsoVis = cfg.min_visibility_torso !== null ? cfg.min_visibility_torso : cfg.min_visibility;
    this.limbVis = cfg.min_visibility_limb !== null ? cfg.min_visibility_limb : cfg.min_visibility;
    this.visHoldFrames = pyRound(cfg.vis_hold_sec * fps);
    this.frameNo = 0;
    this.lastVisible = {};
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
      const v = finite && node[2] >= (TORSO_NAMES.has(name) ? this.torsoVis : this.limbVis);
      const flt = this.ema[name] || (this.ema[name] = new EMAFilter(this.cfg.ema_alpha));
      if (v) { pts[name] = [...flt.update(raw)]; this.lastVisible[name] = this.frameNo; }
      else if (flt.value !== null) pts[name] = [...flt.value];
      else pts[name] = finite ? raw : [0, 0];
      // 信頼度が一時的に下がっただけなら、直前の(平滑化済みの)位置で「見えている」とみなす
      const held = !v && this.visHoldFrames > 0 && flt.value !== null
        && this.lastVisible[name] !== undefined && this.frameNo - this.lastVisible[name] <= this.visHoldFrames;
      vis[name] = v || held;
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
      if (this.diag) this.diag.frame(true, vis, body);
      if (cfg.mode === MODE.MOVES_AND_PAUSE) {
        let raw = makeDetection();
        if (body !== null) {
          const ev = this.detector.evaluate(pts, vis, body);
          raw = ev.detection;
          if (this.diag) this.diag.record(ev.results);
        }
        const changed = this.stabilizer.update(raw.move);
        if (changed && this.stabilizer.confirmed !== MoveType.NORMAL && this.cooldownFrames === 0) {
          trigger = true;
          this.cooldownFrames = pyRound(this.fps * cfg.pause_cooldown_sec);
        }
        detection = raw.move === this.stabilizer.confirmed ? raw : makeDetection(this.stabilizer.confirmed);
      }
    } else {
      if (this.diag) this.diag.frame(false, null, null);
      this.lostFrames += 1;
      if (this.lostFrames === Math.max(1, pyRound(cfg.lost_reset_sec * this.fps))) this.resetTracking();
      if (cfg.mode === MODE.MOVES_AND_PAUSE) detection = makeDetection(this.stabilizer.confirmed);
    }
    this.frameNo += 1;
    if (this.cooldownFrames > 0) this.cooldownFrames -= 1;   // Python版は1フレーム書き出し後に減算
    return { trigger, detection, pts, vis };
  }
}
