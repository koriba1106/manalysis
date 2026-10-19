"""処理速度の計測(実ブラウザ)。
  kind=a : フルHD 150フレーム。推論は 25ms の busy-wait で模擬(シーク・描画・符号化など推論以外の部分を測る)
  kind=b : 本物の MediaPipe(CPU)で人物画像のフルHD動画 45フレームを処理(クライマー固定あり)
使い方: python bench.py <site_dir> <js_dir名: js_before|js> <a|b>
"""
import json, subprocess, sys, time
from playwright.sync_api import sync_playwright

site, jsdir, kind = sys.argv[1], sys.argv[2], sys.argv[3]
extra = sys.argv[4] if len(sys.argv) > 4 else "{}"   # analyzeVideo への追加オプション(JSON)
port = 8780 + (hash(jsdir + kind) % 50)
srv = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "-d", site],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
JS = r"""
async ({js, kind, extra}) => {
  const { analyzeVideo } = await import(`/${js}/analyzer.js`);
  const { makeConfig } = await import(`/${js}/core.js`);
  const file = new File([await (await fetch(`/v/${kind}.webm`)).blob()], `${kind}.webm`, { type: "video/webm" });
  let pose, loadMs = 0;
  if (kind === "a") {
    const FIX = []; for (let i = 0; i < 33; i++) FIX.push([0.5, 0.3 + i * 0.01, 0.99]);
    Object.assign(FIX, { 11: [0.47, 0.42, .99], 12: [0.53, 0.42, .99], 23: [0.48, 0.62, .99], 24: [0.52, 0.62, .99],
      15: [0.44, 0.30, .99], 16: [0.56, 0.30, .99], 25: [0.48, 0.78, .99], 26: [0.52, 0.78, .99],
      27: [0.48, 0.92, .99], 28: [0.52, 0.92, .99], 29: [0.48, 0.94, .99], 30: [0.52, 0.94, .99] });
    pose = { beginVideo() {}, close() {}, detect() { const t = performance.now(); while (performance.now() - t < 25); return FIX; } };
  } else {
    const t0 = performance.now();
    const { FilesetResolver, PoseLandmarker } = await import("/vendor/tasks-vision/vision_bundle.mjs");
    const fs = await FilesetResolver.forVisionTasks("/vendor/tasks-vision/wasm");
    const lm = await PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: "/models/pose_landmarker_full.task", delegate: "CPU" },
      runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5, minTrackingConfidence: .5 });
    loadMs = Math.round(performance.now() - t0);
    let ts = 0, step = 33, inferMs = 0, calls = 0;
    pose = { beginVideo(f) { step = Math.round(1000 / f); ts = 0; }, close() {}, stats: () => ({ inferMs, calls }),
      detect(src) { ts += step; const t = performance.now(); const r = lm.detectForVideo(src, ts); inferMs += performance.now() - t; calls++;
        const l = r.landmarks && r.landmarks[0]; return l ? l.map((p) => [p.x, p.y, p.visibility ?? 0]) : null; } };
    window.__pose = pose;
  }
  const cfg = makeConfig({ lock_climber: kind === "b", min_visibility: 0.5, pause_duration_sec: 0.5, model_complexity: 1 });
  const canvas = document.createElement("canvas");
  const t0 = performance.now();
  const r = await analyzeVideo({ file, cfg, pose, canvas, fps: 30, maxSide: 1920, onProgress() {}, onLog() {}, ...JSON.parse(extra) });
  const ms = performance.now() - t0;
  const out = { ms: Math.round(ms), frames: r.result.frames, perFrame: +(ms / r.result.frames).toFixed(1), loadMs,
    codec: r.result.codec, bytes: r.blob.size, rejected: r.result.rejected_frames, timings: r.result.timings || null };
  if (pose.stats) out.infer = pose.stats();
  return out;
}
"""
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"http://127.0.0.1:{port}/v/index.html")
    r = pg.evaluate(JS, {"js": jsdir, "kind": kind, "extra": extra})
    print(json.dumps(r, ensure_ascii=False))
    if errs: print("errors:", errs[:3])
    b.close()
srv.terminate()
