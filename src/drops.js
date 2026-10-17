// 玻璃上的水：附着、静摩擦、按水量决定的滑落速度、合并、拖尾水膜，
// 以及三种撞击形态——零散水珠 spray、整团水花 splash、浪涌 surge。
// 坐标单位为 CSS 像素，y 轴向下。

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const strengthOf = (v) => clamp(Number(v) || 0, 0, 1);

// 可复现的伪随机数，测试与调试时使用
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DropSystem {
  constructor({ width = 800, height = 600, random = Math.random, maxDrops = 1400, cell = 6 } = {}) {
    this.random = random;
    this.maxDrops = maxDrops;
    this.cell = cell;
    this.drops = [];
    this.pending = []; // 还在空中、稍后才落到玻璃上的水
    this.nextId = 1;
    this.jolt = 0; // 玻璃被鼓点震动的程度，震动时附着力下降
    this.puddles = [];
    this.resize(width, height);
  }

  resize(width, height) {
    if (!(width > 0 && height > 0)) throw new RangeError('DropSystem 的尺寸必须为正数');
    this.width = width;
    this.height = height;
    // 以 900px 短边为基准缩放水滴尺寸，保证大屏和手机上观感一致
    this.unit = clamp(Math.min(width, height) / 900, 0.45, 2);
    this.drops = this.drops.filter((d) => d.x >= -d.r && d.x <= width + d.r && d.y <= height + d.r);
    // 湿润度网格：水流过的地方留下水膜，后来的水更容易沿着它走
    this.gw = Math.max(1, Math.ceil(width / this.cell));
    this.gh = Math.max(1, Math.ceil(height / this.cell));
    this.wet = new Float32Array(this.gw * this.gh);
  }

  get count() {
    return this.drops.length;
  }

  wetAt(x, y) {
    const gx = Math.floor(x / this.cell);
    const gy = Math.floor(y / this.cell);
    if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return 0;
    return this.wet[gy * this.gw + gx];
  }

  wetDisk(x, y, r, amount = 1) {
    const c = this.cell;
    const rr = Math.max(r, c * 0.6);
    const x0 = Math.max(0, Math.floor((x - rr) / c));
    const x1 = Math.min(this.gw - 1, Math.floor((x + rr) / c));
    const y0 = Math.max(0, Math.floor((y - rr) / c));
    const y1 = Math.min(this.gh - 1, Math.floor((y + rr) / c));
    for (let gy = y0; gy <= y1; gy++) {
      const dy = (gy + 0.5) * c - y;
      for (let gx = x0; gx <= x1; gx++) {
        const dx = (gx + 0.5) * c - x;
        const q = 1 - (dx * dx + dy * dy) / (rr * rr);
        if (q <= 0) continue;
        const v = amount * Math.min(1, q * 2.5);
        const i = gy * this.gw + gx;
        if (v > this.wet[i]) this.wet[i] = v;
      }
    }
  }

  addDrop(x, y, r, { vx = 0, vy = 0, targetR = r, spreading = false } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(r > 0)) return null;
    const drop = {
      id: this.nextId++,
      x,
      y,
      r,
      targetR: Math.max(r, targetR),
      vx,
      vy,
      spreading,
      sliding: false,
      trail: 0,
      phase: this.random() * TAU,
      // 每颗水滴的附着力不同，模拟玻璃表面不均匀的油污和划痕
      grip: 0.6 + this.random() * 0.8,
      age: 0,
      dead: false,
    };
    this.drops.push(drop);
    return drop;
  }

  // 雾气里随机凝出的细小水珠
  drizzle(count, { minR = 0.7, maxR = 3.2 } = {}) {
    const u = this.unit;
    for (let i = 0; i < count; i++) {
      const t = this.random();
      this.addDrop(this.random() * this.width, this.random() * this.height, (minR + (maxR - minR) * t ** 3) * u);
    }
  }

  // 零散水珠：一阵细碎的水雾打在玻璃上
  spray(strength) {
    const s = strengthOf(strength);
    if (s <= 0) return null;
    const rand = this.random;
    const u = this.unit;
    const cx = rand() * this.width;
    const cy = rand() * this.height * 0.85;
    const rad = Math.max(this.width, this.height) * (0.15 + 0.35 * rand());
    const count = Math.round(8 + 45 * s);
    for (let i = 0; i < count; i++) {
      const a = rand() * TAU;
      const dist = rad * Math.sqrt(rand());
      this.pending.push({
        x: cx + Math.cos(a) * dist,
        y: cy + Math.sin(a) * dist,
        r: (0.5 + (0.8 + 2.5 * s) * rand() ** 2.5) * u,
        delay: rand() * 0.15,
      });
    }
    return { kind: 'spray', x: cx, y: cy, strength: s };
  }

  // 一整团水砸到玻璃上：主水团摊开，四周甩出带水珠的“指状”水流，外围落下飞沫
  splash(strength, x, y) {
    const s = strengthOf(strength);
    if (s <= 0) return null;
    const rand = this.random;
    const u = this.unit;
    const cx = x ?? rand() * this.width;
    const cy = y ?? this.height * (0.06 + rand() * 0.7);

    const coreR = (7 + 22 * s) * u * (0.8 + 0.4 * rand());
    // 主水团不是一颗大圆珠，而是一摊不规则的水洼
    this.addPuddle(cx, cy, coreR * (1.6 + 1.2 * s), coreR * (1.2 + 0.9 * s));
    this.wetDisk(cx, cy, coreR * 1.8, 1);

    const fingers = Math.round(4 + 12 * s + rand() * 3);
    const reach = (40 + 260 * s) * u;
    const start = coreR * 0.7;
    for (let f = 0; f < fingers; f++) {
      const a = ((f + rand() * 0.7) / fingers) * TAU;
      const len = coreR + reach * (0.25 + 0.75 * rand() ** 1.5);
      const beads = 1 + Math.round((1 + 3 * s) * rand());
      for (let k = 1; k <= beads; k++) {
        const t = k / beads;
        // 指尖的水珠最大，越靠近中心越细
        const shape = k === beads ? 1.25 : 0.55 + 0.45 * (1 - t);
        const r = (0.9 + 3.2 * s) * u * (0.45 + 0.55 * rand() ** 1.5) * shape;
        // 玻璃上的黏滞减速按 e^(-10t) 衰减，总行程约为 v0 / 10
        const v = (len - start) * t * 10;
        this.addDrop(cx + Math.cos(a) * start, cy + Math.sin(a) * start, r, {
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          spreading: true,
        });
      }
    }

    const mist = Math.round(10 + 50 * s);
    for (let i = 0; i < mist; i++) {
      const a = rand() * TAU;
      const dist = coreR * 1.5 + reach * 1.3 * rand() ** 0.7;
      // 记录出发点：飞沫从撞击中心甩出，飞行途中渲染成拖影
      const delay = 0.04 + rand() * 0.22;
      this.pending.push({
        x: cx + Math.cos(a) * dist,
        y: cy + Math.sin(a) * dist,
        r: (0.45 + 1.8 * rand() ** 2) * u,
        delay,
        life: delay,
        ox: cx,
        oy: cy,
      });
    }
    return { kind: 'splash', x: cx, y: cy, strength: s, coreR };
  }

  // 浪涌：一道起伏的水墙横扫过玻璃，留下大片水膜和一排向下奔流的水柱
  surge(strength) {
    const s = strengthOf(strength);
    if (s <= 0) return null;
    const rand = this.random;
    const u = this.unit;
    const W = this.width;
    const dir = rand() < 0.5 ? 1 : -1;
    const y0 = this.height * (0.03 + 0.3 * rand());
    const amp = (8 + 36 * s) * u;
    const wavelength = W * (0.25 + 0.3 * rand());
    const phase = rand() * TAU;
    const span = W * (0.55 + 0.45 * s);
    const x0 = (W - span) * rand();
    const sweep = 0.12 + 0.12 * rand();
    const band = (20 + 70 * s) * u;

    let x = x0;
    while (x < x0 + span) {
      const t = (x - x0) / span;
      const delay = (dir > 0 ? t : 1 - t) * sweep;
      const y = y0 + Math.sin((x / wavelength) * TAU + phase) * amp;
      const r = (3 + 6.5 * s) * u * (0.45 + 0.55 * rand());
      // 浪头上隔一段留下一摊被拉长的水洼
      if (rand() < 0.16 + 0.12 * s) {
        this.addPuddle(x, y + band * 0.3, r * (3 + 2 * rand()), r * (1.6 + rand()), delay);
      }
      // 浪头：厚水，落下即成水柱
      this.pending.push({ x, y: y + band * 0.5 * rand(), r, delay, vy: 30 * u, wet: band * 0.6 });
      // 浪扫过后残留在水膜里的小水珠
      const beads = Math.round(rand() * 3 * s);
      for (let i = 0; i < beads; i++) {
        this.pending.push({
          x: x + (rand() - 0.5) * r * 3,
          y: y - rand() * band,
          r: r * (0.2 + 0.3 * rand()),
          delay: delay + 0.02,
        });
      }
      // 浪尖甩出的水
      if (rand() < 0.25 + 0.4 * s) {
        const a = -Math.PI / 2 + (rand() - 0.5) * 1.6;
        const v = (60 + 300 * s * rand()) * u;
        this.pending.push({
          x,
          y,
          r: (0.8 + 2.4 * s * rand()) * u,
          delay,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          spreading: true,
        });
      }
      x += r * (1.5 + 0.6 * rand());
    }
    this.spray(s * 0.7);
    return { kind: 'surge', x: x0 + span / 2, y: y0, strength: s, coreR: band };
  }

  // 刮水器扫过 lineY 以上的区域，返回刮走的水量（∑r³）
  wipe(lineY) {
    let vol = 0;
    this.pending.length = 0;
    this.puddles = this.puddles.filter((p) => {
      if (p.y >= lineY) return true;
      vol += p.vol * 4;
      return false;
    });
    this.drops = this.drops.filter((d) => {
      if (d.y >= lineY) return true;
      vol += d.r ** 3;
      return false;
    });
    const rows = clamp(Math.ceil(lineY / this.cell), 0, this.gh);
    if (rows > 0) this.wet.fill(0, 0, rows * this.gw);
    return vol;
  }

  // 水洼：一摊摊开的薄水，形状不规则；在重力下缓慢下坠，从下沿分出细流，越来越薄
  addPuddle(x, y, rx, ry, delay = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(rx > 0 && ry > 0)) return null;
    const rand = this.random;
    const blobs = [];
    const n = 5 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU;
      const d = 0.25 + 0.45 * rand();
      // 下沿略重，模拟水往下汇
      blobs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d * 0.8 + 0.12, r: 0.35 + 0.35 * rand() });
    }
    blobs.push({ x: 0, y: 0, r: 0.7 });
    const p = { id: this.nextId++, x, y, rx, ry, vol: rx * ry, vol0: rx * ry, vy: 0, age: -delay, shed: 0, blobs, seed: rand() };
    this.puddles.push(p);
    if (this.puddles.length > 24) this.puddles.shift();
    return p;
  }

  updatePuddles(dt) {
    const u = this.unit;
    const rand = this.random;
    const keep = [];
    for (const p of this.puddles) {
      p.age += dt;
      if (p.age < 0) {
        keep.push(p);
        continue;
      }
      const thick = Math.sqrt(p.vol) / (14 * u);
      // 水多的水洼整体缓慢下坠
      const target = Math.max(0, thick - 0.9) * 60 * u;
      p.vy += (target - p.vy) * Math.min(1, dt * 2);
      p.y += p.vy * dt;
      this.wetDisk(p.x, p.y, Math.min(p.rx, p.ry) * 1.1, 1);

      // 从下沿分出细流：水越多，流得越勤
      p.shed += dt * (1.2 + 3 * thick);
      while (p.shed >= 1 && p.vol > p.vol0 * 0.08) {
        p.shed -= 1;
        const r = (3 + 4 * rand()) * u * Math.min(1.3, 0.6 + thick * 0.4);
        const d = this.addDrop(p.x + (rand() - 0.5) * p.rx * 1.3, p.y + p.ry * 0.85, r, { vy: 40 * u });
        if (d) d.grip = 0.6;
        // 分出去的水按面积从水洼里扣掉
        p.vol -= r * r * 2.2;
      }
      p.vol *= Math.exp(-dt * 0.08);
      const k = Math.sqrt(Math.max(0, p.vol) / (p.rx * p.ry));
      p.rx *= k;
      p.ry *= k;
      if (p.vol < p.vol0 * 0.08 || p.rx < 4 * u || p.y - p.ry > this.height) {
        // 残余的水缩成几颗小水珠
        for (let i = 0; i < 3; i++) this.addDrop(p.x + (rand() - 0.5) * p.rx, p.y + (rand() - 0.5) * p.ry, (1.5 + 2 * rand()) * u);
        continue;
      }
      keep.push(p);
    }
    this.puddles = keep;

    // 落进水洼的水滴被吸收，水洼随之变大
    if (!this.puddles.length) return;
    for (const d of this.drops) {
      if (d.dead || d.age < 0.15) continue;
      for (const p of this.puddles) {
        if (p.age < 0) continue;
        const dx = (d.x - p.x) / (p.rx * 0.85);
        const dy = (d.y - p.y) / (p.ry * 0.85);
        if (dx * dx + dy * dy < 1) {
          const add = d.r * d.r * 2.2;
          const k = Math.sqrt((p.vol + add) / p.vol);
          p.vol += add;
          p.rx *= k;
          p.ry *= k;
          d.dead = true;
          break;
        }
      }
    }
  }

  // 鼓点让玻璃震一下：接近临界的水滴会被震得一顿一顿地往下窜
  shake(strength) {
    this.jolt = Math.max(this.jolt, strengthOf(strength));
  }

  clear() {
    this.puddles = [];
    this.drops = [];
    this.pending = [];
    this.wet.fill(0);
  }
  update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    const u = this.unit;
    const rand = this.random;

    if (this.pending.length) {
      const airborne = [];
      for (const p of this.pending) {
        p.delay -= dt;
        if (p.delay > 0) {
          airborne.push(p);
          continue;
        }
        this.addDrop(p.x, p.y, p.r, { vx: p.vx || 0, vy: p.vy || 0, spreading: !!p.spreading });
        if (p.wet) this.wetDisk(p.x, p.y, p.wet, 1);
      }
      this.pending = airborne;
    }

    // 水膜慢慢蒸发
    this.jolt *= Math.exp(-dt * 7);
    const dry = Math.exp(-dt * 0.06);
    for (let i = 0; i < this.wet.length; i++) this.wet[i] *= dry;

    const crit = 5.2 * u;
    const vmax = 620 * u;
    const born = [];

    for (const d of this.drops) {
      d.age += dt;
      if (d.r < d.targetR) {
        d.r = Math.min(d.targetR, d.r + (d.targetR - d.r) * Math.min(1, dt * 16) + 0.5 * u * dt);
      }

      if (d.spreading) {
        // 水在玻璃上铺开，受黏滞力快速减速，沿途留下水膜
        const k = Math.exp(-dt * 10);
        d.vx *= k;
        d.vy *= k;
        this.wetDisk(d.x, d.y, d.r * 1.1, 0.75);
        if (Math.hypot(d.vx, d.vy) < 12 * u) {
          d.spreading = false;
          d.vx = 0;
          d.vy = 0;
        }
      } else {
        // 已经湿润的路径上接触角滞后更小，水更容易被拉动
        const ahead = this.wetAt(d.x, d.y + d.r * 1.6);
        const rc = crit * d.grip * (1 - 0.45 * ahead) * (1 - 0.4 * this.jolt);
        if (d.r > rc) {
          // 重力 ∝ r³，钉扎力 ∝ r：水越多、流得越快
          const drive = (d.r / rc) ** 2 - 1;
          const target = Math.min(vmax, 26 * u * drive ** 1.15 + 6 * u);
          d.vy += (target - d.vy) * Math.min(1, dt * 4);
          // 趋向下方更湿的一侧，于是后来的水沿着旧水痕汇流
          const probe = d.r * 2.5 + 6 * u;
          const bias = this.wetAt(d.x + probe, d.y + d.r * 2) - this.wetAt(d.x - probe, d.y + d.r * 2);
          const wander = Math.sin(d.age * 2.3 + d.phase) * 0.06;
          const lateral = (bias * 0.35 + wander * (1 - ahead)) * d.vy;
          d.vx += (lateral - d.vx) * Math.min(1, dt * 6);
          d.sliding = true;
          // 黏滑：在干玻璃上偶尔被“卡住”，再挣脱
          if (rand() < dt * 0.8 * (1 - ahead)) d.grip = 0.7 + rand() * 0.8;
          this.wetDisk(d.x, d.y - d.r * 0.3, d.r * 0.85, 1);

          d.trail += d.vy * dt;
          const gap = d.r * 2.4 + 5 * u;
          // 干玻璃上才会断出拖尾小水珠，水膜上水会连成一线
          if (d.trail > gap && d.r > crit * 0.8) {
            d.trail = 0;
            if (rand() > ahead * 0.8) {
              const tr = d.r * (0.14 + rand() * 0.16);
              born.push([d.x + (rand() - 0.5) * d.r * 0.4, d.y - d.r * 1.4, tr]);
              d.r = Math.cbrt(d.r ** 3 - tr ** 3);
              d.targetR = Math.min(d.targetR, d.r);
            }
          }
        } else {
          const k = Math.exp(-dt * 8);
          d.vy *= k;
          d.vx *= k;
          if (d.vy < u) {
            d.vy = 0;
            d.vx = 0;
          }
          d.sliding = d.vy > 0;
        }
      }

      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.y - d.r > this.height || d.x < -d.r * 2 || d.x > this.width + d.r * 2 || d.y + d.r < -this.height * 0.2) {
        d.dead = true;
      }
    }

    for (const [x, y, r] of born) this.addDrop(x, y, r);
    this.updatePuddles(dt);
    this.resolveCollisions();
    this.drops = this.drops.filter((d) => !d.dead);
    this.cull();
  }

  resolveCollisions() {
    const list = this.drops;
    let maxR = 0;
    for (const d of list) if (!d.dead && d.r > maxR) maxR = d.r;
    const cell = Math.max(16, maxR * 2);
    const keyOf = (cx, cy) => (cy + 2) * 8192 + (cx + 2);
    const grid = new Map();

    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (d.dead) continue;
      const key = keyOf(Math.floor(d.x / cell), Math.floor(d.y / cell));
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.dead || a.spreading) continue;
      const cx = Math.floor(a.x / cell);
      const cy = Math.floor(a.y / cell);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const bucket = grid.get(keyOf(cx + ox, cy + oy));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const b = list[j];
            if (b.dead || b.spreading || a.dead) continue;
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const reach = (a.r + b.r) * 0.8;
            if (dx * dx + dy * dy < reach * reach) {
              if (a.targetR >= b.targetR) this.merge(a, b);
              else this.merge(b, a);
            }
          }
        }
      }
    }
  }

  // 体积守恒合并：大水滴吞并小水滴，位置和速度按质量加权
  merge(big, small) {
    const mb = big.r ** 3;
    const ms = small.r ** 3;
    const m = mb + ms;
    big.x = (big.x * mb + small.x * ms) / m;
    big.y = (big.y * mb + small.y * ms) / m;
    big.vx = (big.vx * mb + small.vx * ms) / m;
    big.vy = (big.vy * mb + small.vy * ms) / m;
    big.r = Math.cbrt(m);
    big.targetR = Math.max(big.r, Math.cbrt(big.targetR ** 3 + small.targetR ** 3));
    small.dead = true;
  }

  // 数量超限时，优先清掉最小的静止水珠
  cull() {
    const excess = this.drops.length - this.maxDrops;
    if (excess <= 0) return;
    const victims = this.drops
      .filter((d) => !d.sliding && !d.spreading)
      .sort((a, b) => a.r - b.r)
      .slice(0, excess);
    const gone = new Set(victims);
    this.drops = this.drops.filter((d) => !gone.has(d));
    if (this.drops.length > this.maxDrops) this.drops = this.drops.slice(-this.maxDrops);
  }
}
