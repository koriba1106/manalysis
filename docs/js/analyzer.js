/**
 * 解析ループ(ブラウザ完結)。Python版 ClimbingAnalyzerMuko.process_video / _get_landmarks の移植。
 *
 * 高速化(v4.1):
 *  - 動画要素を 2 つ使い、推論中に次フレームをシークしておく(先読み)
 *  - 骨格推定には「動画から必要な範囲だけを縮小して」小さなキャンバスへ描いて渡す
 *    (フルHD全体を毎フレームGPU/CPUへ転送・リサイズしない)
 *  - 作業キャンバスは読み戻し(getImageData)しない。服の色ヒストグラムは胴体領域だけを小さく取得
 *  - 各段階の所要時間を計測し、結果とログに出す
 * 安全策(v4.1): 解像度・フレーム数・出力サイズに上限を設け、巨大な入力でブラウザが落ちないようにする。
 */
import {
  ClimberLock, Tracker, histFromRegion, pyRound, roiEqual, sanitizeFps, torsoBox,
} from "./core.js";
import { createVideoEncoder, estimateBitrate } from "./encoder.js";
import { drawSkeleton, renderUi } from "./render.js";

export class CancelError extends Error { constructor() { super("キャンセルしました"); this.name = "CancelError"; } }

/** 入力の上限(メモリ枯渇・無限に近い処理時間の防止) */
export const LIMITS = Object.freeze({
  maxPixels: 3840 * 2160,          // 入力動画の解像度
  maxFrames: 216000,               // 2時間 @30fps
  maxOutputBytes: 1.5e9,           // 出力はメモリ上で組み立てる(ArrayBuffer の上限に余裕を持たせる)
});
export const POSE_MAX_SIDE_DEFAULT = 768;
const SEEK_TIMEOUT_MS = 30000;      // 1フレームを待つ上限(待ち始めてから)。超えたら1回だけやり直す

const even = (n) => Math.max(2, n - (n % 2));
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
const now = () => performance.now();

function makeVideo(url) {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
  return v;
}
function whenLoaded(v) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { v.removeEventListener("loadeddata", ok); v.removeEventListener("error", ng); };
    const ok = () => { cleanup(); resolve(); };
    const ng = () => { cleanup(); reject(new Error("この動画はブラウザで読み込めません。mp4(H.264) など一般的な形式でお試しください。")); };
    if (v.readyState >= 2) { resolve(); return; }
    v.addEventListener("loadeddata", ok); v.addEventListener("error", ng);
  });
}

/** 解像度に応じた先読み枚数(動画要素の数)。大きい動画ほどメモリを使うので控えめにする */
export function prefetchDepthFor(width, height) {
  const px = width * height;
  return px <= 1280 * 720 ? 4 : px <= 1920 * 1088 ? 3 : 2;
}

/**
 * 動画ファイルをフレーム単位でシークして読み出す。
 * シークは直前のキーフレームから復号し直すため 1 回が遅い。動画要素を depth 個持ち、
 * 先のフレームを並行してシークしておくことで、待ち時間を処理の裏に隠す。
 */
export class VideoSource {
  constructor(file, depth = 2) {
    this.url = URL.createObjectURL(file);
    this.depth = Math.max(2, depth);
    this.vids = [makeVideo(this.url)];
    this.slot = new Array(this.depth).fill(null);          // 各要素の {i, p}(シーク中/完了済みのフレーム番号と Promise)
  }
  get video() { return this.vids[0]; }
  async load() {
    await whenLoaded(this.vids[0]);
    const v = this.vids[0];
    this.width = v.videoWidth; this.height = v.videoHeight; this.duration = v.duration;
    if (!(this.duration > 0) || !Number.isFinite(this.duration)) throw new Error("動画の長さを取得できませんでした");
  }
  /** 先読み用の動画要素を追加で用意する(解像度が分かってから呼ぶ。fps 推定は 1 要素目で済ませておく) */
  async prepare(depth) {
    this.depth = Math.max(2, depth);
    this.slot = new Array(this.depth).fill(null);
    while (this.vids.length < this.depth) this.vids.push(makeVideo(this.url));
    await Promise.all(this.vids.map(whenLoaded));
  }
  /** 再生しながら表示フレーム間隔を測り、fps を推定する(取れなければ 30) */
  async detectFps() {
    const v = this.vids[0];
    if (typeof v.requestVideoFrameCallback !== "function") return 30;
    const times = [];
    const done = new Promise((resolve) => {
      const tick = (_now, meta) => { times.push(meta.mediaTime); if (times.length >= 14) resolve(); else v.requestVideoFrameCallback(tick); };
      v.requestVideoFrameCallback(tick);
      setTimeout(resolve, 2500);
    });
    try { v.currentTime = 0; await v.play(); } catch (e) { return 30; }
    await done;
    v.pause();
    const d = [];
    for (let i = 1; i < times.length; i++) { const x = times[i] - times[i - 1]; if (x > 1e-4) d.push(x); }
    if (d.length < 3) return 30;
    d.sort((a, b) => a - b);
    const est = 1 / d[Math.floor(d.length / 2)];
    let best = null;                                   // 近い候補のうち最も近いものを採用(29.97 と 30 の取り違え防止)
    for (const f of COMMON_FPS) { const e = Math.abs(f - est) / f; if (e < 0.02 && (best === null || e < best[1])) best = [f, e]; }
    return best ? best[0] : Math.round(est * 100) / 100;
  }
  /** シークして、そのフレームが使えるようになるまでの Promise。タイマーはここでは持たない(待ち始めた時点で数える) */
  _seek(v, t) {
    const target = Math.min(Math.max(0, t), Math.max(0, this.duration - 0.001));
    if (Math.abs(v.currentTime - target) < 1e-4 && v.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { v.removeEventListener("seeked", ok); v.removeEventListener("error", ng); };
      const ok = () => { cleanup(); resolve(); };
      const ng = () => { cleanup(); reject(new Error("動画のシークに失敗しました")); };
      v.addEventListener("seeked", ok); v.addEventListener("error", ng);
      v.currentTime = target;
    });
  }
  /** 待ち始めてから ms 以内に完了しなければ "timeout" で失敗する */
  _withTimeout(p, ms) {
    let timer;
    const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }
  _start(i, fps) {
    const s = i % this.depth;
    const p = this._seek(this.vids[s], (i + 0.5) / fps);
    p.catch(() => {});                                  // 先読みの失敗は、そのフレームを取りに行ったときに報告する
    this.slot[s] = { i, p };
  }
  /** フレーム i を表示している動画要素を返し、同時に先のフレームの先読みを始める */
  async frame(i, fps, total) {
    const s = i % this.depth;
    if (!this.slot[s] || this.slot[s].i !== i) this._start(i, fps);
    try {
      await this._withTimeout(this.slot[s].p, SEEK_TIMEOUT_MS);
    } catch (e) {
      if (e.message !== "timeout") throw e;
      this._start(i, fps);                               // CPU が逼迫していて遅れているだけの場合があるので、1回だけやり直す
      try { await this._withTimeout(this.slot[s].p, SEEK_TIMEOUT_MS); }
      catch (e2) {
        if (e2.message !== "timeout") throw e2;
        throw new Error("動画の読み込みが極端に遅いため中断しました。「出力の最大サイズ」を下げるか、動画を短くしてお試しください。");
      }
    }
    // 先のフレーム(i+1 … i+depth-1)の要素は、前に使ったフレームの処理がすべて終わっているので再利用できる
    for (let j = i + 1; j < Math.min(total, i + this.depth); j++) {
      const sj = j % this.depth;
      if (!this.slot[sj] || this.slot[sj].i !== j) this._start(j, fps);
    }
    return this.vids[s];
  }
  dispose() {
    for (const v of this.vids) { try { v.removeAttribute("src"); v.load(); } catch (e) { /* ignore */ } }
    URL.revokeObjectURL(this.url);
  }
}

/**
 * @param {object} o
 *   file, cfg(makeConfig の戻り値), pose({beginVideo, detect, close}), canvas(作業用・画面表示にも使う)
 *   maxSide(出力の長辺の上限px), poseMaxSide(骨格推定に渡す画像の長辺の上限px), fps(0=自動)
 *   onProgress(done,total), onLog(msg), cancel({cancelled})
 */
export async function analyzeVideo(o) {
  const { file, cfg, pose, canvas, cancel = { cancelled: false }, onProgress = () => {}, onLog = () => {} } = o;
  const maxSide = o.maxSide || 1920;
  const poseMaxSide = o.poseMaxSide || POSE_MAX_SIDE_DEFAULT;
  const log = (m) => onLog(m);
  const src = new VideoSource(file, 2);
  let encoder = null;
  try {
    await src.load();
    if (src.width * src.height > LIMITS.maxPixels) {
      throw new Error(`動画の解像度が大きすぎます(${src.width}x${src.height})。4K(3840x2160)以下の動画でお試しください。`);
    }
    let fps = o.fps > 0 ? o.fps : await src.detectFps();
    fps = sanitizeFps(fps);
    const total = Math.max(1, Math.round(src.duration * fps));
    if (total > LIMITS.maxFrames) throw new Error(`動画が長すぎます(約${Math.round(total / fps / 60)}分)。2時間以内に分割してお試しください。`);
    const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
    const W = even(Math.round(src.width * scale)), H = even(Math.round(src.height * scale));
    const estBytes = (estimateBitrate(W, H, fps) / 8) * (total / fps) * 1.3;
    if (estBytes > LIMITS.maxOutputBytes) {
      throw new Error(`出力が大きくなりすぎます(約${(estBytes / 1e9).toFixed(1)}GB)。「出力の最大サイズ」を下げるか、動画を分割してください。`);
    }
    await src.prepare(o.prefetch || prefetchDepthFor(src.width, src.height));
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");                 // 読み戻しをしないので GPU アクセラレーションのまま使う
    const poseCanvas = document.createElement("canvas");
    const poseCtx = poseCanvas.getContext("2d");
    const histCanvas = document.createElement("canvas");
    const histCtx = histCanvas.getContext("2d", { willReadFrequently: true });
    const kx = src.width / W, ky = src.height / H;       // 出力キャンバス座標 → 元動画座標
    const dt = 1 / fps;

    const tracker = new Tracker(cfg, fps);
    const lock = new ClimberLock(cfg, fps);
    pose.beginVideo(fps);
    encoder = await createVideoEncoder({ width: W, height: H, fps });
    log(`開始: ${cfg.mode} | ${src.width}x${src.height}${scale < 1 ? ` → ${W}x${H}` : ""} | ${fps}fps | ${total}フレーム | 出力 ${encoder.codec}(${encoder.ext}) | 推論入力 長辺${poseMaxSide}px以下 | 先読み${src.depth}`);

    let rejectedCount = 0, lostLogged = false, frameIdx = 0, curVideo = null;
    const why = { modelNull: 0, torsoWeak: 0 };          // 骨格が使えなかった理由(モデルが検出なし / 胴体の信頼度や大きさが不足)
    const T = { wait: 0, draw: 0, infer: 0, hist: 0, track: 0, render: 0, encode: 0 };   // 段階別の累計(ms)
    const stamp = () => `[${(frameIdx / fps).toFixed(2).padStart(7)}s]`;

    // ---- 骨格推定: 動画から必要な範囲だけを縮小して描き、全画面の正規化座標へ戻す ----
    const infer = (roi) => {
      const t0 = now();
      let x0 = 0, y0 = 0, cw = W, ch = H;
      if (roi !== null) { x0 = roi[0]; y0 = roi[1]; cw = roi[2] - roi[0]; ch = roi[3] - roi[1]; }
      const f = Math.min(1, poseMaxSide / Math.max(cw, ch));            // 拡大はしない
      const pw = Math.max(1, Math.round(cw * f)), ph = Math.max(1, Math.round(ch * f));
      if (poseCanvas.width !== pw || poseCanvas.height !== ph) { poseCanvas.width = pw; poseCanvas.height = ph; }
      poseCtx.drawImage(curVideo, x0 * kx, y0 * ky, cw * kx, ch * ky, 0, 0, pw, ph);
      const lm = pose.detect(poseCanvas);
      T.infer += now() - t0;
      if (!lm || lm.length < 33) return null;
      const out = new Array(33);
      for (let i = 0; i < 33; i++) {
        const p = lm[i];
        out[i] = roi === null ? [p[0], p[1], p[2]] : [(x0 + p[0] * cw) / W, (y0 + p[1] * ch) / H, p[2]];
      }
      return out;
    };

    const torsoVis = cfg.min_visibility_torso !== null && cfg.min_visibility_torso !== undefined ? cfg.min_visibility_torso : cfg.min_visibility;
    const makeCandidate = (lm) => {
      const raw = {};
      for (const [name, idx] of [["l_sh", 11], ["r_sh", 12], ["l_hip", 23], ["r_hip", 24]]) {
        const n = lm[idx];
        const p = [n[0] * W, n[1] * H];
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || n[2] < torsoVis) return null;
        raw[name] = p;
      }
      const ps = Object.values(raw);
      const center = [ps.reduce((a, p) => a + p[0], 0) / 4, ps.reduce((a, p) => a + p[1], 0) / 4];
      const torso = Math.hypot((raw.l_sh[0] + raw.r_sh[0]) / 2 - (raw.l_hip[0] + raw.r_hip[0]) / 2,
        (raw.l_sh[1] + raw.r_sh[1]) / 2 - (raw.l_hip[1] + raw.r_hip[1]) / 2);
      if (!Number.isFinite(torso) || torso < Math.max(cfg.min_torso_ratio * Math.min(W, H), 1.0)) return null;
      let xs = [], ys = [];
      for (const n of lm) if (n[2] >= 0.3 && Number.isFinite(n[0]) && Number.isFinite(n[1])) { xs.push(n[0] * W); ys.push(n[1] * H); }
      if (xs.length < 4) { xs = ps.map((p) => p[0]); ys = ps.map((p) => p[1]); }
      const bbox = [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)),
        Math.min(W, Math.max(...xs)), Math.min(H, Math.max(...ys))];
      let hist = null;
      if (cfg.lock_use_appearance) {
        const t0 = now();
        const box = torsoBox(raw, W, H);
        if (box) {                                       // 胴体の内側だけを、小さく(最大48px)取り出して色の分布を作る
          const bw = box[2] - box[0], bh = box[3] - box[1];
          const sw = Math.max(2, Math.min(48, bw)), sh = Math.max(2, Math.min(48, bh));
          if (histCanvas.width !== sw || histCanvas.height !== sh) { histCanvas.width = sw; histCanvas.height = sh; }
          histCtx.drawImage(curVideo, box[0] * kx, box[1] * ky, bw * kx, bh * ky, 0, 0, sw, sh);
          const img = histCtx.getImageData(0, 0, sw, sh);
          hist = histFromRegion(img.data, img.width, img.height);
        }
        T.hist += now() - t0;
      }
      return { center, torso, bbox, hist };
    };

    const getLandmarks = () => {
      if (!cfg.lock_climber) {
        const lm = infer(null);
        if (lm === null) why.modelNull += 1;
        else if (makeCandidate(lm) === null) why.torsoWeak += 1;     // 固定しない場合も、胴体が使えない骨格は判定できない
        return lm;
      }
      const rois = [lock.roiFor(W, H)];
      if (lock.locked) {
        const tight = lock.roiFor(W, H, true);
        if (!roiEqual(tight, rois[0])) rois.push(tight);
      }
      let rejected = false, sawLm = false, sawCand = false;
      for (const roi of rois) {
        const lm = infer(roi);
        if (lm === null) continue;
        sawLm = true;
        const cand = makeCandidate(lm);
        if (cand === null) continue;
        sawCand = true;
        if (lock.accept(cand)) {
          const first = !lock.locked;
          const wasLost = lock.locked && lock.missed >= Math.max(1, Math.trunc(fps));
          lock.update(cand);
          if (first) log(`${stamp()} 対象クライマーを固定しました`);
          else if (wasLost) log(`${stamp()} 対象クライマーを再捕捉しました`);
          lostLogged = false;
          return lm;
        }
        rejected = true;
      }
      if (rejected) rejectedCount += 1;
      else if (!sawLm) why.modelNull += 1;
      else if (!sawCand) why.torsoWeak += 1;
      lock.miss();
      if (lock.locked && lock.missed === Math.max(1, Math.trunc(fps)) && !lostLogged) {
        lostLogged = true;
        log(`${stamp()} 対象クライマーを見失いました(他の人は無視して探索を続けます)`);
      }
      return null;
    };

    // ---- メインループ ----
    const events = [];
    let pauses = 0, errors = 0;
    for (let i = 0; i < total; i++) {
      if (cancel.cancelled) throw new CancelError();
      frameIdx = i;
      let t = now();
      curVideo = await src.frame(i, fps, total);
      T.wait += now() - t; t = now();
      ctx.drawImage(curVideo, 0, 0, W, H);
      T.draw += now() - t;

      let trigger = false;
      try {
        const lm = getLandmarks();
        t = now();
        const r = tracker.step(lm, W, H, dt);
        trigger = r.trigger;
        T.track += now() - t; t = now();
        if (lm !== null && cfg.draw_skeleton) drawSkeleton(ctx, lm, W, H, Math.max(0.5, Math.min(W, H) / 720));
        renderUi(ctx, W, H, r.detection, trigger, tracker.holdManager.holds, cfg);
        T.render += now() - t;
        errors = 0;
      } catch (e) {
        errors += 1;
        trigger = false;
        log(`フレーム${i}の解析に失敗(原画像で継続): ${e && e.message ? e.message : e}`);
        if (errors >= cfg.max_consecutive_errors) throw new Error("連続エラーが上限に達したため中断しました");
        ctx.drawImage(curVideo, 0, 0, W, H);
      }

      t = now();
      if (trigger) {
        const mv = tracker.stabilizer.confirmed;
        pauses += 1;
        events.push({ frame: i, t_src: +(i / fps).toFixed(3), t_out: +(encoder.count / fps).toFixed(3),
          move: mv.id, jp: mv.jp, en: mv.en });
        log(`[${(i / fps).toFixed(2).padStart(7)}s] ムーブ検出: 【${mv.jp}】 - ${cfg.pause_duration_sec}秒停止`);
        await encoder.encodeCanvas(canvas, 1 + pyRound(fps * cfg.pause_duration_sec));
      } else {
        await encoder.encodeCanvas(canvas, 1);
      }
      T.encode += now() - t;
      onProgress(i + 1, total);
      if ((i + 1) % 100 === 0) log(`処理中: ${i + 1}フレーム (${Math.round((100 * (i + 1)) / total)}%)`);
    }

    log("エンコードを完了しています…");
    const outFrames = encoder.count;
    let t = now();
    const blob = await encoder.finish();
    T.encode += now() - t;
    const per = (k) => +(T[k] / total).toFixed(1);
    const timings = { wait: per("wait"), draw: per("draw"), infer: per("infer"), hist: per("hist"),
      track: per("track"), render: per("render"), encode: per("encode") };
    const result = {
      frames: total, fps, width: W, height: H,
      out_seconds: +(outFrames / fps).toFixed(2), src_seconds: +(total / fps).toFixed(2),
      holds_total: tracker.holdManager.totalRegistered, pauses, rejected_frames: rejectedCount,
      codec: encoder.codec, container: encoder.container, mode: cfg.mode, timings,
    };
    if (tracker.diag) {
      result.diagnostics = { ...tracker.diag.summary(), pipeline: { modelNull: why.modelNull, torsoWeak: why.torsoWeak, lockRejected: rejectedCount } };
    }
    log(`=== 解析完了 | ${total}フレーム / ホールド累計${result.holds_total}個 / 停止${pauses}回 ===`);
    if (result.diagnostics) {
      const d = result.diagnostics;
      log(`診断: 骨格が使えたフレーム ${d.posePct}% / そのうち体幹が見えた ${d.torsoPct}% / 左右の軸が使えた ${d.lateralPct}%` +
        `(使えなかった理由: モデルが検出なし ${why.modelNull} / 胴体の信頼度不足 ${why.torsoWeak} / 別人として除外 ${rejectedCount})`);
    }
    log(`所要時間の内訳(1フレームあたり ms): 動画待ち ${timings.wait} / 描画 ${timings.draw} / 推論 ${timings.infer} / 色分布 ${timings.hist} / 判定 ${timings.track} / 重ね描き ${timings.render} / 符号化 ${timings.encode}`);
    return { blob, ext: encoder.ext, mime: encoder.mime, events, result };
  } catch (e) {
    if (encoder) encoder.abort();
    throw e;
  } finally {
    src.dispose();
  }
}
