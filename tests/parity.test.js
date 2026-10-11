// Python版(reference/muko_engine.py)を正解とした JS 移植の照合テスト:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MoveType, MoveDetector, computeBodyFrame, Tracker, ClimberLock, makeConfig, MODE,
  histCorr, torsoHist, pyRound, calcAngle, roiEqual, DEFAULT_THRESHOLDS, MoveStabilizer,
} from "../docs/js/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (n) => JSON.parse(fs.readFileSync(path.join(here, "golden", n), "utf8"));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const arrNear = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => near(v, b[i], eps));

test("pyRound は Python の round() と同じ(偶数丸め)", () => {
  const cases = [[0.5, 0], [1.5, 2], [2.5, 2], [10.5, 10], [11.5, 12], [7.49, 7], [7.5, 8], [6.25, 6]];
  for (const [x, y] of cases) assert.equal(pyRound(x), y, `pyRound(${x})`);
  assert.equal(pyRound(30 * 0.35), 10);       // 30fps × heel_confirm 0.35s = 10.5 → 10 (Math.round だと 11)
});

test("検出器: 体幹座標系とムーブ判定が全ケースで一致", () => {
  const cases = load("detector.json");
  const det = new MoveDetector(DEFAULT_THRESHOLDS);
  const seen = new Set();
  let n = 0;
  for (const c of cases) {
    const body = computeBodyFrame(c.pts, c.vis, c.min_torso_px);
    if (c.body === null) { assert.equal(body, null); continue; }
    assert.ok(body, "body が null になった");
    assert.ok(near(body.torsoLen, c.body.torso, 1e-9), "torso");
    assert.ok(near(body.unit, c.body.unit, 1e-9), "unit");
    assert.equal(body.lateralValid, c.body.lateral);
    const d = det.detect(c.pts, c.vis, body);
    assert.equal(d.move.id, c.move, `ムーブ不一致 #${n}`);
    if (c.anchor === null) assert.equal(d.anchor, null);
    else assert.ok(arrNear(d.anchor, c.anchor, 1e-9));
    assert.equal(d.label, c.label); assert.equal(d.labelEn, c.label_en);
    seen.add(d.move.id); n += 1;
  }
  assert.equal(seen.size, 11, `全ムーブを網羅していること: ${[...seen]}`);
});

test("フレーム列: Tracker が実エンジンの _analyze_frame と全フレーム一致(ホールド・EMA・安定化・クールダウン)", () => {
  for (const [si, s] of load("sequences.json").entries()) {
    const over = { ...s.cfg };
    if (over.mode) over.mode = MODE[over.mode];
    const cfg = makeConfig(over);
    const tr = new Tracker(cfg, s.fps);
    const dt = 1 / s.fps;
    let triggers = 0;
    s.lm.forEach((lm, i) => {
      const r = tr.step(lm, s.w, s.h, dt);
      const e = s.expect[i];
      const ctx = `seq${si} frame${i}`;
      assert.equal(r.trigger, e.t, `${ctx} trigger`);
      assert.equal(tr.stabilizer.confirmed.id, e.c, `${ctx} confirmed`);
      assert.equal(r.detection.move.id, e.d, `${ctx} detection`);
      if (e.a === null) assert.equal(r.detection.anchor, null, `${ctx} anchor`);
      else assert.ok(arrNear(r.detection.anchor, e.a, 1e-6), `${ctx} anchor`);
      assert.equal(tr.holdManager.holds.length, e.h.length, `${ctx} holds 数`);
      e.h.forEach((h, k) => {
        const m = tr.holdManager.holds[k];
        assert.equal(m.id, h[0], `${ctx} hold id`);
        assert.ok(near(m.x, h[1], 1e-6) && near(m.y, h[2], 1e-6), `${ctx} hold 座標`);
        assert.equal(m.n, h[3], `${ctx} hold n`);
      });
      assert.equal(tr.holdManager.totalRegistered, e.n, `${ctx} 累計`);
      if (r.trigger) triggers += 1;
    });
    if (s.cfg.mode !== "HOLDS_ONLY") assert.ok(triggers > 0, `seq${si} で停止が発生していること`);
  }
});

test("クライマー固定: ROI・受理判定・更新が一致(外観ヒストグラム有無・初期ROI含む)", () => {
  for (const [si, s] of load("lock.json").entries()) {
    const cfg = makeConfig({ lock_use_appearance: s.cfg.lock_use_appearance, initial_roi: s.cfg.initial_roi });
    const lock = new ClimberLock(cfg, s.fps);
    let rejects = 0;
    s.rows.forEach((r, i) => {
      const ctx = `lock${si} step${i}`;
      if (r.skip) { lock.miss(); return; }
      const roi = lock.roiFor(s.w, s.h);
      const tight = lock.locked ? lock.roiFor(s.w, s.h, true) : null;
      assert.ok(roiEqual(roi, r.roi), `${ctx} roi ${JSON.stringify(roi)} vs ${JSON.stringify(r.roi)}`);
      assert.ok(roiEqual(tight, r.tight), `${ctx} tight`);
      assert.equal(lock.locked, r.locked, `${ctx} locked`);
      if (r.cand === null) lock.miss();
      else {
        const cand = { center: r.cand.center, torso: r.cand.torso, bbox: r.cand.bbox,
          hist: r.cand.hist ? Float32Array.from(r.cand.hist) : null };
        const acc = lock.accept(cand);
        assert.equal(acc, r.accept, `${ctx} accept`);
        if (acc) lock.update(cand); else { lock.miss(); rejects += 1; }
      }
      assert.equal(lock.missed, r.missed, `${ctx} missed`);
    });
    assert.ok(rejects > 10, "別人の却下が発生していること");
  }
});

test("色ヒストグラム: OpenCV 版とほぼ一致 / 相関係数は一致", () => {
  const h = load("hist.json");
  for (const c of h.cases) {
    const rgba = new Uint8ClampedArray(c.w * c.h * 4);
    for (let i = 0; i < c.w * c.h; i++) {
      rgba[i * 4] = c.rgb[i * 3]; rgba[i * 4 + 1] = c.rgb[i * 3 + 1]; rgba[i * 4 + 2] = c.rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
    const mine = torsoHist(rgba, c.w, c.h, c.raw);
    if (c.hist === null) { assert.equal(mine, null); continue; }
    assert.ok(mine);
    const corr = histCorr(mine, Float32Array.from(c.hist));
    assert.ok(corr > 0.995, `ヒストグラム相関 ${corr}`);
  }
  for (const c of h.corr) assert.ok(near(histCorr(Float32Array.from(c.a), Float32Array.from(c.b)), c.r, 1e-4));
});

test("基本: 角度・安定化", () => {
  assert.ok(near(calcAngle([1, 0], [0, 0], [0, 1]), 90));
  assert.equal(calcAngle([0, 0], [0, 0], [0, 1]), 0);
  const st = new MoveStabilizer(3);
  assert.equal(st.update(MoveType.DROP_KNEE_R), false);
  assert.equal(st.update(MoveType.DROP_KNEE_R), false);
  assert.equal(st.update(MoveType.DROP_KNEE_R), true);
  assert.equal(st.confirmed, MoveType.DROP_KNEE_R);
});
