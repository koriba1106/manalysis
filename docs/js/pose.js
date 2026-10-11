/** 骨格推定(MediaPipe Tasks Vision / PoseLandmarker)。戻り値は [[x,y,visibility]*33](入力画像内の正規化座標) */
const MODEL_NAMES = { 0: "lite", 1: "full", 2: "heavy" };
const GOOGLE_URL = (n) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${n}/float16/latest/pose_landmarker_${n}.task`;

async function exists(url) {
  try { const r = await fetch(url, { method: "HEAD", cache: "no-store" }); return r.ok; } catch (e) { return false; }
}

export async function createPoseBackend({ complexity, minDet, minTrack, log = () => {} }) {
  const { FilesetResolver, PoseLandmarker } = await import("../vendor/tasks-vision/vision_bundle.mjs");
  const fileset = await FilesetResolver.forVisionTasks(new URL("../vendor/tasks-vision/wasm", import.meta.url).href);
  const n = MODEL_NAMES[complexity];
  const sources = [];
  const local = new URL(`../models/pose_landmarker_${n}.task`, import.meta.url).href;
  if (await exists(local)) sources.push(local);
  sources.push(GOOGLE_URL(n));

  let lm = null, used = "", lastErr = null;
  outer: for (const src of sources) {
    for (const delegate of ["GPU", "CPU"]) {
      try {
        log(`骨格推定モデル(${n})を読み込み中… [${delegate}]`);
        lm = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: src, delegate },
          runningMode: "VIDEO", numPoses: 1,
          minPoseDetectionConfidence: minDet, minPosePresenceConfidence: minDet, minTrackingConfidence: minTrack,
        });
        used = `${n}/${delegate}`;
        break outer;
      } catch (e) { lastErr = e; log(`読み込み失敗(${delegate}): ${e && e.message ? e.message : e}`); }
    }
  }
  if (!lm) throw new Error(`骨格推定モデルを読み込めませんでした。ネットワーク接続を確認してください。(${lastErr})`);

  let ts = 0, step = 33;
  return {
    name: `mediapipe-tasks(${used})`,
    beginVideo(fps) { step = Math.max(1, Math.round(1000 / Math.max(fps, 1))); ts = 0; },
    detect(source) {
      ts += step;                               // 同一フレーム内の再試行でも単調増加
      const res = lm.detectForVideo(source, ts);
      const l = res.landmarks && res.landmarks[0];
      if (!l) return null;
      return l.map((p) => [p.x, p.y, p.visibility === undefined || p.visibility === null ? 0 : p.visibility]);
    },
    close() { try { lm.close(); } catch (e) { /* ignore */ } },
  };
}
