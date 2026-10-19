// テスト専用: window.MUKO_POSE_FACTORY を模擬骨格に差し替える(目印のマゼンタ点と、フレーム番号ブロックを使用)
(() => {
  const U = 60;
  const base = () => { const p = {}; for (let i = 0; i < 33; i++) p[i] = [0, 3]; p[0] = [0, 2.3];
    Object.assign(p, {11:[-.5,1.667],12:[.5,1.667],13:[-.7,2.2],14:[.7,2.2],15:[-.8,2.6],16:[.8,2.6],17:[-.8,2.8],18:[.8,2.8],
      19:[-.8,2.8],20:[.8,2.8],21:[-.8,2.8],22:[.8,2.8],23:[-.5,0],24:[.5,0],25:[-.5,-1],26:[.5,-1],27:[-.5,-2],28:[.5,-2],
      29:[-.5,-2.1],30:[.5,-2.1],31:[-.5,-2.2],32:[.5,-2.2]}); return p; };
  const w = (o) => Object.assign(base(), o);
  const NEUTRAL = base(), HEEL_R = w({26:[.9,-.8],28:[1.7,-.4],30:[1.75,-.05]}), DROP_R = w({26:[.3,-1],28:[1,-1.2],30:[1.05,-1.3]}), CROSS_R = w({16:[-.9,2.6],15:[.9,2.6]});
  // カウンターバランス: 右手を高く・左足を横へ(修正前はフラッギングと誤判定された姿勢)
  const COUNTER_R = w({16:[.9,3.0],15:[-.6,1.8],25:[-1.7,-.7],27:[-2.9,-1.4],29:[-2.95,-1.5]});
  // 弱いフラッギング: 足の横への出が 2.0(従来の標準は 2.2 以上が必要)。実際の動画で多い「条件のすぐ手前」の姿勢
  const WEAK_FLAG_L = w({25:[-1.2,-.7],27:[-2.0,-1.6],29:[-2.05,-1.7]});
  const script = (i) => window.MUKO_SCENARIO === "weak" ? (i>=60&&i<130 ? WEAK_FLAG_L : NEUTRAL)
    : window.MUKO_SCENARIO === "counter" ? (i>=60&&i<110 ? COUNTER_R : NEUTRAL)
    : i>=60&&i<100 ? HEEL_R : i>=130&&i<190 ? DROP_R : i>=200&&i<240 ? CROSS_R : NEUTRAL;
  window.MUKO_POSE_FACTORY = async () => {
    if (window.MUKO_FAIL) throw new Error("骨格推定モデルを読み込めませんでした。(テスト用の失敗)");
    return {
      beginVideo() {}, close() {},
      detect(source) {
        const main = document.getElementById("work");
        const c0 = main.getContext("2d").getImageData(0, 0, 120, 20).data;
        let idx = 0;
        for (let k = 0; k < 8; k++) { const o = ((10 * 120) + 4 + k * 14 + 6) * 4; if (c0[o] > 128) idx |= (1 << k); }
        const img = source.getContext("2d").getImageData(0, 0, source.width, source.height).data;
        let sx = 0, sy = 0, n = 0;
        for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
          const o = (y * source.width + x) * 4;
          if (img[o] > 180 && img[o+2] > 180 && img[o+1] < 90) { sx += x; sy += y; n++; }
        }
        if (n < 5) return null;
        const cx = sx / n, cy = sy / n, pose = script(idx), out = [];
        for (let i = 0; i < 33; i++) out.push([(cx - pose[i][0] * U) / source.width, (cy - pose[i][1] * U) / source.height, 0.99]);
        return out;
      },
    };
  };
})();
