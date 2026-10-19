/** WebCodecs による動画エンコード。MP4(H.264) を優先し、使えなければ WebM(VP9/VP8)。 */
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "../vendor/mp4-muxer.mjs";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "../vendor/webm-muxer.mjs";

export function webCodecsSupported() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined" && typeof VideoDecoder !== "undefined";
}

async function pickConfig(width, height, fps, bitrate) {
  const big = width * height > 1920 * 1088;
  const cands = [
    { codec: big ? "avc1.640033" : "avc1.64002A", container: "mp4", mux: "avc", label: "H.264" },
    { codec: "avc1.4D4028", container: "mp4", mux: "avc", label: "H.264" },
    { codec: "avc1.42E01F", container: "mp4", mux: "avc", label: "H.264" },
    { codec: "vp09.00.10.08", container: "webm", mux: "V_VP9", label: "VP9" },
    { codec: "vp8", container: "webm", mux: "V_VP8", label: "VP8" },
  ];
  for (const c of cands) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width, height, bitrate, framerate: fps });
      if (r.supported) return c;
    } catch (e) { /* 次の候補へ */ }
  }
  return null;
}

/** 出力ビットレート(bps)。出力サイズの事前見積もりにも使う */
export function estimateBitrate(width, height, fps) {
  return Math.round(Math.min(40e6, Math.max(2e6, width * height * fps * 0.12)));
}

const sleep0 = () => new Promise((r) => setTimeout(r, 0));

export async function createVideoEncoder({ width, height, fps }) {
  const bitrate = estimateBitrate(width, height, fps);
  const pick = await pickConfig(width, height, fps, bitrate);
  if (!pick) throw new Error("このブラウザは動画のエンコード(WebCodecs)に対応していません。PC版の Chrome / Edge / Safari 16.4 以降をお使いください。");
  const mp4 = pick.container === "mp4";
  const target = mp4 ? new Mp4Target() : new WebmTarget();
  const muxer = mp4
    ? new Mp4Muxer({ target, video: { codec: "avc", width, height }, fastStart: "in-memory", firstTimestampBehavior: "offset" })
    : new WebmMuxer({ target, video: { codec: pick.mux, width, height, frameRate: fps }, firstTimestampBehavior: "offset" });
  let error = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { error = error || e; } },
    error: (e) => { error = error || e; },
  });
  enc.configure({ codec: pick.codec, width, height, bitrate, framerate: fps, ...(mp4 ? { avc: { format: "avc" } } : {}) });
  const keyInterval = Math.max(1, Math.round(fps * 2));
  const dur = Math.round(1e6 / fps);
  let n = 0;
  const ts = (i) => Math.round((i * 1e6) / fps);

  return {
    codec: pick.label, container: pick.container, ext: mp4 ? "mp4" : "webm",
    mime: mp4 ? "video/mp4" : "video/webm",
    get count() { return n; },
    /** canvas の現在の内容を repeat フレームぶん書き出す(停止区間は repeat>1) */
    async encodeCanvas(canvas, repeat = 1) {
      if (error) throw error;
      const base = new VideoFrame(canvas, { timestamp: ts(n), duration: dur });
      try {
        for (let k = 0; k < repeat; k++) {
          const f = k === 0 ? base : new VideoFrame(base, { timestamp: ts(n), duration: dur });
          enc.encode(f, { keyFrame: n % keyInterval === 0 });
          if (f !== base) f.close();
          n += 1;
          while (enc.encodeQueueSize > 12) { await sleep0(); if (error) throw error; }
        }
      } finally { base.close(); }
    },
    async finish() {
      await enc.flush();
      if (error) throw error;
      muxer.finalize();
      enc.close();
      return new Blob([target.buffer], { type: mp4 ? "video/mp4" : "video/webm" });
    },
    abort() { try { enc.close(); } catch (e) { /* 既に閉じている */ } },
  };
}
