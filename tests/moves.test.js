// ムーブ判定の再構成(ルール表・感度プロファイル・揺らぎ耐性・診断)のテスト
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS, Diagnostics, MODE, MoveDetector, MoveStabilizer, MoveType, RULES, SENSITIVITY, TolerantStabilizer,
  Tracker, computeBodyFrame, makeConfig, profileOverrides,
} from "../docs/js/core.js";

const U = 60, W = 640, H = 480;
const IDX = { l_sh: 11, r_sh: 12, l_hip: 23, r_hip: 24, l_wrist: 15, r_wrist: 16, l_knee: 25, r_knee: 26, l_ankle: 27, r_ankle: 28, l_heel: 29, r_heel: 30 };
const BASE = { l_sh: [-.5, 1.667], r_sh: [.5, 1.667], l_hip: [-.5, 0], r_hip: [.5, 0], l_wrist: [-.8, 2.6], r_wrist: [.8, 2.6],
  l_knee: [-.5, -1], r_knee: [.5, -1], l_ankle: [-.5, -2], r_ankle: [.5, -2], l_heel: [-.5, -2.1], r_heel: [.5, -2.1] };
const pose = (over) => ({ ...BASE, ...over });

function ptsVis(rel, visOver = {}) {
  const pts = {}, vis = {};
  for (const k of Object.keys(IDX)) { pts[k] = [320 - rel[k][0] * U, 300 - rel[k][1] * U]; vis[k] = visOver[k] !== false; }
  return { pts, vis };
}
function detectWith(rel, profile, opts = {}) {
  const cfg = makeConfig(profileOverrides(profile, opts));
  const { pts, vis } = ptsVis(rel);
  const body = computeBodyFrame(pts, vis, 5);
  return new MoveDetector(cfg.thresholds).detect(pts, vis, body).move;
}
/** 骨格の 33 点(全画面の正規化座標)。vis は関節名ごとの信頼度の上書き */
function landmarks(rel, visOver = {}) {
  const lm = Array.from({ length: 33 }, () => [0.5, 0.2, 0.99]);
  for (const [k, i] of Object.entries(IDX)) lm[i] = [(320 - rel[k][0] * U) / W, (300 - rel[k][1] * U) / H, visOver[k] !== undefined ? visOver[k] : 0.99];
  return lm;
}

// 実際の動画では「条件のすぐ手前」で終わる弱い姿勢が多い
const WEAK_HEEL_R = pose({ r_knee: [1.0, -.8], r_ankle: [1.7, -.55], r_heel: [1.75, -.35] });          // 踵が腰より 0.35 低い
const WEAK_FLAG_L = pose({ l_knee: [-1.2, -.7], l_ankle: [-2.0, -1.6], l_heel: [-2.05, -1.7] });       // 横への出が 2.0(従来は 2.2 以上)
const WEAK_DROP_R = pose({ r_knee: [.3, -1.0], r_ankle: [.7, -1.3], r_heel: [.75, -1.4] });            // 足首の外への出が 0.4(従来は 0.5 超)
const WEAK_CROSS = pose({ r_wrist: [-.4, 2.6], l_wrist: [.4, 2.6] });                                  // 中心線を越える量が小さい

// 普通の登りの姿勢(ムーブとして停止させたくないもの)
const NORMAL_POSES = {
  "ぶら下がり": BASE,
  "片手を伸ばして次のホールドへ": pose({ r_wrist: [.6, 3.2], l_wrist: [-.6, 2.0] }),
  "ハイステップ(足は膝よりかなり下)": pose({ l_knee: [-.9, -.1], l_ankle: [-.7, -1.2], l_heel: [-.75, -1.3] }),
  "足を少し開いて立つ": pose({ l_ankle: [-1.3, -2.0], r_ankle: [1.3, -2.0], l_heel: [-1.3, -2.1], r_heel: [1.3, -2.1] }),
  "両手が同じ高さで足は真下": pose({ l_wrist: [-.7, 2.7], r_wrist: [.7, 2.7] }),
};

test("従来の設定(標準)では弱い姿勢はムーブにならない / ゆるめでは拾える", () => {
  const cases = [[WEAK_HEEL_R, MoveType.HEEL_HOOK_R], [WEAK_FLAG_L, MoveType.FLAG_L], [WEAK_DROP_R, MoveType.DROP_KNEE_R], [WEAK_CROSS, MoveType.CROSS_R_OVER_L]];
  for (const [rel, expected] of cases) {
    // 標準では期待したムーブにならない(通常登攀のままか、条件を満たす別のムーブ。
    // 例: 踵が低いヒールフックは、膝が下がり足首が外へ出ているため標準では「キョン」と判定される)
    assert.notEqual(detectWith(rel, "standard"), expected, `標準でも ${expected.id} と判定された`);
    assert.equal(detectWith(rel, "relaxed"), expected);
    assert.equal(detectWith(rel, "loose"), expected);
  }
  assert.equal(detectWith(WEAK_HEEL_R, "standard"), MoveType.DROP_KNEE_R);      // 上記の実例
  for (const rel of [WEAK_FLAG_L, WEAK_CROSS]) assert.equal(detectWith(rel, "standard"), MoveType.NORMAL);
});

test("誤検出の歯止め: 普通の動きは「ゆるめ」でもムーブにならない", () => {
  for (const [name, rel] of Object.entries(NORMAL_POSES)) {
    assert.equal(detectWith(rel, "standard"), MoveType.NORMAL, `標準: ${name}`);
    assert.equal(detectWith(rel, "relaxed"), MoveType.NORMAL, `ゆるめ: ${name}`);
  }
});

test("横向き(左右の軸が取れない)でも、ゆるめではフラッギングを評価する", () => {
  // 骨盤・肩の幅がほぼ 0 の横向き。足は体の中心から大きく離れて伸びている
  const side = pose({ l_sh: [-.02, 1.667], r_sh: [.02, 1.667], l_hip: [-.02, 0], r_hip: [.02, 0],
    l_knee: [-1.2, -.7], l_ankle: [-2.0, -1.6], l_heel: [-2.05, -1.7] });
  const { pts, vis } = ptsVis(side);
  const body = computeBodyFrame(pts, vis, 5);
  assert.equal(body.lateralValid, false);
  assert.equal(detectWith(side, "standard"), MoveType.NORMAL);
  assert.equal(detectWith(side, "relaxed"), MoveType.FLAG_L);
});

test("ルール表: 順序・名前・全ムーブを網羅している", () => {
  const ids = new Set(RULES.map((r) => r.move.id));
  for (const m of Object.values(MoveType)) if (m !== MoveType.NORMAL) assert.ok(ids.has(m.id), `${m.id} のルールがありません`);
  assert.equal(RULES.length, 12);
  assert.ok(RULES.every((r) => typeof r.name === "string" && r.name.length > 0));
  assert.equal(RULES[0].move, MoveType.HEEL_HOOK_R);                       // ヒールフックが最優先(従来どおり)
});

test("感度プロファイル: 設定として妥当で、緩め方が単調(標準 < ゆるめ < かなりゆるめ)", () => {
  for (const name of Object.keys(SENSITIVITY)) makeConfig(profileOverrides(name));      // 検証を通る
  const t = (n) => ({ ...DEFAULT_THRESHOLDS, ...SENSITIVITY[n].thresholds });
  const [s, r, l] = [t("standard"), t("relaxed"), t("loose")];
  assert.ok(s.flag_min_lateral > r.flag_min_lateral && r.flag_min_lateral > l.flag_min_lateral);
  assert.ok(s.heel_min_rel_y > r.heel_min_rel_y && r.heel_min_rel_y > l.heel_min_rel_y);
  assert.ok(s.drop_knee_lateral > r.drop_knee_lateral && r.drop_knee_lateral > l.drop_knee_lateral);
  assert.ok(s.cross_midline > r.cross_midline && r.cross_midline > l.cross_midline);
  assert.equal(profileOverrides("relaxed", { counter: false }).thresholds.counter_wrist_min_y, Infinity);
  assert.equal(profileOverrides("standard").thresholds.counter_wrist_min_y, DEFAULT_THRESHOLDS.counter_wrist_min_y);
});

// ---------- 揺らぎへの強さ ----------
const H1 = MoveType.HEEL_HOOK_R, N = MoveType.NORMAL;
const run = (st, seq) => seq.map((m) => st.update(m)).findIndex(Boolean);

test("確定: 連続でないと従来は確定しない / 揺らぎに強い方は確定する", () => {
  // ヒール判定が 7 割、1〜2 フレームずつ途切れる(実際の骨格のしきい値付近の揺らぎ)
  const flicker = [];
  for (let i = 0; i < 10; i++) flicker.push(H1, H1, H1, N, H1, H1, N);
  assert.equal(run(new MoveStabilizer(8), flicker), -1, "従来の方式は途切れで数え直しになる");
  assert.ok(run(new TolerantStabilizer(8, {}, 0.7), flicker) >= 0, "揺らぎに強い方式は確定する");
  // 判定が 4 割しか続かないなら確定しない(誤検出を増やさない)
  const sparse = []; for (let i = 0; i < 20; i++) sparse.push(H1, N, N, H1, N);
  assert.equal(run(new TolerantStabilizer(8, {}, 0.7), sparse), -1);
});

test("確定: ratio=1 なら従来の「連続Nフレーム」と全く同じ", () => {
  const rnd = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const moves = [N, H1, MoveType.FLAG_L, MoveType.DROP_KNEE_R];
  for (let trial = 0; trial < 50; trial++) {
    const a = new MoveStabilizer(5, { HEEL_HOOK_R: 8 }), b = new TolerantStabilizer(5, { HEEL_HOOK_R: 8 }, 1.0);
    for (let i = 0; i < 200; i++) {
      const m = rnd() < 0.7 ? moves[Math.floor(rnd() * 2)] : moves[Math.floor(rnd() * 4)];
      assert.equal(b.update(m), a.update(m), `trial ${trial} frame ${i}`);
      assert.equal(b.confirmed, a.confirmed);
    }
  }
});

test("確定済みのムーブは、1〜2 フレームの途切れでは解除されない", () => {
  const st = new TolerantStabilizer(8, {}, 0.7);
  for (let i = 0; i < 12; i++) st.update(H1);
  assert.equal(st.confirmed, H1);
  for (const m of [N, N, H1, H1, N, H1, H1, H1]) st.update(m);
  assert.equal(st.confirmed, H1);
  for (let i = 0; i < 12; i++) st.update(N);              // 本当に終わったら解除される
  assert.equal(st.confirmed, N);
});

test("信頼度が一時的に下がっても、直前の位置で補う(ゆるめ)/ 従来は見えない扱い", () => {
  const fps = 30;
  const make = (profile) => new Tracker(makeConfig({ ...profileOverrides(profile), diagnostics: true }), fps);
  for (const [profile, expectVisible] of [["standard", false], ["relaxed", true]]) {
    const tr = make(profile);
    for (let i = 0; i < 10; i++) tr.step(landmarks(WEAK_HEEL_R), W, H, 1 / fps);
    const r = tr.step(landmarks(WEAK_HEEL_R, { r_heel: 0.1, r_ankle: 0.1 }), W, H, 1 / fps);   // 1 フレームだけ信頼度が落ちる
    assert.equal(r.vis.r_heel, expectVisible, profile);
  }
  // 補うのは短い間だけ: 長く見えなければ「見えない」に戻る
  const tr = make("relaxed");
  for (let i = 0; i < 10; i++) tr.step(landmarks(WEAK_HEEL_R), W, H, 1 / fps);
  let r;
  for (let i = 0; i < 30; i++) r = tr.step(landmarks(WEAK_HEEL_R, { r_heel: 0.05 }), W, H, 1 / fps);
  assert.equal(r.vis.r_heel, false);
});

test("信頼度の下限を胴体と手足で別に設定できる(ゆるめ: 胴体 0.5 / 手足 0.4)", () => {
  const fps = 30;
  const tr = new Tracker(makeConfig(profileOverrides("relaxed")), fps);
  const r = tr.step(landmarks(BASE, { r_ankle: 0.45, r_sh: 0.45 }), W, H, 1 / fps);
  assert.equal(r.vis.r_ankle, true);        // 手足は 0.4 以上で見えている扱い
  assert.equal(r.vis.r_sh, false);          // 胴体は 0.5 以上が必要
});

// ---------- 診断 ----------
test("診断: 弱いヒールフックの姿勢を「あと1条件(踵の高さ)」として集計できる", () => {
  const fps = 30;
  const tr = new Tracker(makeConfig({ diagnostics: true }), fps);        // 標準
  for (let i = 0; i < 60; i++) tr.step(landmarks(WEAK_HEEL_R), W, H, 1 / fps);
  tr.step(null, W, H, 1 / fps);                                           // 骨格なしのフレームも数える
  const s = tr.diag.summary();
  assert.equal(s.frames, 61); assert.equal(s.poseFrames, 60);
  assert.equal(s.torsoPct, 100); assert.equal(s.lateralPct, 100);
  const heel = s.rules.find((r) => r.name === "右ヒールフック");
  assert.equal(heel.passed, 0);
  assert.ok(heel.evaluated >= 55);
  assert.equal(heel.nearMisses[0].key, "heel_height");
  assert.ok(heel.nearMisses[0].n >= 55);
  assert.ok(Math.abs(heel.nearMisses[0].medianMargin - (-0.25)) < 0.08, `不足の中央値 ${heel.nearMisses[0].medianMargin}`);   // -0.35 に対し成立ラインが -0.10
  // 同じ姿勢を「ゆるめ」で見ると、成立としてカウントされる
  const tr2 = new Tracker(makeConfig({ ...profileOverrides("relaxed"), diagnostics: true }), fps);
  for (let i = 0; i < 60; i++) tr2.step(landmarks(WEAK_HEEL_R), W, H, 1 / fps);
  assert.ok(tr2.diag.summary().rules.find((r) => r.name === "右ヒールフック").passed > 50);
});

test("診断: 不足が2条件のムーブ(弱いフラッギング)は「あと2条件」として、不足している条件が分かる", () => {
  const tr = new Tracker(makeConfig({ diagnostics: true }), 30);          // 標準
  for (let i = 0; i < 60; i++) tr.step(landmarks(WEAK_FLAG_L), W, H, 1 / 30);
  const flag = tr.diag.summary().rules.find((r) => r.name === "左フラッギング");
  assert.equal(flag.passed, 0);
  assert.deepEqual(flag.nearMisses, []);                                   // あと1条件ではない
  const keys = flag.near2Misses.map((m) => m.key).sort();
  assert.deepEqual(keys, ["flag_lateral", "flag_leg_angle"]);              // 横への出 と 足の開き が不足
  assert.ok(flag.near2Misses.every((m) => m.n >= 55), "ぶら下がり(かけ離れた姿勢)は惜しいに入らない");
  const right = tr.diag.summary().rules.find((r) => r.name === "右フラッギング");
  assert.equal(right.near2Misses.length + right.nearMisses.length, 0, "足が真下の右足は惜しくない");
  const lateral = flag.near2Misses.find((m) => m.key === "flag_lateral");
  assert.ok(Math.abs(lateral.medianMargin - (2.0 - 2.2)) < 0.05, `横への出の不足 ${lateral.medianMargin}`);   // 2.0 に対し 2.2 が必要
});

test("診断: 横向きでは「左右の軸が使えない」として評価できなかった数を数える", () => {
  const side = pose({ l_sh: [-.02, 1.667], r_sh: [.02, 1.667], l_hip: [-.02, 0], r_hip: [.02, 0] });
  const tr = new Tracker(makeConfig({ diagnostics: true }), 30);
  for (let i = 0; i < 20; i++) tr.step(landmarks(side), W, H, 1 / 30);
  const s = tr.diag.summary();
  assert.equal(s.lateralPct, 0);
  assert.ok(s.rules.find((r) => r.name === "右キョン").skipLateral >= 19);
});

test("診断は既定では無効(従来の処理に影響しない)/ ホールドのみモードではルールを集計しない", () => {
  assert.equal(new Tracker(makeConfig(), 30).diag, null);
  const tr = new Tracker(makeConfig({ mode: MODE.HOLDS_ONLY, diagnostics: true }), 30);
  tr.step(landmarks(BASE), W, H, 1 / 30);
  assert.equal(tr.diag.summary().rules.length, 0);
  assert.ok(new Diagnostics().summary().joints.length === 12);
});
