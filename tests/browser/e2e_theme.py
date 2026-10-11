"""CSS 化の検証: テーマ切替 / 変数の上書き / 進捗バー / 範囲指定の枠色 が CSS から制御できること。"""
import os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
tmp = tempfile.mkdtemp()
video = os.path.join(tmp, "demo.webm")
subprocess.run([sys.executable, os.path.join(ROOT, "tests", "browser", "make_test_video.py"), video], check=True, stdout=subprocess.DEVNULL)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8774", "--bind", "127.0.0.1", "-d", os.path.join(ROOT, "docs")],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
fake = open(os.path.join(ROOT, "tests", "browser", "fakepose_factory.js"), encoding="utf-8").read()
CS = "([sel, prop]) => getComputedStyle(document.querySelector(sel))[prop]"

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 900, "height": 1500})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.add_init_script(fake)
    # OS がライト設定のとき
    pg.emulate_media(color_scheme="light")
    pg.goto("http://127.0.0.1:8774/")
    print("CSS files loaded:", pg.evaluate("[...document.styleSheets].map(s => s.href.split('/').pop())"))
    print("inline style attrs in DOM:", pg.evaluate("document.querySelectorAll('[style]').length"))
    print("auto(light) bg:", pg.evaluate(CS, ["body", "backgroundColor"]))
    pg.select_option("#theme", "dark")
    print("dark   bg:", pg.evaluate(CS, ["body", "backgroundColor"]), "| data-theme:", pg.evaluate("document.documentElement.dataset.theme"))
    pg.reload()
    print("dark persists after reload:", pg.evaluate(CS, ["body", "backgroundColor"]), "| select:", pg.input_value("#theme"))
    pg.select_option("#theme", "light")
    # OS がダークでも「ライト」固定が効く
    pg.emulate_media(color_scheme="dark")
    print("os=dark + theme=light bg:", pg.evaluate(CS, ["body", "backgroundColor"]))
    pg.select_option("#theme", "auto")
    print("os=dark + theme=auto  bg:", pg.evaluate(CS, ["body", "backgroundColor"]))
    pg.emulate_media(color_scheme="light")
    pg.select_option("#theme", "auto")

    # theme.css の変数を上書き → 見た目が変わる(緑テーマの例)
    pg.add_style_tag(content=":root{--color-accent:#2b8a3e;--color-on-accent:#fff;--color-roi:#00aa00;--radius-card:2px;--font-size-title:30px;--progress-height:24px}")
    print("override: primary btn bg:", pg.evaluate(CS, ["#start", "backgroundColor"]),
          "| card radius:", pg.evaluate(CS, [".card", "borderTopLeftRadius"]),
          "| title size:", pg.evaluate(CS, [".page-title", "fontSize"]),
          "| bar height:", pg.evaluate(CS, ["#bar", "height"]))

    # 解析中: 進捗バーの幅は --progress(CSS 変数)で動き、範囲指定の枠色は --color-roi を読む
    pg.set_input_files("#file", video)
    pg.wait_for_selector("#previewWrap:not(.hidden)"); pg.wait_for_timeout(700)
    box = pg.locator("#roi").bounding_box()
    pg.mouse.move(box["x"] + box["width"] * .2, box["y"] + box["height"] * .05); pg.mouse.down()
    pg.mouse.move(box["x"] + box["width"] * .8, box["y"] + box["height"] * .95, steps=4); pg.mouse.up()
    px = pg.evaluate("""() => { const c = document.getElementById('roi'); const x = Math.round(c.width*0.2), y = Math.round(c.height*0.5);
        const d = c.getContext('2d').getImageData(x-1, y, 3, 1).data; return [...d]; }""")
    print("ROI frame pixel (expect green-ish 0,170,0):", px[:4], px[4:8])
    pg.screenshot(path="/tmp/theme_green_top.png")
    pg.click("#start")
    pg.wait_for_function("document.getElementById('status').textContent.includes('解析中')", timeout=60000)
    pg.wait_for_timeout(1500)
    prog = pg.evaluate("document.getElementById('bar').style.getPropertyValue('--progress')")
    w = pg.evaluate("getComputedStyle(document.querySelector('.bar__fill')).width"), pg.evaluate("document.getElementById('bar').clientWidth")
    print("--progress:", prog, "| fill px / bar px:", w, "| fill color:", pg.evaluate(CS, [".bar__fill", "backgroundColor"]))
    pg.wait_for_selector("#result:not(.hidden)", timeout=120000); pg.wait_for_timeout(500)
    print("move time color:", pg.evaluate(CS, [".move-time", "color"]))
    pg.screenshot(path="/tmp/theme_green_full.png", full_page=True)
    print("page errors:", errs)
    b.close()
srv.terminate()
