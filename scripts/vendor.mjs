// 同梱ライブラリ(docs/vendor)を npm の固定バージョンから作り直し、SHA256SUMS を更新する。
//   npm ci --ignore-scripts && npm run vendor
// 手でファイルを置き換えた場合は、テスト(tests/security.test.js)がハッシュの不一致で失敗する。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nm = path.join(root, "node_modules");
const out = path.join(root, "docs", "vendor");
const FILES = [
  ["@mediapipe/tasks-vision/vision_bundle.mjs", "tasks-vision/vision_bundle.mjs"],
  ["@mediapipe/tasks-vision/wasm/vision_wasm_internal.js", "tasks-vision/wasm/vision_wasm_internal.js"],
  ["@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm", "tasks-vision/wasm/vision_wasm_internal.wasm"],
  ["mp4-muxer/build/mp4-muxer.mjs", "mp4-muxer.mjs"],
  ["webm-muxer/build/webm-muxer.mjs", "webm-muxer.mjs"],
];
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const lines = [];
for (const [from, to] of FILES) {
  const src = path.join(nm, from);
  if (!fs.existsSync(src)) throw new Error(`見つかりません: ${src}(先に npm ci --ignore-scripts を実行してください)`);
  let buf = fs.readFileSync(src);
  if (to.endsWith("vision_bundle.mjs")) {          // 参照先が無い sourceMappingURL コメントを除く
    buf = Buffer.from(buf.toString("utf8").replace(/^\/\/# sourceMappingURL=.*$/gm, ""), "utf8");
  }
  const dst = path.join(out, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, buf);
  lines.push(`${sha(buf)}  ${to}`);
}
fs.writeFileSync(path.join(out, "SHA256SUMS"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
