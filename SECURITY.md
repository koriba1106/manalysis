# セキュリティ

## 脆弱性の報告
このリポジトリの **Security → Report a vulnerability**(GitHub の非公開報告)からご連絡ください。
公開の Issue には書かないでください。

## 設計上の前提
- 解析はすべて利用者のブラウザ内で行い、動画をサーバーへ送信しません(サーバー側の処理・保存はありません)
- 外部への通信は、骨格推定モデルの配布元(`storage.googleapis.com`)への取得だけです
  (GitHub Actions でモデルを同梱している場合は自サイト内のみ)

## 実施している対策
| 区分 | 内容 |
|---|---|
| ブラウザ側の制限 | CSP(`default-src 'none'`、スクリプトは自サイトと WASM のみ、インライン・eval 不可、`object-src`/`base-uri`/`form-action` は `none`)、`referrer` なし |
| 埋め込み対策 | 他サイトの iframe 内では動作しない(GitHub Pages はヘッダ `frame-ancestors` を付けられないため JS で対処) |
| XSS | `innerHTML` 等を使わず、表示はすべて `textContent`。静的検査テストで禁止 API の混入を検出 |
| 入力の上限 | 解像度(4K 以下)、長さ(2 時間以内)、出力サイズの事前見積もりで、巨大な入力によるブラウザのクラッシュを防ぐ |
| サプライチェーン | 依存を厳密なバージョンで固定、`package-lock.json`、同梱ファイルの SHA-256 検証(`docs/vendor/SHA256SUMS`)、`npm audit`、Dependabot |
| CI/公開 | 最小権限(`contents: read`、公開ジョブのみ追加)、`persist-credentials: false`、タイムアウト、モデル取得物の形式・サイズ検証 |
| テスト用フック | 自動テストの差し替え口は localhost のときだけ有効 |

## 既知の制約
- GitHub Pages では HTTP 応答ヘッダを設定できません。そのため CSP は `<meta>` で指定しており、`frame-ancestors`・
  HSTS・`X-Content-Type-Options` などは設定できません。厳密に必要な場合は、ヘッダを付けられるホスティング
  (Cloudflare Pages / Netlify / 自前の Web サーバー)で配信してください。
- `uses:` のアクションは主要バージョン(`@v4` など)で指定しています。より厳密にしたい場合はコミット SHA に固定してください
  (Dependabot が更新を提案します)。
- 骨格推定モデルの Google 配布 URL は「最新版」を指すため、ハッシュを固定できません。Actions でモデルを同梱する運用
  (SHA256SUMS を公開)を推奨します。
