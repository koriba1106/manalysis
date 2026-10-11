"""実ブラウザ(Chromium)で解析ループ→エンコードまでを通し、Python 版と結果を突き合わせる。"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
site = tempfile.mkdtemp()
os.symlink(os.path.join(ROOT, "docs", "js"), os.path.join(site, "js"))
os.symlink(os.path.join(ROOT, "docs", "vendor"), os.path.join(site, "vendor"))
os.makedirs(os.path.join(site, "t"))
video = os.path.join(site, "t", "demo.webm")
subprocess.run([sys.executable, os.path.join(ROOT, "tests", "browser", "make_test_video.py"), video], check=True)
open(os.path.join(site, "t", "index.html"), "w").write("<html><body>test</body></html>")

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8771", "--bind", "127.0.0.1", "-d", site],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

PAGE_JS = r"""
async ({roi, lock, fpsOverride}) => {
  const { analyzeVideo } = await import("/js/analyzer.js");
  const { makeConfig } = await import("/js/core.js");
  const blob = await (await fetch("/t/demo.webm")).blob();
  const file = new File([blob], "demo.webm", { type: "video/webm" });

  const U = 60;
  const base = () => { const p = {}; for (let i = 0; i < 33; i++) p[i] = [0, 3]; p[0] = [0, 2.3];
    Object.assign(p, {11:[-.5,1.667],12:[.5,1.667],13:[-.7,2.2],14:[.7,2.2],15:[-.8,2.6],16:[.8,2.6],
      17:[-.8,2.8],18:[.8,2.8],19:[-.8,2.8],20:[.8,2.8],21:[-.8,2.8],22:[.8,2.8],23:[-.5,0],24:[.5,0],
      25:[-.5,-1],26:[.5,-1],27:[-.5,-2],28:[.5,-2],29:[-.5,-2.1],30:[.5,-2.1],31:[-.5,-2.2],32:[.5,-2.2]});
    return p; };
  const w = (over) => Object.assign(base(), over);
  const NEUTRAL = base();
  const HEEL_R = w({26:[.9,-.8],28:[1.7,-.4],30:[1.75,-.05]});
  const DROP_R = w({26:[.3,-1],28:[1,-1.2],30:[1.05,-1.3]});
  const CROSS_R = w({16:[-.9,2.6],15:[.9,2.6]});
  const script = (i) => i>=60&&i<100 ? HEEL_R : i>=130&&i<190 ? DROP_R : i>=200&&i<240 ? CROSS_R : NEUTRAL;

  const canvas = document.createElement("canvas");
  const seenFrames = [];
  let calls = 0;
  const pose = {
    beginVideo() {},
    close() {},
    detect(source) {
      calls++;
      // 作業キャンバス左上のバイナリブロックから「今処理中のフレーム番号」を復元
      const c0 = canvas.getContext("2d").getImageData(0, 0, 120, 20).data;
      let idx = 0;
      for (let k = 0; k < 8; k++) { const o = ((10 * 120) + 4 + k * 14 + 6) * 4; if (c0[o] > 128) idx |= (1 << k); }
      if (seenFrames[seenFrames.length - 1] !== idx) seenFrames.push(idx);
      const sctx = source.getContext("2d");
      const img = sctx.getImageData(0, 0, source.width, source.height).data;
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
        const o = (y * source.width + x) * 4;
        if (img[o] > 180 && img[o+2] > 180 && img[o+1] < 90) { sx += x; sy += y; n++; }
      }
      if (n < 5) return null;
      const cx = sx / n, cy = sy / n;
      const pose = script(idx);
      const out = [];
      for (let i = 0; i < 33; i++) out.push([(cx - pose[i][0] * U) / source.width, (cy - pose[i][1] * U) / source.height, 0.99]);
      return out;
    },
  };
  const cfg = makeConfig({ pause_duration_sec: 1.0, lock_climber: lock, initial_roi: roi });
  const progress = [];
  const logs = [];
  const t0 = performance.now();
  const r = await analyzeVideo({ file, cfg, pose, canvas, fps: fpsOverride, onProgress: (d, t) => progress.push(d),
    onLog: (m) => logs.push(m) });
  const buf = new Uint8Array(await r.blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  // 画面外でも使えるよう、停止フレームの canvas を PNG で返す
  return { events: r.events, result: r.result, ext: r.ext, size: buf.length, b64: btoa(bin),
    seenOK: seenFrames.length, seenSample: seenFrames.slice(0, 5), seenLast: seenFrames[seenFrames.length - 1],
    seenMonotonic: seenFrames.every((v, i) => i === 0 || v === seenFrames[i-1] + 1),
    seenGaps: seenFrames.map((v, i) => i === 0 ? null : [seenFrames[i-1], v]).filter((x) => x && x[1] !== x[0] + 1).slice(0, 12), seenCount: seenFrames.length,
    calls, progressLast: progress[progress.length - 1], logs: logs.slice(0, 6), ms: Math.round(performance.now() - t0) };
}
"""

def run(page, **kw):
    return page.evaluate(PAGE_JS, {"roi": kw.get("roi"), "lock": kw.get("lock", True), "fpsOverride": kw.get("fps", 0)})

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto("http://127.0.0.1:8771/t/index.html")

    print("WebCodecs:", pg.evaluate("typeof VideoEncoder + '/' + typeof VideoDecoder"))
    res = run(pg)
    out = os.path.join(site, "out." + res["ext"])
    open(out, "wb").write(base64.b64decode(res.pop("b64")))
    print("elapsed ms:", res["ms"], "| ext:", res["ext"], "| bytes:", res["size"])
    print("result:", json.dumps(res["result"], ensure_ascii=False))
    print("events:", [(e["frame"], e["move"], e["t_out"]) for e in res["events"]])
    print("frames seen: first", res["seenSample"], "last", res["seenLast"], "monotonic +1 each:", res["seenMonotonic"],
          "| detect calls:", res["calls"], "| progress last:", res["progressLast"])
    print("gaps:", res["seenGaps"], "count", res["seenCount"])
    print("logs:", res["logs"][:3])
    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=codec_name,width,height,nb_frames,r_frame_rate", "-of", "json", out], capture_output=True).stdout)["streams"][0]
    print("ffprobe:", probe)
    json.dump({"events": res["events"], "result": res["result"]}, open("/tmp/js_events.json", "w"))
    # ROI 指定 / 固定なしでも同じ結果になること
    for label, kw in (("ROI(中央)", dict(roi=[0.2, 0.0, 0.8, 1.0])), ("固定なし", dict(lock=False)),
                      ("fps自動検出→手動30", dict(fps=30))):
        r2 = run(pg, **kw); r2.pop("b64")
        print(label, [(e["frame"], e["move"]) for e in r2["events"]], "fps", r2["result"]["fps"], "ms", r2["ms"])
    # 不正な ROI(画面右端のみ) → 人物が見つからず何も起きない
    r3 = run(pg, roi=[0.85, 0.0, 1.0, 1.0]); r3.pop("b64")
    print("ROI(右端のみ) events:", r3["events"])
    print("page errors:", errs)
    b.close()
srv.terminate()
