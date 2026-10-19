"""実ブラウザ(Chromium)で画面操作を通しで確認する。"""
import os
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
tmp = tempfile.mkdtemp()
video = os.path.join(tmp, "クライミング 課題1.webm")
subprocess.run([sys.executable, os.path.join(ROOT, "tests", "browser", "make_test_video.py"), video], check=True,
               stdout=subprocess.DEVNULL)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8772", "--bind", "127.0.0.1", "-d",
                        os.path.join(ROOT, "docs")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
def waitjs(pg, expr, timeout=60):
    """CSP(unsafe-eval 禁止)の下でも動く待機: page.wait_for_function は内部で eval するため使えない。"""
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(expr):
            return
        time.sleep(0.2)
    raise TimeoutError(expr)

fake = open(os.path.join(ROOT, "tests", "browser", "fakepose_factory.js"), encoding="utf-8").read()

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1000, "height": 1400})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.add_init_script(fake)
    pg.goto("http://127.0.0.1:8772/")
    print("version:", pg.inner_text("#ver"), "| footer ok:", "©武庫労山" in pg.inner_text("#copy"),
          "| start disabled:", pg.is_disabled("#start"))

    pg.set_input_files("#file", video)
    pg.wait_for_selector("#previewWrap:not(.hidden)")
    pg.wait_for_timeout(800)
    box = pg.locator("#roi").bounding_box()
    pg.mouse.move(box["x"] + box["width"] * .2, box["y"] + box["height"] * .05)
    pg.mouse.down(); pg.mouse.move(box["x"] + box["width"] * .8, box["y"] + box["height"] * .95, steps=5); pg.mouse.up()
    print("ROI clear button visible:", pg.is_visible("#roiClear"), "| start enabled:", pg.is_enabled("#start"))
    pg.fill("#pause", "1")
    pg.select_option("#complexity", "1")
    pg.click("#start")
    pg.wait_for_selector("#stepProgress:not(.hidden)")
    pg.wait_for_timeout(2500)
    print("progress text:", pg.inner_text("#status"))
    pg.screenshot(path="/tmp/ui_progress.png")
    pg.wait_for_selector("#result:not(.hidden)", timeout=120000)
    pg.wait_for_timeout(800)
    print("chips:", pg.inner_text("#chips").replace("\n", " | "))
    print("moves:", [t.replace("\n", " ") for t in pg.locator("#moves li").all_inner_texts()])
    print("fmt note visible (webm expected here):", pg.is_visible("#fmtNote"))
    print("download attr:", pg.get_attribute("#dl", "download"))
    pg.locator("#moves button").nth(1).click()
    pg.wait_for_timeout(1500)
    print("video: duration", round(pg.evaluate("document.getElementById('rv').duration"), 2),
          "currentTime", round(pg.evaluate("document.getElementById('rv').currentTime"), 2),
          "error", pg.evaluate("document.getElementById('rv').error"))
    pg.screenshot(path="/tmp/ui_result.png", full_page=True)

    # 再実行(同じモデルを再利用) → キャンセル
    pg.click("#again"); pg.wait_for_timeout(300)
    print("result hidden after again:", pg.is_hidden("#result"), "| start enabled:", pg.is_enabled("#start"))
    pg.click("#start")
    waitjs(pg, "document.getElementById('status').textContent.includes('解析中')", 30)
    pg.click("#cancel")
    waitjs(pg, "document.getElementById('status').textContent.includes('キャンセルしました')", 30)
    print("cancel:", pg.inner_text("#status"), "| result hidden:", pg.is_hidden("#result"), "| start enabled:", pg.is_enabled("#start"))

    # 不正な設定 → エラー表示 / モデル読み込み失敗 → エラー表示
    pg.fill("#pause", "99"); pg.click("#start")
    pg.wait_for_selector("#errBox:not(.hidden)")
    print("bad setting error:", pg.inner_text("#errBox"))
    pg.fill("#pause", "1"); pg.evaluate("window.MUKO_FAIL = true")
    pg.select_option("#complexity", "0")
    pg.click("#start")
    waitjs(pg, "document.getElementById('errBox').textContent.includes('モデル')", 30)
    print("model failure error:", pg.inner_text("#errBox"), "| start enabled:", pg.is_enabled("#start"))
    print("page errors:", [e for e in errs if "Failed to load resource" not in e])
    b.close()
srv.terminate()
