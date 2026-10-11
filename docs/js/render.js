/** 描画(骨格線・ウォーターマーク・ムーブ表示・ホールド赤丸)。Python版 _render_ui の移植。 */
import { LANDMARK_COUNT, MODE } from "./core.js";

export const FONT_STACK = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Meiryo","Noto Sans CJK JP","Noto Sans JP",sans-serif';

const POSE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];
const LEFT = new Set([1, 2, 3, 7, 9]);
const RIGHT = new Set([4, 5, 6, 8, 10]);
for (let i = 11; i < 33; i++) (i % 2 === 1 ? LEFT : RIGHT).add(i);

const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const trunc = Math.trunc;

export function uiScale(w, h) { return Math.max(0.5, Math.min(w, h) / 720.0); }

/** 骨格線(左=橙 / 右=水色 / 中央=白)。lm: [[x,y,vis]*33] 全画面の正規化座標 */
export function drawSkeleton(ctx, lm, w, h, s) {
  const pt = [];
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const [x, y, v] = lm[i];
    pt.push(Number.isFinite(x) && Number.isFinite(y) && v >= 0.5 ? [x * w, y * h] : null);
  }
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1, Math.round(2 * s));
  ctx.strokeStyle = "rgb(224,224,224)";
  ctx.beginPath();
  for (const [a, b] of POSE_CONNECTIONS) {
    if (pt[a] && pt[b]) { ctx.moveTo(pt[a][0], pt[a][1]); ctx.lineTo(pt[b][0], pt[b][1]); }
  }
  ctx.stroke();
  const r = Math.max(2, Math.round(3 * s));
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    if (!pt[i]) continue;
    ctx.fillStyle = LEFT.has(i) ? "rgb(255,138,0)" : RIGHT.has(i) ? "rgb(0,217,231)" : "rgb(224,224,224)";
    ctx.beginPath(); ctx.arc(pt[i][0], pt[i][1], r, 0, Math.PI * 2); ctx.fill();
  }
}

function measure(ctx, text, size) {
  ctx.font = `${size}px ${FONT_STACK}`;
  return [Math.ceil(ctx.measureText(text).width), Math.ceil(size * 1.25)];
}
function drawText(ctx, text, x, y, size, color) {
  ctx.font = `${size}px ${FONT_STACK}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = rgb(color);
  ctx.fillText(text, x, y);
}

const MOVE_COLORS = [["HEEL", [255, 0, 255]], ["DROP", [255, 215, 0]], ["CROSS", [255, 200, 100]],
  ["FLAG", [255, 140, 0]], ["DIAG", [0, 160, 255]], ["NORMAL", [200, 255, 0]]];

/** 半透明パネル・ホールド赤丸・フック部位の強調・文字を描く */
export function renderUi(ctx, w, h, det, isPausing, holds, cfg) {
  const s = uiScale(w, h);
  const pad = trunc(10 * s);
  const PANEL = "rgba(20,20,20,0.65)";
  ctx.save();
  ctx.textBaseline = "top";

  // ウォーターマーク(右上)
  const wm = cfg.app_name, wmSize = trunc(20 * s);
  let [tw, th] = measure(ctx, wm, wmSize);
  const x1 = w - trunc(15 * s), y0 = trunc(15 * s);
  const x0 = Math.max(0, x1 - tw - 2 * pad), y1 = y0 + th + 2 * pad;
  ctx.fillStyle = PANEL; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  drawText(ctx, wm, x0 + pad, y0 + pad, wmSize, [255, 220, 0]);

  // ムーブパネル
  if (cfg.mode === MODE.MOVES_AND_PAUSE) {
    const move = det.move;
    let disp, color;
    if (isPausing) { disp = `【${move.jp}】`; color = [255, 255, 0]; }
    else {
      disp = move.jp;
      color = (MOVE_COLORS.find(([k]) => move.id.includes(k)) || [null, [255, 255, 255]])[1];
    }
    let size = Math.max(12, trunc(cfg.move_font_size * s));
    const margin = trunc(20 * s);
    const px0 = margin;
    let py0 = trunc(15 * s);
    [tw, th] = measure(ctx, disp, size);
    let avail = x0 - trunc(10 * s) - px0 - 2 * pad;
    if (tw > avail) { py0 = y1 + trunc(8 * s); avail = w - 2 * margin - 2 * pad; }   // ウォーターマークの下段へ
    if (tw > avail && avail > 0) {                                                       // それでも長ければ縮小
      size = Math.max(12, trunc((size * avail) / tw));
      [tw, th] = measure(ctx, disp, size);
    }
    ctx.fillStyle = PANEL;
    ctx.fillRect(px0, py0, Math.min(w - 1, px0 + tw + 2 * pad) - px0, th + 2 * pad);
    drawText(ctx, disp, px0 + pad, py0 + pad, size, color);
  }

  // ホールド赤丸
  const rOut = trunc(22 * s), rIn = Math.max(2, trunc(4 * s)), thick = Math.max(2, trunc(3 * s));
  for (const hd of holds) {
    const cx = Math.round(hd.x), cy = Math.round(hd.y);
    ctx.strokeStyle = "rgb(255,0,0)"; ctx.lineWidth = thick;
    ctx.beginPath(); ctx.arc(cx, cy, rOut, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgb(255,0,0)";
    ctx.beginPath(); ctx.arc(cx, cy, rIn, 0, Math.PI * 2); ctx.fill();
    ctx.font = `bold ${Math.max(10, trunc(16 * s))}px ${FONT_STACK}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(`H${hd.id}`, cx + trunc(10 * s), cy - trunc(10 * s));
    ctx.textBaseline = "top";
  }

  // フック部位の強調
  if (cfg.mode === MODE.MOVES_AND_PAUSE && det.anchor) {
    const ax = Math.round(det.anchor[0]), ay = Math.round(det.anchor[1]);
    ctx.strokeStyle = rgb(det.color); ctx.lineWidth = Math.max(2, trunc(3 * s));
    ctx.beginPath(); ctx.arc(ax, ay, trunc(20 * s), 0, Math.PI * 2); ctx.stroke();
    if (det.label) drawText(ctx, det.label, ax + trunc(15 * s), ay - trunc(10 * s), trunc(18 * s), det.color);
  }
  ctx.restore();
}
