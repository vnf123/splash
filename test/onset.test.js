import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnsetDetector } from '../src/audio.js';

// 模拟 analyser 输出：持续的中频铺底 + 每 0.5s 一次衰减的低频鼓点
function run({ fps = 60, seconds = 6, kick = 1, pad = 90 } = {}) {
  const det = new OnsetDetector();
  const bins = 1024;
  const spec = new Uint8Array(bins);
  const dt = 1 / fps;
  const hits = [];
  for (let f = 0; f < seconds * fps; f++) {
    const t = f * dt;
    const bt = t % 0.5;
    const env = Math.exp(-bt * 12);
    for (let i = 0; i < bins; i++) {
      const low = i < 8 ? 230 * kick * env : 0;
      const mid = i >= 20 && i < 200 ? pad * (0.9 + 0.1 * Math.sin(t * 3 + i)) : 0;
      spec[i] = Math.min(255, low + mid);
    }
    const r = det.push(spec, 8, 280, dt);
    if (r.onset > 0) hits.push({ t, s: r.onset });
  }
  return hits;
}

test('每个鼓点各触发一次起音', () => {
  const hits = run();
  // 6 秒 / 0.5 秒 = 12 个鼓点
  assert.ok(hits.length >= 11 && hits.length <= 13, `hits=${hits.length}`);
});

test('低帧率（后台节流）下仍能检测到大部分鼓点', () => {
  const hits = run({ fps: 12 });
  assert.ok(hits.length >= 9, `hits=${hits.length}`);
});

test('鼓点越响，起音力度越大', () => {
  const avg = (h) => h.reduce((s, x) => s + x.s, 0) / h.length;
  const soft = run({ kick: 0.3 });
  const loud = run({ kick: 1 });
  assert.ok(soft.length > 0);
  assert.ok(avg(loud) > avg(soft) * 1.5, `${avg(loud)} vs ${avg(soft)}`);
});

test('低频重击与高频清脆打击的音色可区分', () => {
  const det = new OnsetDetector();
  const spec = new Uint8Array(1024);
  const hit = (from, to) => {
    spec.fill(0);
    det.push(spec, 8, 400, 1 / 60, 60);
    for (let i = from; i < to; i++) spec[i] = 220;
    return det.push(spec, 8, 400, 1 / 60, 60);
  };
  const low = hit(1, 8);
  det.since = 1;
  const high = hit(60, 400);
  assert.ok(low.onset > 0 && high.onset > 0);
  assert.ok(low.tone > 0.7, `low=${low.tone}`);
  assert.ok(high.tone < 0.2, `high=${high.tone}`);
});

test('平稳铺底不产生误触发', () => {
  const hits = run({ kick: 0 });
  assert.ok(hits.length <= 1, `hits=${hits.length}`);
});
