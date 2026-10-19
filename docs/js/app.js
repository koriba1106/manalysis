/** 画面(ブラウザ完結)。動画はサーバに送信されず、この端末内だけで処理される。 */
import { CHECK_INFO, MODE, VERSION, makeConfig, profileOverrides } from "./core.js";
import { CancelError, analyzeVideo } from "./analyzer.js";
import { webCodecsSupported } from "./encoder.js";
import { createPoseBackend } from "./pose.js";

// 他サイトの <iframe> に埋め込まれて操作を横取りされないよう、埋め込み表示では動作しない
if (window.top !== window.self) {
  document.body.textContent = "このページは他のサイトに埋め込んで表示できません。直接開いてください。";
  throw new Error("framed");
}
const $ = (id) => document.getElementById(id);
const COPYRIGHT = "©武庫労山　本ソフトウェアは、個人利用・商用利用を問わず、どなたでも無料でご利用いただけます。本ソフトウェアの使用、または使用不能によって生じたいかなる損害（データの損失、PCの不具合、業務の中断など）に関しても、制作者・著作者は一切の責任を負いません。すべて利用者の自己責任においてご利用ください。";
$("ver").textContent = `Web版 v${VERSION}`;
$("copy").textContent = COPYRIGHT;

let file = null, objUrl = null, roi = null, running = false, cancel = null, resultUrl = null;
let pose = null, poseComplexity = -1, wakeLock = null;
// 自動テスト用の骨格推定の差し替えフック。公開サイト上では無効(localhost / 127.0.0.1 のときだけ)
const IS_LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const poseFactory = () => (IS_LOCAL && window.MUKO_POSE_FACTORY) || createPoseBackend;

/* ---------- 対応状況 ---------- */
if (!webCodecsSupported()) {
  $("notice").textContent = "このブラウザは動画のエンコード(WebCodecs)に対応していないため解析できません。PC版の Chrome / Edge、または Safari 16.4 以降をお使いください。";
  $("notice").classList.remove("hidden");
}

/* ---------- ファイル選択 ---------- */
const drop = $("drop"), fileInput = $("file");
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener("change", () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("is-over"); }));
drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) setFile(f); });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

function setFile(f) {
  if (running) return;
  if (!(f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name))) { alert("動画ファイルを選んでください。"); return; }
  file = f;
  if (objUrl) URL.revokeObjectURL(objUrl);
  objUrl = URL.createObjectURL(f);
  const pv = $("pv");
  $("roiBox").classList.remove("hidden"); $("noPreview").classList.add("hidden");
  pv.onerror = () => { setRoi(null); $("roiBox").classList.add("hidden"); $("noPreview").classList.remove("hidden"); };
  pv.src = objUrl;
  pv.addEventListener("loadeddata", () => { try { pv.currentTime = 0.01; } catch (e) { /* ignore */ } fitCanvas(); }, { once: true });
  $("fileName").textContent = `${f.name}（${(f.size / 1048576).toFixed(1)} MB）`;
  $("previewWrap").classList.remove("hidden");
  setRoi(null);
  $("start").disabled = !webCodecsSupported();
  hideProgressAndResult();
}

/* ---------- クライマー範囲(ROI)の指定 ---------- */
const cv = $("roi"), cctx = cv.getContext("2d");
let dragStart = null;
function fitCanvas() { const pv = $("pv"); cv.width = Math.max(1, pv.clientWidth); cv.height = Math.max(1, pv.clientHeight); drawRoi(); }
new ResizeObserver(fitCanvas).observe($("pv"));
function drawRoi() {
  cctx.clearRect(0, 0, cv.width, cv.height);
  if (!roi) return;
  const [x0, y0, x1, y1] = roi, W = cv.width, H = cv.height;
  const css = getComputedStyle(document.documentElement);
  cctx.fillStyle = css.getPropertyValue("--color-roi-shade").trim() || "rgba(0,0,0,.45)"; cctx.fillRect(0, 0, W, H);
  cctx.clearRect(x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H);
  cctx.strokeStyle = css.getPropertyValue("--color-roi").trim() || "#ff7a2f"; cctx.lineWidth = 2;
  cctx.strokeRect(x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H);
}
function setRoi(r) { roi = r; $("roiClear").classList.toggle("hidden", !r); drawRoi(); }
function norm(e) {
  const b = cv.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))];
}
cv.addEventListener("pointerdown", (e) => { if (running) return; cv.setPointerCapture(e.pointerId); dragStart = norm(e); });
cv.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  const p = norm(e);
  roi = [Math.min(dragStart[0], p[0]), Math.min(dragStart[1], p[1]), Math.max(dragStart[0], p[0]), Math.max(dragStart[1], p[1])];
  drawRoi();
});
cv.addEventListener("pointerup", () => {
  if (!dragStart) return;
  dragStart = null;
  if (roi && (roi[2] - roi[0] < 0.05 || roi[3] - roi[1] < 0.05)) roi = null;   // 小さすぎる範囲は無効
  setRoi(roi);
});
$("roiClear").addEventListener("click", () => setRoi(null));

/* ---------- テーマ切り替え(自動=OS設定 / ライト / ダーク)。選択は端末に保存 ---------- */
const THEME_KEY = "muko.theme";
function applyTheme(v) {
  if (v === "light" || v === "dark") document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
  drawRoi();
}
(function initTheme() {
  let v = "auto";
  try { v = localStorage.getItem(THEME_KEY) || "auto"; } catch (e) { /* 保存できない環境 */ }
  $("theme").value = ["auto", "light", "dark"].includes(v) ? v : "auto";
  applyTheme($("theme").value);
  $("theme").addEventListener("change", () => {
    applyTheme($("theme").value);
    try { localStorage.setItem(THEME_KEY, $("theme").value); } catch (e) { /* ignore */ }
  });
})();

/* ---------- 表示ヘルパ ---------- */
function setStatus(text, pct) {
  $("status").textContent = text;
  const bar = $("bar");
  if (pct === null) bar.classList.add("is-indeterminate");
  else { bar.classList.remove("is-indeterminate"); bar.style.setProperty("--progress", `${pct}%`); }
}
function log(msg) { const el = $("log"); el.textContent += `${msg}\n`; el.scrollTop = el.scrollHeight; }
function hideProgressAndResult() {
  $("stepProgress").classList.add("hidden"); $("result").classList.add("hidden"); $("errBox").classList.add("hidden");
}
function fail(msg) {
  $("stepProgress").classList.remove("hidden");
  setStatus("失敗しました", 0);
  const eb = $("errBox"); eb.textContent = msg; eb.classList.remove("hidden");
  $("cancel").classList.add("hidden");
}
const fmtTime = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, "0")}`; };
const chip = (text) => { const s = document.createElement("span"); s.className = "chip"; s.textContent = text; return s; };
const stem = () => (file ? file.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) : "video") || "video";

/* ---------- 解析 ---------- */
async function getPose(complexity, cfg) {
  if (pose && poseComplexity === complexity) return pose;
  if (pose) { pose.close(); pose = null; }
  pose = await poseFactory()({ complexity, minDet: cfg.min_detection_confidence, minTrack: cfg.min_tracking_confidence, log });
  poseComplexity = complexity;
  return pose;
}

async function start() {
  if (!file || running) return;
  const num = (id, d) => { const v = $(id).value.trim(); return v === "" ? d : Number(v); };
  let cfg;
  try {
    cfg = makeConfig({
      mode: document.querySelector("input[name=mode]:checked").value === "holds" ? MODE.HOLDS_ONLY : MODE.MOVES_AND_PAUSE,
      pause_duration_sec: num("pause", 1.5), pause_cooldown_sec: num("cooldown", 2),
      max_holds: Math.trunc(num("maxHolds", 5)), model_complexity: Math.trunc(num("complexity", 2)),
      draw_skeleton: $("skeleton").checked, lock_climber: $("lock").checked, initial_roi: roi,
      // ムーブ判定の感度(しきい値・信頼度・揺らぎへの強さ)。カウンターバランスの区別を切ると従来どおりフラッギング側で判定
      ...profileOverrides($("sens").value, { counter: $("counter").checked }),
      diagnostics: true,
    });
  } catch (e) { fail(e.message); return; }

  running = true; cancel = { cancelled: false };
  hideProgressAndResult();
  if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
  $("log").textContent = "";
  $("stepProgress").classList.remove("hidden"); $("cancel").classList.remove("hidden"); $("cancel").disabled = false;
  $("start").disabled = true;
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* 任意機能 */ }
  window.addEventListener("beforeunload", guard);
  try {
    setStatus("骨格推定モデルを読み込み中…（初回は数十MBのダウンロードがあります）", null);
    const p = await getPose(cfg.model_complexity, cfg);
    setStatus("解析を開始しています…", null);
    const r = await analyzeVideo({
      file, cfg, pose: p, canvas: $("work"), cancel,
      maxSide: Number($("maxSide").value), poseMaxSide: Number($("poseSize").value), fps: num("fps", 0),
      onProgress: (d, t) => setStatus(`解析中… ${d}/${t} フレーム（${Math.round((100 * d) / t)}%）`, (100 * d) / t),
      onLog: log,
    });
    showResult(r);
  } catch (e) {
    if (e instanceof CancelError) { setStatus("キャンセルしました（出力は作成されていません）", 0); $("cancel").classList.add("hidden"); }
    else { console.error(e); fail(e && e.message ? e.message : String(e)); }
  } finally {
    running = false; $("start").disabled = !file || !webCodecsSupported();
    window.removeEventListener("beforeunload", guard);
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
  }
}
const guard = (e) => { e.preventDefault(); e.returnValue = ""; };

$("start").addEventListener("click", start);
$("cancel").addEventListener("click", () => { if (cancel) { cancel.cancelled = true; $("cancel").disabled = true; setStatus("キャンセル中…", null); } });
$("again").addEventListener("click", () => {
  hideProgressAndResult();
  const rv = $("rv"); rv.removeAttribute("src"); rv.load();
  if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
  window.scrollTo({ top: 0, behavior: "smooth" });
});

/* ---------- 判定の診断 ---------- */
const fmt = (x) => (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(2));
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function tdOf(text, cls) { return el("td", cls, text); }

function renderDiagnostics(d, sens) {
  const box = $("diag"); box.textContent = "";
  const p = d.pipeline || {};
  box.append(el("p", "", `骨格が使えたフレーム ${d.posePct}%(${d.poseFrames}/${d.frames}) ／ そのうち体幹(両肩・両腰)が見えた ${d.torsoPct}% ／ 左右の軸が使えた ${d.lateralPct}%`));
  box.append(el("p", "diag__sub", `使えなかった理由: モデルが検出なし ${p.modelNull ?? 0} ／ 胴体の信頼度や大きさが不足 ${p.torsoWeak ?? 0} ／ 別人として除外 ${p.lockRejected ?? 0}(フレーム)`));

  // 助言
  const adv = [];
  if (d.posePct < 70) adv.push(`骨格が安定して検出できていません(${d.posePct}%)。「推定精度」を上げる、「推論の画像サイズ」を大きくする、クライマーを大きく写す(ズーム・近づく)、明るい場所で撮る、のいずれかをお試しください。`);
  else if (d.torsoPct < 80) adv.push(`両肩・両腰が見えているフレームが少ないです(${d.torsoPct}%)。壁や他の人で体が隠れている、または体が小さく写っている可能性があります。`);
  if (d.lateralPct < 50 && d.torsoFrames > 0) adv.push(`横向き・ねじりのフレームが多く(左右の軸が使えたのは ${d.lateralPct}%)、キョン・クロス・ダイアゴナルは評価できないフレームが多くなります。正面か真後ろから撮ると判定されやすくなります。`);
  const lowJoints = d.joints.filter((j) => j.pct < 60).map((j) => `${j.name}(${j.pct}%)`);
  if (lowJoints.length) adv.push(`見えている割合が低い関節: ${lowJoints.join("、")}。これらを使うムーブは判定されにくくなります。`);
  const anyPassed = d.rules.some((r) => r.passed > 0);
  // 成立まで惜しかったもの(あと1条件を優先、次にあと2条件)。同じムーブは1回だけ、上位3つ
  const cand = d.rules.flatMap((r) => [
    ...r.nearMisses.map((m) => ({ rule: r.name, cond: 1, ...m })),
    ...r.near2Misses.map((m) => ({ rule: r.name, cond: 2, ...m })),
  ]).sort((x, y) => y.n - x.n || x.cond - y.cond);
  const seen = new Set(), top = [];
  for (const c of cand) { if (!seen.has(c.rule)) { seen.add(c.rule); top.push(c); } if (top.length === 3) break; }
  if (!anyPassed && top.length) {
    const desc = top.map((t) => `「${t.rule}」(あと${t.cond}条件: ${(CHECK_INFO[t.key] || { label: t.key }).label}、${t.n}フレーム)`).join("、");
    adv.push(`成立まで惜しかったのは ${desc} です。` +
      (sens === "standard" ? "感度を「ゆるめ」にすると出やすくなります。" : sens === "relaxed" ? "「かなりゆるめ」にすると出やすくなりますが、誤検出も増えます。" : "それでも出ない場合は、動画の写り方(上の項目)をご確認ください。"));
  }
  if (adv.length) { const ul = el("ul", "diag__advice"); for (const t of adv) ul.append(el("li", "", t)); box.append(ul); }

  // 関節ごとの可視率
  const chips = el("div", "chips");
  for (const j of d.joints) chips.append(el("span", "chip", `${j.name} ${j.pct}%`));
  box.append(el("p", "diag__sub", "関節ごとに見えていた割合(信頼度が下限以上)"), chips);

  // ムーブごとの判定状況
  const wrap = el("div", "diag__scroll"), table = el("table", "diag__table");
  const head = el("tr"); for (const t of ["ムーブ", "判定できた", "成立", "評価できなかった(見えない / 横向き)", "あと1条件で成立していたもの(多い順)"]) head.append(el("th", "", t));
  table.append(head);
  for (const r of d.rules) {
    if (r.evaluated === 0 && r.skipVisibility === 0 && r.skipLateral === 0) continue;
    const tr = el("tr");
    tr.append(tdOf(r.name), tdOf(String(r.evaluated), "diag__num"), tdOf(String(r.passed), r.passed > 0 ? "diag__num diag__ok" : "diag__num"),
      tdOf(`${r.skipVisibility} / ${r.skipLateral}`, "diag__num diag__sub"));
    const td = el("td");
    const list = r.nearMisses.length ? r.nearMisses : r.near2Misses;
    if (r.nearMisses.length === 0 && r.near2Misses.length) td.append(el("div", "diag__sub", "あと2条件でした:"));
    if (r.passed > 0 && list.length === 0) td.textContent = "—";
    for (const m of list) {
      const info = CHECK_INFO[m.key] || { label: m.key, unit: "" };
      const gap = m.medianMargin === null ? "" : `(不足の中央値 ${fmt(-m.medianMargin)}${info.unit})`;
      td.append(el("div", "", `${info.label}: ${m.n}フレーム${gap}`));
    }
    tr.append(td); table.append(tr);
  }
  wrap.append(table); box.append(wrap);
  $("diagBox").classList.remove("hidden");
}

/* ---------- 結果 ---------- */
function showResult({ blob, ext, events, result: r }) {
  setStatus("完了しました", 100);
  $("cancel").classList.add("hidden");
  resultUrl = URL.createObjectURL(blob);
  const rv = $("rv");
  rv.src = resultUrl;
  $("dl").href = resultUrl;
  $("dl").setAttribute("download", `${stem()}_analyzed.${ext}`);
  const note = $("fmtNote");
  if (r.container !== "mp4") {
    note.textContent = `このブラウザは H.264 でのエンコードに対応していないため、${r.codec} の WebM 形式で出力しました。SNS 等へ投稿する場合は mp4 への変換が必要なことがあります（Chrome / Edge / Safari では mp4 で出力されます）。`;
    note.classList.remove("hidden");
  } else note.classList.add("hidden");

  const chips = $("chips"); chips.textContent = "";
  chips.append(chip(`${r.frames} フレーム`), chip(`${r.width}×${r.height} / ${r.fps}fps`),
    chip(`出力 ${r.out_seconds} 秒`), chip(`ホールド ${r.holds_total} 個`), chip(`${r.codec}`));
  if (r.mode === MODE.MOVES_AND_PAUSE) chips.append(chip(`停止 ${r.pauses} 回`));
  if (r.rejected_frames) chips.append(chip(`別人を除外 ${r.rejected_frames} フレーム`));

  const ul = $("moves"); ul.textContent = "";
  $("movesHint").classList.toggle("hidden", events.length === 0);
  const note1 = (t) => { const li = document.createElement("li"); li.className = "status"; li.textContent = t; ul.append(li); };
  if (r.mode !== MODE.MOVES_AND_PAUSE) note1("ホールドのみモードのためムーブ検出は行っていません。");
  else if (events.length === 0) note1("顕著なムーブは検出されませんでした。");
  for (const e of events) {
    const li = document.createElement("li");
    const b = document.createElement("button"); b.type = "button"; b.className = "btn";
    const t = document.createElement("span"); t.className = "move-time"; t.textContent = fmtTime(e.t_out);
    const n = document.createElement("span"); n.textContent = e.jp;
    b.append(t, n);
    b.addEventListener("click", () => { rv.currentTime = Math.max(0, e.t_out); rv.play().catch(() => {}); rv.scrollIntoView({ behavior: "smooth", block: "center" }); });
    li.append(b); ul.append(li);
  }
  if (r.diagnostics) renderDiagnostics(r.diagnostics, $("sens").value); else $("diagBox").classList.add("hidden");
  $("result").classList.remove("hidden");
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}
