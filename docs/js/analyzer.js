/** 解析ループ(ブラウザ完結)。Python版 ClimbingAnalyzerMuko.process_video / _get_landmarks の移植。 */
import {
  ClimberLock, MODE, Tracker, histFromRegion, pyRound, roiEqual, sanitizeFps, torsoBox,
} from "./core.js";
import { createVideoEncoder } from "./encoder.js";
import { drawSkeleton, renderUi } from "./render.js";

export class CancelError extends Error { constructor() { super("キャンセルしました"); this.name = "CancelError"; } }

const even = (n) => Math.max(2, n - (n % 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

/** 動画ファイルをフレーム単位でシークして読み出す */
export class VideoSource {
  constructor(file) {
    this.url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = this.url;
    this.video = v;
  }
  async load() {
    const v = this.video;
    await new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const ng = () => { cleanup(); reject(new Error("この動画はブラウザで読み込めません。mp4(H.264) など一般的な形式でお試しください。")); };
      const cleanup = () => { v.removeEventListener("loadeddata", ok); v.removeEventListener("error", ng); };
      v.addEventListener("loadeddata", ok); v.addEventListener("error", ng);
    });
    this.width = v.videoWidth; this.height = v.videoHeight; this.duration = v.duration;
    if (!(this.duration > 0) || !Number.isFinite(this.duration)) throw new Error("動画の長さを取得できませんでした");
  }
  /** 再生しながら表示フレーム間隔を測り、fps を推定する(取れなければ 30) */
  async detectFps() {
    const v = this.video;
    if (typeof v.requestVideoFrameCallback !== "function") return 30;
    const times = [];
    const done = new Promise((resolve) => {
      const tick = (_now, meta) => {
        times.push(meta.mediaTime);
        if (times.length >= 14) resolve(); else v.requestVideoFrameCallback(tick);
      };
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
  seek(t) {
    const v = this.video;
    const target = Math.min(Math.max(0, t), Math.max(0, this.duration - 0.001));
    if (Math.abs(v.currentTime - target) < 1e-4 && v.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); v.removeEventListener("seeked", ok); v.removeEventListener("error", ng); };
      const ok = () => { cleanup(); resolve(); };
      const ng = () => { cleanup(); reject(new Error("動画のシークに失敗しました")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("動画のシークがタイムアウトしました")); }, 10000);
      v.addEventListener("seeked", ok); v.addEventListener("error", ng);
      v.currentTime = target;
    });
  }
  dispose() { try { this.video.removeAttribute("src"); this.video.load(); } catch (e) { /* ignore */ } URL.revokeObjectURL(this.url); }
}

/**
 * @param {object} o
 *   file, cfg(makeConfig の戻り値), pose({beginVideo, detect, close}), canvas(作業用・画面表示にも使う)
 *   maxSide(長辺の上限px), fps(0=自動), onProgress(done,total), onLog(msg), cancel({cancelled})
 */
export async function analyzeVideo(o) {
  const { file, cfg, pose, canvas, cancel = { cancelled: false }, onProgress = () => {}, onLog = () => {} } = o;
  const maxSide = o.maxSide || 1920;
  const log = (m) => onLog(m);
  const src = new VideoSource(file);
  let encoder = null;
  try {
    await src.load();
    let fps = o.fps > 0 ? o.fps : await src.detectFps();
    fps = sanitizeFps(fps);
    const total = Math.max(1, Math.round(src.duration * fps));
    const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
    const W = even(Math.round(src.width * scale)), H = even(Math.round(src.height * scale));
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const crop = document.createElement("canvas");
    const cropCtx = crop.getContext("2d");
    const dt = 1 / fps;

    const tracker = new Tracker(cfg, fps);
    const lock = new ClimberLock(cfg, fps);
    pose.beginVideo(fps);
    encoder = await createVideoEncoder({ width: W, height: H, fps });
    log(`開始: ${cfg.mode} | ${src.width}x${src.height}${scale < 1 ? ` → ${W}x${H}` : ""} | ${fps}fps | ${total}フレーム | 出力 ${encoder.codec}(${encoder.ext})`);

    let rejectedCount = 0, lostLogged = false, frameIdx = 0;
    const stamp = () => `[${(frameIdx / fps).toFixed(2).padStart(7)}s]`;

    // ---- 骨格推定(ROI で切り出し → 全画面の正規化座標へ戻す) ----
    const infer = (roi) => {
      let source = canvas, x0 = 0, y0 = 0, cw = W, ch = H;
      if (roi !== null) {
        x0 = roi[0]; y0 = roi[1]; cw = roi[2] - roi[0]; ch = roi[3] - roi[1];
        if (crop.width !== cw || crop.height !== ch) { crop.width = cw; crop.height = ch; }
        cropCtx.drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
        source = crop;
      }
      const lm = pose.detect(source);
      if (!lm || lm.length < 33) return null;
      const out = new Array(33);
      for (let i = 0; i < 33; i++) {
        const p = lm[i];
        out[i] = roi === null ? [p[0], p[1], p[2]] : [(x0 + p[0] * cw) / W, (y0 + p[1] * ch) / H, p[2]];
      }
      return out;
    };

    const makeCandidate = (lm) => {
      const raw = {};
      for (const [name, idx] of [["l_sh", 11], ["r_sh", 12], ["l_hip", 23], ["r_hip", 24]]) {
        const n = lm[idx];
        const p = [n[0] * W, n[1] * H];
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || n[2] < cfg.min_visibility) return null;
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
        const box = torsoBox(raw, W, H);
        if (box) {
          const img = ctx.getImageData(box[0], box[1], box[2] - box[0], box[3] - box[1]);
          hist = histFromRegion(img.data, img.width, img.height);
        }
      }
      return { center, torso, bbox, hist };
    };

    const getLandmarks = () => {
      if (!cfg.lock_climber) return infer(null);
      const rois = [lock.roiFor(W, H)];
      if (lock.locked) {
        const tight = lock.roiFor(W, H, true);
        if (!roiEqual(tight, rois[0])) rois.push(tight);
      }
      let rejected = false;
      for (const roi of rois) {
        const lm = infer(roi);
        if (lm === null) continue;
        const cand = makeCandidate(lm);
        if (cand === null) continue;
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
      await src.seek((i + 0.5) / fps);
      ctx.drawImage(src.video, 0, 0, W, H);

      let trigger = false;
      try {
        const lm = getLandmarks();
        const r = tracker.step(lm, W, H, dt);
        trigger = r.trigger;
        if (lm !== null && cfg.draw_skeleton) drawSkeleton(ctx, lm, W, H, Math.max(0.5, Math.min(W, H) / 720));
        renderUi(ctx, W, H, r.detection, trigger, tracker.holdManager.holds, cfg);
        errors = 0;
      } catch (e) {
        errors += 1;
        trigger = false;
        log(`フレーム${i}の解析に失敗(原画像で継続): ${e && e.message ? e.message : e}`);
        if (errors >= cfg.max_consecutive_errors) throw new Error("連続エラーが上限に達したため中断しました");
        ctx.drawImage(src.video, 0, 0, W, H);
      }

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
      onProgress(i + 1, total);
      if ((i + 1) % 100 === 0) log(`処理中: ${i + 1}フレーム (${Math.round((100 * (i + 1)) / total)}%)`);
    }

    log("エンコードを完了しています…");
    const outFrames = encoder.count;
    const blob = await encoder.finish();
    const result = {
      frames: total, fps, width: W, height: H,
      out_seconds: +(outFrames / fps).toFixed(2), src_seconds: +(total / fps).toFixed(2),
      holds_total: tracker.holdManager.totalRegistered, pauses, rejected_frames: rejectedCount,
      codec: encoder.codec, container: encoder.container, mode: cfg.mode,
    };
    log(`=== 解析完了 | ${total}フレーム / ホールド累計${result.holds_total}個 / 停止${pauses}回 ===`);
    return { blob, ext: encoder.ext, mime: encoder.mime, events, result };
  } catch (e) {
    if (encoder) encoder.abort();
    throw e;
  } finally {
    src.dispose();
  }
}
