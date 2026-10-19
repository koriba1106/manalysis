"""カウンターバランスの修正が、画面のチェックボックスまで配線されていることを実ブラウザで確認する。"""
import os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
tmp = tempfile.mkdtemp()
video = os.path.join(tmp, "demo.webm")
subprocess.run([sys.executable, os.path.join(ROOT, "tests", "browser", "make_test_video.py"), video], check=True, stdout=subprocess.DEVNULL)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8776", "--bind", "127.0.0.1", "-d", os.path.join(ROOT, "docs")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
fake = open(os.path.join(ROOT, "tests", "browser", "fakepose_factory.js"), encoding="utf-8").read()

def waitjs(pg, expr, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(expr): return
        time.sleep(0.3)
    raise TimeoutError(expr)

def run(pg, counter_on):
    pg.evaluate("window.MUKO_SCENARIO = 'counter'")
    pg.set_checked("#counter", counter_on)
    pg.fill("#pause", "1")
    pg.click("#start")
    waitjs(pg, "!document.getElementById('result').classList.contains('hidden')")
    names = [t.split("\n")[-1] for t in pg.locator("#moves li").all_inner_texts()]
    pg.click("#again"); pg.wait_for_timeout(300)
    return names

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page()
    pg.add_init_script(fake)
    pg.goto("http://127.0.0.1:8776/")
    pg.set_input_files("#file", video)
    pg.wait_for_selector("#previewWrap:not(.hidden)"); pg.wait_for_timeout(500)
    print("カウンターバランスを区別する = ON :", run(pg, True))
    print("カウンターバランスを区別する = OFF:", run(pg, False))
    b.close()
srv.terminate()
