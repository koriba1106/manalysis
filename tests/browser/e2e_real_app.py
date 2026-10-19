"""
(任意・手動) 本物の index.html(CSP 有効)を、本物の MediaPipe モデルで通しで動かす。骨格推定は模擬しない。
  python build_test_model.py /tmp/pose_landmarker_full.task
  python e2e_real_app.py /tmp/pose_landmarker_full.task
必要: playwright(chromium), opencv-python, scikit-image(人物のサンプル画像), ffmpeg
確認すること: 推論が動く / CSP 違反が 0 件 / コンソールエラーが 0 件 / 公開環境ではテスト用フックが無効
"""
import os, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

model = os.path.abspath(sys.argv[1])
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
site = tempfile.mkdtemp()
for name in os.listdir(os.path.join(ROOT, "docs")):
    if name != "models":
        os.symlink(os.path.join(ROOT, "docs", name), os.path.join(site, name))
os.makedirs(os.path.join(site, "models"))
shutil.copy(model, os.path.join(site, "models", "pose_landmarker_full.task"))   # complexity 1 = full

import cv2, numpy as np
from skimage import data
person = cv2.cvtColor(data.astronaut(), cv2.COLOR_RGB2BGR)
tmp = tempfile.mkdtemp()
wr = cv2.VideoWriter(os.path.join(tmp, "p.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), 30, (720, 720))
for i in range(20):
    img = np.full((720, 720, 3), 70, np.uint8)
    dx = int(5 * np.sin(i / 4)); img[104:616, 104 + dx:616 + dx] = person
    wr.write(img)
wr.release()
video = os.path.join(tmp, "p.webm")
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", os.path.join(tmp, "p.mp4"), "-c:v", "libvpx", "-b:v", "3M", "-an", video], check=True)

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8791", "--bind", "127.0.0.1", "-d", site], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
ok = True
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1000, "height": 1400})
    msgs, errs = [], []
    pg.add_init_script("window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));")
    pg.on("console", lambda m: msgs.append((m.type, m.text[:200])))
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto("http://127.0.0.1:8791/")
    hook = pg.evaluate("typeof window.MUKO_POSE_FACTORY !== 'undefined'")
    pg.set_input_files("#file", video)
    pg.wait_for_selector("#previewWrap:not(.hidden)"); pg.wait_for_timeout(500)
    pg.select_option("#complexity", "1"); pg.select_option("#poseSize", "512")
    pg.click("#start")
    end = time.time() + 240
    while time.time() < end and not (pg.is_visible("#result") or pg.is_visible("#errBox")):
        time.sleep(1)
    err = pg.inner_text("#errBox") if pg.is_visible("#errBox") else ""
    log = pg.evaluate("document.getElementById('log').textContent")
    csp = pg.evaluate("window.__csp")
    cerr = [m for m in msgs if m[0] == "error"]
    print("\n".join("  log: " + l for l in log.split("\n") if l.strip()))
    print("結果表示:", pg.is_visible("#result"), "| エラー表示:", repr(err), "| CSP違反:", csp, "| consoleエラー:", cerr, "| pageエラー:", errs)
    ok = pg.is_visible("#result") and not err and not csp and not cerr and not errs and not hook and "対象クライマーを固定しました" in log
    b.close()
srv.terminate()
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
