// カウンターバランスがフラッギングと誤判定されない(回帰テスト)
import test from "node:test";
import assert from "node:assert/strict";
import { MoveDetector, computeBodyFrame, DEFAULT_THRESHOLDS, MoveType } from "../docs/js/core.js";

const U = 60;
const IDX = { l_sh: 11, r_sh: 12, l_hip: 23, r_hip: 24, l_wrist: 15, r_wrist: 16, l_knee: 25, r_knee: 26,
  l_ankle: 27, r_ankle: 28, l_heel: 29, r_heel: 30 };
// 体幹相対(+x=人物の右, +y=上, 単位=骨盤幅)の標準姿勢
const BASE = { l_sh: [-.5, 1.667], r_sh: [.5, 1.667], l_hip: [-.5, 0], r_hip: [.5, 0], l_wrist: [-.8, 2.6], r_wrist: [.8, 2.6],
  l_knee: [-.5, -1], r_knee: [.5, -1], l_ankle: [-.5, -2], r_ankle: [.5, -2], l_heel: [-.5, -2.1], r_heel: [.5, -2.1] };
const pose = (over) => ({ ...BASE, ...over });

function detect(rel, th = DEFAULT_THRESHOLDS) {
  const pts = {}, vis = {};
  for (const k of Object.keys(IDX)) { pts[k] = [320 - rel[k][0] * U, 300 - rel[k][1] * U]; vis[k] = true; }
  const body = computeBodyFrame(pts, vis, 5);
  return new MoveDetector(th).detect(pts, vis, body);
}
const OLD = { ...DEFAULT_THRESHOLDS, counter_wrist_min_y: Infinity };   // 修正前の挙動

// 右手を高く伸ばし、左足を横へ出す(足は腰よりやや下)
const COUNTER_R = pose({ r_wrist: [.9, 3.0], l_wrist: [-.6, 1.8], l_knee: [-1.7, -.7], l_ankle: [-2.9, -1.4], l_heel: [-2.95, -1.5] });
// 両手が同じ高さで、足だけ横へ張り出す純粋なフラッギング
const FLAG_L = pose({ l_knee: [-1.75, -.85], l_ankle: [-3.0, -1.7], l_heel: [-3.05, -1.8] });

test("修正前はカウンターバランスがフラッギングと誤判定される(再現)", () => {
  assert.equal(detect(COUNTER_R, OLD).move, MoveType.FLAG_L);
});

test("修正後: カウンターバランス → ダイアゴナル(カウンターバランス)、フラッギングにはならない", () => {
  const d = detect(COUNTER_R);
  assert.equal(d.move, MoveType.DIAGONAL_R);
  assert.equal(d.label, "カウンター");
  assert.match(d.move.jp, /カウンターバランス/);
});

test("左右反転した姿勢(左手を高く・右足を出す)も同様", () => {
  const mirrored = pose({ l_wrist: [-.9, 3.0], r_wrist: [.6, 1.8], r_knee: [1.7, -.7], r_ankle: [2.9, -1.4], r_heel: [2.95, -1.5] });
  assert.equal(detect(mirrored, OLD).move, MoveType.FLAG_R);
  assert.equal(detect(mirrored).move, MoveType.DIAGONAL_L);
});

test("純粋なフラッギング(両手が同じ高さ)は従来どおりフラッギング", () => {
  assert.equal(detect(FLAG_L).move, MoveType.FLAG_L);
  assert.equal(detect(FLAG_L, OLD).move, MoveType.FLAG_L);
});

test("境界: 手が十分高くない / 手の高さの差が小さい / 足が体の近い → フラッギング側のまま", () => {
  assert.equal(detect({ ...COUNTER_R, r_wrist: [.9, 1.9] }).move, MoveType.FLAG_L);          // 高い手が 2.0 未満
  assert.equal(detect({ ...COUNTER_R, l_wrist: [-.6, 2.6] }).move, MoveType.FLAG_L);         // 手の高さの差が 0.6 未満
  // 高い手と同じ側へ足を出している(逆側ではない)→ カウンターではない
  const sameSide = pose({ r_wrist: [.9, 3.0], l_wrist: [-.6, 1.8], r_knee: [1.75, -.85], r_ankle: [3.0, -1.7], r_heel: [3.05, -1.8] });
  assert.equal(detect(sameSide).move, MoveType.FLAG_R);
});

test("閾値を無効化(Infinity)すると従来の挙動に戻せる", () => {
  assert.equal(detect(COUNTER_R, { ...DEFAULT_THRESHOLDS, counter_wrist_min_y: Infinity }).move, MoveType.FLAG_L);
});

test("従来のダイアゴナル(厳しい条件)は引き続き同じ結果", () => {
  const strictDiag = pose({ r_wrist: [.6, 3.2], l_wrist: [-.3, 1.5], l_knee: [-1.15, -1.4], l_ankle: [-1.8, -2.8], l_heel: [-1.85, -2.9] });
  const d = detect(strictDiag);
  assert.equal(d.move, MoveType.DIAGONAL_R);
  assert.equal(d.label, "対角");        // 厳しい条件で成立したもの
  assert.equal(detect(strictDiag, OLD).move, MoveType.DIAGONAL_R);
});
