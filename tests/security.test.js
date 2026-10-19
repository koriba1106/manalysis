// セキュリティの静的検査(CI で毎回実行): CSP の厳格さ / 危険な API の不使用 / 外部通信先 / 同梱ライブラリの改ざん検出
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docs = path.join(root, "docs");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const jsFiles = fs.readdirSync(path.join(docs, "js")).filter((f) => f.endsWith(".js")).map((f) => `docs/js/${f}`);
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

test("同梱ライブラリが SHA256SUMS と一致(改ざん・取り違えの検出)", () => {
  const lines = read("docs/vendor/SHA256SUMS").trim().split("\n");
  assert.equal(lines.length, 5);
  for (const line of lines) {
    const [hash, name] = line.split(/\s+/);
    const file = path.join(docs, "vendor", name);
    assert.ok(fs.existsSync(file), `${name} がありません`);
    assert.equal(sha(fs.readFileSync(file)), hash, `${name} のハッシュが一致しません`);
  }
});

test("同梱ライブラリが固定バージョンの npm パッケージと一致(node_modules がある場合)", { skip: !fs.existsSync(path.join(root, "node_modules/mp4-muxer")) }, () => {
  const map = {
    "tasks-vision/vision_bundle.mjs": "@mediapipe/tasks-vision/vision_bundle.mjs",
    "tasks-vision/wasm/vision_wasm_internal.js": "@mediapipe/tasks-vision/wasm/vision_wasm_internal.js",
    "tasks-vision/wasm/vision_wasm_internal.wasm": "@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm",
    "mp4-muxer.mjs": "mp4-muxer/build/mp4-muxer.mjs",
    "webm-muxer.mjs": "webm-muxer/build/webm-muxer.mjs",
  };
  for (const [vendored, pkg] of Object.entries(map)) {
    let src = fs.readFileSync(path.join(root, "node_modules", pkg));
    if (vendored.endsWith("vision_bundle.mjs")) src = Buffer.from(src.toString("utf8").replace(/^\/\/# sourceMappingURL=.*$/gm, ""), "utf8");
    assert.equal(sha(fs.readFileSync(path.join(docs, "vendor", vendored))), sha(src), `${vendored} が ${pkg} と異なります`);
  }
});

test("依存は厳密なバージョンで固定されている(範囲指定なし)", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const [name, ver] of Object.entries(pkg.devDependencies)) assert.match(ver, /^\d+\.\d+\.\d+$/, `${name}: ${ver}`);
  assert.ok(fs.existsSync(path.join(root, "package-lock.json")));
});

test("危険な API を使っていない(XSS・コード実行)", () => {
  const banned = [/\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/,
    /set(Timeout|Interval)\s*\(\s*["'`]/, /\bimportScripts\b/, /\.srcdoc\b/];
  for (const f of [...jsFiles, "docs/index.html"]) {
    const text = read(f);
    for (const re of banned) assert.ok(!re.test(text), `${f}: ${re} を使っています`);
  }
});

test("index.html: インラインのスクリプト/スタイル/イベント属性が無い(CSP で許可していないため)", () => {
  const html = read("docs/index.html");
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /\bsrc="/, "src の無い <script>");
    assert.equal(m[2].trim(), "", "インラインのスクリプト本文");
  }
  assert.ok(!/<style\b/i.test(html), "<style> ブロック");
  assert.ok(!/\sstyle\s*=/i.test(html), "style 属性");
  assert.ok(!/\son[a-z]+\s*=/i.test(html), "on* イベント属性");
  assert.ok(!/<(iframe|object|embed|form)\b/i.test(html), "iframe/object/embed/form");
});

test("CSP: 厳格な設定になっている", () => {
  const html = read("docs/index.html");
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(m, "CSP の meta がありません");
  const dirs = Object.fromEntries(m[1].split(";").map((s) => s.trim()).filter(Boolean).map((s) => { const [k, ...v] = s.split(/\s+/); return [k, v]; }));
  assert.deepEqual(dirs["default-src"], ["'none'"]);
  assert.deepEqual(dirs["object-src"], ["'none'"]);
  assert.deepEqual(dirs["base-uri"], ["'none'"]);
  assert.deepEqual(dirs["form-action"], ["'none'"]);
  assert.deepEqual(dirs["script-src"], ["'self'", "'wasm-unsafe-eval'"]);   // unsafe-inline / unsafe-eval / 外部ホストなし
  assert.deepEqual(dirs["style-src"], ["'self'"]);
  const all = m[1];
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(all.replace(/wasm-unsafe-eval/g, "")), "unsafe-* やワイルドカード");
  assert.deepEqual(dirs["connect-src"].filter((s) => s.startsWith("http")), ["https://storage.googleapis.com"]);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
});

test("外部への通信先は骨格推定モデルの配布元だけ", () => {
  const allowed = new Set(["https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_"]);
  for (const f of jsFiles) {
    for (const m of read(f).matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      assert.ok([...allowed].some((a) => m[0].startsWith(a)), `${f}: 許可していない URL ${m[0]}`);
    }
  }
});

test("テスト用の差し替えフックは localhost 限定 / 埋め込み表示では動かない", () => {
  const app = read("docs/js/app.js");
  assert.match(app, /IS_LOCAL\s*&&\s*window\.MUKO_POSE_FACTORY/);
  assert.match(app, /window\.top\s*!==\s*window\.self/);
});

test("入力の上限が定義されている(巨大な動画でブラウザが落ちない)", async () => {
  const { LIMITS, prefetchDepthFor } = await import("../docs/js/analyzer.js");
  assert.ok(LIMITS.maxPixels <= 3840 * 2160 && LIMITS.maxFrames > 0 && LIMITS.maxOutputBytes < 2 ** 31);
  assert.equal(prefetchDepthFor(1280, 720), 4);
  assert.equal(prefetchDepthFor(1920, 1080), 3);
  assert.equal(prefetchDepthFor(3840, 2160), 2);     // 大きい動画ほどメモリを使うので先読みを減らす
});
