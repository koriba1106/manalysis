# ムーブ解析by武庫 Web版 v4.0.0(GitHub Pages / ブラウザ完結)

クライミング動画から骨格・ホールドを検出し、ヒールフック／キョン／クロス／フラッギング／ダイアゴナルで
自動停止する解析動画(MP4)を作ります。**サーバー不要**。GitHub Pages に置くだけで動き、
動画は利用者のブラウザ内だけで処理されます(どこにも送信されません)。

## 公開手順(GitHub だけで完結)

1. このフォルダの中身を新しいリポジトリのルートに push する(`docs/` `.github/` `tests/` `reference/` ごと)
2. リポジトリの **Settings → Pages → Build and deployment → Source を「GitHub Actions」** にする
3. `main` に push すると `deploy-pages` が走り、テスト通過後に公開される
4. `https://<ユーザー名>.github.io/<リポジトリ名>/` を開く

※ Source を「Deploy from a branch(`/docs`)」にしても動きます。その場合モデルは利用者のブラウザが
  Google の配布URLから読み込みます(Actions 経由ならモデルをサイトに同梱し、初回読み込みが自サイト内で完結)。

ローカルで試す: `python3 -m http.server 8000 -d docs` → http://localhost:8000
(ES モジュールと WebCodecs のため、`file://` では動きません。HTTPS か localhost が必要です)

## 対応ブラウザ

動画のエンコードに WebCodecs を使います: PC の **Chrome / Edge**(MP4=H.264 で出力)、**Safari 16.4+**。
Firefox などは WebM(VP9) で出力される場合があります。スマホは動作しますが遅く、メモリも使います。

## 構成

| パス | 役割 |
|---|---|
| `docs/index.html`, `docs/js/app.js` | 画面(ファイル選択、範囲指定、進捗、結果再生、ムーブ一覧) |
| `docs/css/theme.css` | **見た目の設定(色・文字・角丸・余白・サイズの変数)。見た目を変えるときはここ** |
| `docs/css/style.css` | 部品のスタイル(theme.css の変数だけを参照) |
| `docs/js/core.js` | 判定ロジック(体幹座標系・ムーブ判定・安定化・ホールド・クライマー固定)。DOM 非依存 |
| `docs/js/analyzer.js` | 解析ループ(フレーム単位シーク → 骨格推定 → 判定 → 描画 → エンコード、停止フレーム挿入) |
| `docs/js/pose.js` | MediaPipe Tasks Vision(PoseLandmarker)ラッパー |
| `docs/js/render.js`, `encoder.js` | 描画 / WebCodecs エンコード(MP4 優先、WebM フォールバック) |
| `docs/vendor/` | MediaPipe(WASM)、mp4-muxer、webm-muxer(同梱。ライセンスは `LICENSES.md`) |
| `reference/muko_engine.py` | 従来の Python 版エンジン(照合の「正解」) |
| `tests/` | JS 移植の照合テスト、MP4 出力経路のテスト、実ブラウザ E2E |

## 見た目のカスタマイズ(CSS)

見た目は `docs/css/theme.css` の変数を書き換えるだけで変えられます(HTML・JS の修正は不要)。

```css
:root {
  --color-accent: #2b8a3e;     /* 強調色: 主ボタン・進捗バー・ムーブ時刻 */
  --color-roi: #2b8a3e;        /* クライマー範囲指定の枠 */
  --radius-card: 4px;          /* カードの角丸 */
  --font-size-title: 28px;     /* ページ見出しの大きさ */
  --font-family: "BIZ UDPGothic", sans-serif;
}
```

- 変数は色・文字・角丸・余白・サイズ(動画プレビューの最大高さ、進捗バーの太さなど)に分けて、コメント付きで並べてあります
- ダークテーマの色は `@media (prefers-color-scheme: dark)` と `[data-theme="dark"]` の 2 か所に同じ値で書いてあります
- 画面右上の「表示」で 自動(OS 設定に追従)/ ライト / ダーク を切り替えられ、選択は端末に保存されます
- `style.css` は変数だけを参照し、class 名ベースです(JS が使う id には依存しません)。
  部品の形そのものを変えたい場合は `style.css` を編集してください
- 状態を表す class: `.hidden`(非表示)、`.is-over`(ドロップ中)、`.is-indeterminate`(進捗不明)
- 解析結果の**動画に焼き込まれる**文字・赤丸・骨格線の色は CSS では変わりません(`docs/js/render.js` の設定です)

## テスト

```bash
npm test      # Node 22 以上。ffmpeg があれば MP4 出力経路のテストも実行
```

- `parity.test.js`: Python 版を正解とした照合。ランダム姿勢 1800 通りの判定、約 3300 フレームの時系列
  (ホールド・EMA・ムーブ安定化・クールダウン・見失い処理)、クライマー固定、色ヒストグラムが一致することを確認
- `mp4-path.test.js`: ffmpeg 製の本物の H.264 データで encoder.js → mp4-muxer → faststart MP4 を検証
- 正解データの再生成: `python3 tests/gen_golden.py`(numpy / opencv / pillow が必要)
- 実ブラウザ E2E(任意・手動): `tests/browser/e2e_analyze.py`, `e2e_ui.py`, `e2e_theme.py`(Playwright + Chromium。骨格は模擬)

## 従来の Python 版との違い

- 解析はすべて JavaScript に移植(Python 不要)。判定ロジックは上記テストで同一性を確認
- 動画を 1 フレームずつシークして処理するため、長さ・解像度に応じて時間がかかる
  (「出力の最大サイズ」を下げると速くなる)。フレームレートは自動検出(手動指定も可)
- 出力は長辺 1920px までに縮小(設定で変更可)。音声は従来どおり付かない
- 骨格推定は MediaPipe の新 API(Tasks)。従来版の `mp.solutions` とは数値が微妙に異なる場合がある

## 制限・注意

- 動画の読み込みはブラウザが再生できる形式に限る(mp4/H.264, webm など)。iPhone の HEVC(.mov)は
  Windows の Chrome では再生できないことがある
- 長時間・高解像度の動画はメモリを多く使う(出力はメモリ上で組み立ててから保存)
