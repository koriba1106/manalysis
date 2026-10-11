// MP4(H.264) 出力経路の検証。ブラウザのエンコーダの代わりに ffmpeg で作った本物の H.264 データを流し込み、
// encoder.js(コーデック選択 → mp4-muxer → ファイル化)を通して、出力が正しい MP4 になることを確認する。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const have = (cmd) => spawnSync(cmd, ["-version"]).status === 0;
const skip = !(have("ffmpeg") && have("ffprobe"));

function parseAnnexB(buf) {
  const nals = [];
  let i = 0, start = -1;
  while (i + 3 <= buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      const sc = buf[i + 2] === 1 ? 3 : 4;
      if (start >= 0) nals.push(buf.subarray(start, i));
      start = i + sc; i += sc;
    } else i += 1;
  }
  if (start >= 0) nals.push(buf.subarray(start));
  return nals;
}

function buildAvc(buf) {
  const nals = parseAnnexB(buf);
  let sps = null, pps = null;
  const aus = [];
  for (const n of nals) {
    const t = n[0] & 0x1f;
    if (t === 7) sps = n; else if (t === 8) pps = n;
    else if (t === 1 || t === 5) {            // B フレーム無し・1スライス/フレームを前提(1 NAL = 1 AU)
      const out = new Uint8Array(4 + n.length);
      new DataView(out.buffer).setUint32(0, n.length); out.set(n, 4);
      aus.push({ data: out, key: t === 5 });
    }
  }
  const desc = new Uint8Array(11 + sps.length + pps.length);
  const dv = new DataView(desc.buffer);
  desc.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1], 0); dv.setUint16(6, sps.length); desc.set(sps, 8);
  desc[8 + sps.length] = 1; dv.setUint16(9 + sps.length, pps.length); desc.set(pps, 11 + sps.length);
  return { aus, desc, codec: `avc1.${[sps[1], sps[2], sps[3]].map((x) => x.toString(16).padStart(2, "0")).join("")}` };
}

test("MP4(H.264) 経路: createVideoEncoder → mp4-muxer → 正しい faststart MP4", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp4t-"));
  const h264 = path.join(dir, "in.h264");
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-frames:v", "120",
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-bf", "0", "-x264-params", "keyint=60:min-keyint=60:scenecut=0",
    "-f", "h264", h264]);
  assert.equal(r.status, 0, String(r.stderr));
  const { aus, desc, codec } = buildAvc(fs.readFileSync(h264));
  assert.equal(aus.length, 120);
  assert.deepEqual([0, 60].map((i) => aus[i].key), [true, true]);

  // ブラウザ API の最小モック(エンコーダは ffmpeg 製データを順番に返す)
  let calls = 0;
  globalThis.EncodedVideoChunk = class { constructor(o) { Object.assign(this, o); this.byteLength = o.data.length; }
    copyTo(dst) { dst.set(this.data); } };
  globalThis.VideoFrame = class { constructor(_s, o) { this.timestamp = o.timestamp; } close() {} };
  globalThis.VideoEncoder = class {
    static async isConfigSupported(c) { return { supported: c.codec.startsWith("avc1") }; }
    constructor(init) { this.init = init; this.encodeQueueSize = 0; this.first = true; }
    configure(c) { assert.ok(c.codec.startsWith("avc1")); assert.equal(c.avc.format, "avc"); }
    encode(frame, opts) {
      const au = aus[calls++];
      assert.equal(!!opts.keyFrame, au.key, `キーフレーム要求が AU と一致 (#${calls - 1})`);
      const chunk = new EncodedVideoChunk({ type: au.key ? "key" : "delta", timestamp: frame.timestamp, duration: 33333, data: au.data });
      this.init.output(chunk, this.first || au.key ? { decoderConfig: { codec, description: desc } } : {});
      this.first = false;
    }
    async flush() {}
    close() {}
  };

  const { createVideoEncoder } = await import("../docs/js/encoder.js");
  const enc = await createVideoEncoder({ width: 320, height: 240, fps: 30 });
  assert.equal(enc.container, "mp4"); assert.equal(enc.ext, "mp4"); assert.equal(enc.codec, "H.264");
  for (let i = 0; i < 70; i++) await enc.encodeCanvas({}, 1);
  assert.equal(enc.count, 70);
  await enc.encodeCanvas({}, 31);                       // 停止区間(1+30フレーム)
  assert.equal(enc.count, 101);
  for (let i = 0; i < 19; i++) await enc.encodeCanvas({}, 1);
  const blob = await enc.finish();
  assert.equal(blob.type, "video/mp4");

  const out = path.join(dir, "out.mp4");
  fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  const pr = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
    "stream=codec_name,pix_fmt,width,height,nb_read_frames,avg_frame_rate:format=duration", "-of", "json", out]);
  const j = JSON.parse(pr.stdout);
  assert.equal(j.streams[0].codec_name, "h264");
  assert.equal(j.streams[0].width, 320); assert.equal(j.streams[0].height, 240);
  assert.equal(Number(j.streams[0].nb_read_frames), 120);
  assert.ok(Math.abs(Number(j.format.duration) - 4.0) < 0.1, `duration ${j.format.duration}`);
  const dec = spawnSync("ffmpeg", ["-v", "error", "-i", out, "-f", "null", "-"]);       // デコードエラーが無いこと
  assert.equal(dec.status, 0); assert.equal(String(dec.stderr).trim(), "");
  const bytes = fs.readFileSync(out);
  assert.ok(bytes.indexOf("moov") < bytes.indexOf("mdat"), "faststart(moov が先頭側)");
  fs.rmSync(dir, { recursive: true, force: true });
});
