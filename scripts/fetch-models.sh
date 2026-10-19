#!/usr/bin/env bash
# 骨格推定モデル(Apache-2.0)を取得して docs/models に置く。取得物は検証してから採用する。
#   - HTTPS(TLS1.2 以上)のみ
#   - zip 形式(.task)であること("PK" で始まる)と、最小サイズ
#   - 検証に通らないファイルは捨てる(同梱しない → ブラウザ側が Google の配布URLから読み込む)
#   - SHA256SUMS を残す(何を同梱したかを後から確認できる)
set -u
DEST="${1:-docs/models}"
BASE="${MODEL_BASE_URL:-https://storage.googleapis.com/mediapipe-models/pose_landmarker}"
PROTO="${CURL_PROTO:-=https}"            # テスト時だけ file を許可するために上書きできる
MIN_BYTES="${MIN_BYTES:-1000000}"

mkdir -p "$DEST"
: > "$DEST/SHA256SUMS.tmp"
for n in lite full heavy; do
  f="$DEST/pose_landmarker_${n}.task"
  curl --proto "$PROTO" --tlsv1.2 -fsSL --retry 3 --max-time 300 -o "$f" \
    "$BASE/pose_landmarker_${n}/float16/latest/pose_landmarker_${n}.task" || true
  if [ ! -s "$f" ]; then rm -f "$f"; echo "skip: $n (取得できませんでした)"; continue; fi
  size=$(wc -c < "$f")
  magic=$(head -c 2 "$f" 2>/dev/null | tr -d "\0")
  if [ "$magic" != "PK" ] || [ "$size" -lt "$MIN_BYTES" ]; then
    rm -f "$f"; echo "skip: $n (zip 形式ではない、または小さすぎます: ${size} bytes)"; continue
  fi
  ( cd "$DEST" && sha256sum "pose_landmarker_${n}.task" ) >> "$DEST/SHA256SUMS.tmp"
  echo "ok:   $n (${size} bytes)"
done
mv "$DEST/SHA256SUMS.tmp" "$DEST/SHA256SUMS"
cat "$DEST/SHA256SUMS"
exit 0
