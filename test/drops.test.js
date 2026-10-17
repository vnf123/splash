import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DropSystem, mulberry32 } from '../src/drops.js';

const make = (opts = {}) => new DropSystem({ width: 900, height: 900, random: mulberry32(7), ...opts });
const volume = (sys) => sys.drops.reduce((s, d) => s + d.r ** 3, 0);
const step = (sys, seconds, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) sys.update(dt);
};

test('小水滴附着在玻璃上不会滑落', () => {
  const sys = make();
  const d = sys.addDrop(300, 300, 2);
  step(sys, 3);
  assert.equal(d.y, 300);
  assert.equal(d.sliding, false);
});

test('大水滴克服静摩擦后向下滑落', () => {
  const sys = make();
  const d = sys.addDrop(300, 100, 14);
  step(sys, 0.8);
  assert.ok(d.y > 140, `y=${d.y}`);
  assert.equal(d.sliding, true);
});

test('滑落的水滴在身后留下拖尾小水珠', () => {
  const sys = make();
  sys.addDrop(450, 50, 16);
  step(sys, 1);
  assert.ok(sys.drops.length > 1);
  assert.ok(sys.drops.some((d) => d.r < 6));
});

test('重叠的水滴合并且体积守恒', () => {
  const sys = make();
  sys.addDrop(400, 400, 3);
  sys.addDrop(403, 400, 3);
  const before = volume(sys);
  sys.update(1 / 60);
  assert.equal(sys.drops.length, 1);
  assert.ok(Math.abs(volume(sys) - before) / before < 1e-9);
});

test('撞击越猛，溅出的水滴越多、覆盖越广', () => {
  const measure = (s) => {
    const sys = make({ maxDrops: 5000 });
    sys.splash(s, 450, 450);
    step(sys, 0.4);
    const spread = Math.max(...sys.drops.map((d) => Math.hypot(d.x - 450, d.y - 450)));
    return { count: sys.drops.length, spread, vol: volume(sys) };
  };
  const soft = measure(0.15);
  const hard = measure(1);
  assert.ok(hard.count > soft.count * 2, `${hard.count} vs ${soft.count}`);
  assert.ok(hard.spread > soft.spread * 1.5, `${hard.spread} vs ${soft.spread}`);
  assert.ok(hard.vol > soft.vol * 4);
});

test('水量越大，流得越快', () => {
  const speedOf = (r) => {
    const sys = make();
    const d = sys.addDrop(450, 50, r);
    d.grip = 1;
    step(sys, 0.6);
    return d.vy;
  };
  const mid = speedOf(9);
  const big = speedOf(18);
  assert.ok(mid > 0);
  assert.ok(big > mid * 2, `${big} vs ${mid}`);
});

test('湿润的旧水痕降低起滑门槛，后来的水沿着它流', () => {
  const run = (wetPath) => {
    const sys = make();
    if (wetPath) for (let y = 300; y < 900; y += 6) sys.wetDisk(450, y, 8, 1);
    const d = sys.addDrop(450, 300, 6);
    d.grip = 1.2;
    step(sys, 1);
    return d;
  };
  const dry = run(false);
  const wet = run(true);
  assert.equal(dry.y, 300);
  assert.ok(wet.y > 330, `y=${wet.y}`);
});

test('滑落的水滴偏向旁边更湿的水痕', () => {
  const sys = make();
  for (let y = 100; y < 900; y += 6) sys.wetDisk(480, y, 10, 1);
  const d = sys.addDrop(455, 100, 12);
  step(sys, 0.8);
  assert.ok(d.x > 462, `x=${d.x}`);
});

test('滑落的水滴吞并路径上的水珠', () => {
  const sys = make();
  const d = sys.addDrop(450, 100, 12);
  d.grip = 1;
  sys.addDrop(450, 300, 3);
  sys.addDrop(450, 400, 3);
  const before = volume(sys);
  step(sys, 2.5);
  assert.ok(d.dead || d.y > 400);
  assert.ok(!sys.drops.some((x) => x.r === 3 && x.y === 300));
  assert.ok(volume(sys) <= before + 1e-6);
});

test('浪涌横扫出一排水柱和大片水膜', () => {
  const sys = make({ maxDrops: 5000 });
  sys.surge(1);
  step(sys, 0.6);
  const sliding = sys.drops.filter((d) => d.sliding).length;
  const wetCells = sys.wet.filter((v) => v > 0.3).length;
  assert.ok(sliding >= 8, `sliding=${sliding}`);
  assert.ok(wetCells > sys.wet.length * 0.05, `wet=${wetCells}`);
});

test('零散水珠只是细小的雾滴', () => {
  const sys = make({ maxDrops: 5000 });
  sys.spray(0.6);
  step(sys, 0.3);
  assert.ok(sys.count > 10);
  assert.ok(sys.drops.every((d) => d.r < 5), 'spray 不应产生大水滴');
});

test('刮水器清掉扫过区域的水和水膜，并返回刮走的水量', () => {
  const sys = make();
  sys.addDrop(100, 100, 4);
  sys.addDrop(100, 700, 4);
  sys.wetDisk(300, 100, 30);
  sys.wetDisk(300, 700, 30);
  const vol = sys.wipe(400);
  assert.ok(Math.abs(vol - 64) < 1e-9);
  assert.equal(sys.count, 1);
  assert.equal(sys.wetAt(300, 100), 0);
  assert.ok(sys.wetAt(300, 700) > 0);
  sys.clear();
  assert.equal(sys.count, 0);
  assert.equal(sys.wetAt(300, 700), 0);
});

test('鼓点震动让接近临界的水滴一顿一顿往下窜', () => {
  const run = (beat) => {
    const sys = make();
    const d = sys.addDrop(450, 200, 4.4);
    d.grip = 1;
    for (let i = 0; i < 8; i++) {
      if (beat) sys.shake(1);
      step(sys, 0.25);
    }
    return d.y;
  };
  assert.equal(run(false), 200);
  assert.ok(run(true) > 205, `y=${run(true)}`);
});

test('水花的飞沫记录出发点，用于渲染飞行拖影', () => {
  const sys = make();
  const hit = sys.splash(0.8, 450, 450);
  const flying = sys.pending.filter((p) => p.life > 0);
  assert.ok(flying.length > 10);
  assert.ok(flying.every((p) => p.ox === hit.x && p.oy === hit.y));
});

test('整团水花的主体是水洼，而不是一颗大圆珠', () => {
  const sys = make({ maxDrops: 5000 });
  sys.splash(1, 450, 300);
  assert.equal(sys.puddles.length, 1);
  step(sys, 0.3);
  const maxR = Math.max(...sys.drops.map((d) => d.r));
  assert.ok(maxR < 14, `maxR=${maxR}`);
});

test('水洼从下沿分出细流，自身越来越薄直至消失', () => {
  const sys = make({ maxDrops: 5000 });
  const p = sys.addPuddle(450, 200, 50, 35);
  const v0 = p.vol;
  step(sys, 1.5);
  assert.ok(p.vol < v0, 'volume should drain');
  assert.ok(sys.drops.some((d) => d.y > p.y + p.ry * 0.5), 'rivulets below');
  step(sys, 20);
  assert.equal(sys.puddles.length, 0);
});

test('落进水洼的水滴被吸收', () => {
  const sys = make();
  const p = sys.addPuddle(450, 450, 40, 30);
  const d = sys.addDrop(455, 450, 3);
  const rx = p.rx;
  step(sys, 0.3);
  assert.ok(d.dead || !sys.drops.includes(d));
  assert.ok(p.rx > rx * 0.9);
});

test('刮水器也会刮走水洼', () => {
  const sys = make();
  sys.addPuddle(450, 100, 40, 30);
  sys.addPuddle(450, 800, 40, 30);
  sys.wipe(400);
  assert.equal(sys.puddles.length, 1);
  sys.clear();
  assert.equal(sys.puddles.length, 0);
});

test('空中飞沫延迟落到玻璃上', () => {
  const sys = make({ maxDrops: 5000 });
  sys.splash(0.8, 450, 450);
  const pending = sys.pending.length;
  assert.ok(pending > 0);
  step(sys, 0.5);
  assert.equal(sys.pending.length, 0);
});

test('无效参数被安全忽略', () => {
  const sys = make();
  assert.equal(sys.addDrop(NaN, 0, 3), null);
  assert.equal(sys.addDrop(0, 0, -1), null);
  assert.equal(sys.splash(0), null);
  assert.equal(sys.splash('abc'), null);
  sys.update(-1);
  sys.update(NaN);
  assert.equal(sys.count, 0);
  assert.throws(() => sys.resize(0, 100), RangeError);
});

test('水滴数量不超过上限', () => {
  const sys = make({ maxDrops: 200 });
  for (let i = 0; i < 10; i++) {
    sys.splash(1);
    sys.drizzle(50);
    step(sys, 0.2);
  }
  assert.ok(sys.count <= 200, `count=${sys.count}`);
});

test('滑出底部的水滴被移除', () => {
  const sys = make();
  sys.addDrop(450, 850, 20);
  step(sys, 3);
  assert.ok(sys.drops.every((d) => d.y - d.r <= 900));
});
