"""感度(標準/ゆるめ)と診断パネルを、画面から実ブラウザで確認する。"""
import os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
tmp = tempfile.mkdtemp()
video = os.path.join(tmp, "demo.webm")
subprocess.run([sys.executable, os.path.join(ROOT, "tests", "browser", "make_test_video.py"), video], check=True, stdout=subprocess.DEVNULL)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8777", "--bind", "127.0.0.1", "-d", os.path.join(ROOT, "docs")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
fake = open(os.path.join(ROOT, "tests", "browser", "fakepose_factory.js"), encoding="utf-8").read()

def waitjs(pg, expr, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(expr): return
        time.sleep(0.3)
    raise TimeoutError(expr)

def run(pg, sens):
    pg.evaluate("window.MUKO_SCENARIO = 'weak'")
    pg.select_option("#sens", sens)
    pg.fill("#pause", "1")
    pg.click("#start")
    waitjs(pg, "!document.getElementById('result').classList.contains('hidden')")
    names = [t.split("\n")[-1] for t in pg.locator("#moves li").all_inner_texts()]
    pg.evaluate("document.getElementById('diagBox').open = true")
    diag = pg.evaluate("document.getElementById('diag').innerText")
    return names, diag

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1000, "height": 1500})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.add_init_script(fake)
    pg.goto("http://127.0.0.1:8777/")
    print("感度の既定値:", pg.input_value("#sens"))
    pg.set_input_files("#file", video)
    pg.wait_for_selector("#previewWrap:not(.hidden)"); pg.wait_for_timeout(500)

    names, diag = run(pg, "standard")
    print("標準     :", names)
    print("  診断(抜粋):")
    for line in diag.split("\n"):
        if any(k in line for k in ("骨格が使えた", "使えなかった理由", "足首が体の中心", "左フラッギング", "ゆるめ")):
            print("   ", line.strip()[:150])
    pg.screenshot(path="/tmp/diag_standard.png", full_page=True)
    pg.click("#again"); pg.wait_for_timeout(300)

    names2, diag2 = run(pg, "relaxed")
    print("ゆるめ   :", names2)
    print("  診断の助言に「感度」の案内が出ない(検出できたため):", "感度を" not in diag2)
    print("page errors:", errs)
    b.close()
srv.terminate()
