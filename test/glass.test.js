import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blurField, glassFromMask } from '../src/glass.js';

// 一块居中的方形“笔画”
function square(w, h, x0, x1) {
  const m = new Float32Array(w * h);
  for (let y = x0; y < x1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
}

test('模糊保持总量不变，并把硬边变软', () => {
  const w = 40;
  const m = square(w, w, 15, 25);
  const b = blurField(m, w, w, 3);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum(b) - sum(m)) / sum(m) < 0.02);
  assert.ok(b[20 * w + 13] > 0 && b[20 * w + 13] < 1);
});

test('玻璃字：边缘法线朝外，中心几乎平整', () => {
  const w = 60;
  const out = glassFromMask(square(w, w, 15, 45), w, w, 3);
  const nx = (x, y) => out[(y * w + x) * 4] / 127.5 - 1;
  const alpha = (x, y) => out[(y * w + x) * 4 + 3];
  // 左边缘法线指向左（负），右边缘指向右（正）
  assert.ok(nx(15, 30) < -0.3, `left=${nx(15, 30)}`);
  assert.ok(nx(44, 30) > 0.3, `right=${nx(44, 30)}`);
  assert.ok(Math.abs(nx(30, 30)) < 0.05);
  assert.equal(alpha(30, 30), 255);
  assert.equal(alpha(2, 2), 0);
});
