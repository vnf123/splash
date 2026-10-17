import { AudioEngine, isAudioFile } from './audio.js';
import { DropSystem } from './drops.js';
import { createGlass, createDropSprite, createRingSprite, glassFromMask } from './glass.js';
import { drawScene, hueFromString, parseTrackName } from './scene.js';

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const ui = {
  pick: $('#pick'),
  file: $('#file'),
  play: $('#play'),
  seek: $('#seek'),
  cur: $('#cur'),
  dur: $('#dur'),
  vol: $('#vol'),
  power: $('#power'),
  wipe: $('#wipe'),
  swap: $('#swap'),
  status: $('#status'),
};

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
// 隐藏的标签页或 iframe 初始尺寸可能为 0
const viewW = () => Math.max(1, innerWidth || document.documentElement.clientWidth);
const viewH = () => Math.max(1, innerHeight || document.documentElement.clientHeight);

const audio = new AudioEngine();
const drops = new DropSystem({ width: viewW(), height: viewH() });
const debug = new URLSearchParams(location.search).has('debug') ? { strikes: [] } : null;
if (debug) window.__splash = { drops, audio, debug };

const scene = document.createElement('canvas');
const sceneCtx = scene.getContext('2d');
const blur = document.createElement('canvas');
const blurCtx = blur.getContext('2d');
const dropMap = document.createElement('canvas');
const dropCtx = dropMap.getContext('2d');
const wetMap = document.createElement('canvas');
const wetCtx = wetMap.getContext('2d');
const sprite = createDropSprite(128);
const ringSprite = createRingSprite(128);

let glass = null;
try {
  glass = createGlass(view);
} catch (err) {
  console.warn(err);
}
const fallbackCtx = glass ? null : view.getContext('2d');

const BLUR_FILTER = 'filter' in blurCtx;
const DROP_SCALE = 0.6;
let W = 0;
let H = 0;
let sceneScale = 1;
let wetImg = null;


function resize() {
  W = viewW();
  H = viewH();
  // 限制像素总量，避免 4K 屏上每帧上传纹理过重
  const dpr = Math.min(devicePixelRatio || 1, 2);
  sceneScale = Math.min(dpr, Math.sqrt(2_400_000 / (W * H)));
  view.width = scene.width = Math.round(W * sceneScale);
  view.height = scene.height = Math.round(H * sceneScale);
  blur.width = Math.max(1, Math.round(W / 4));
  blur.height = Math.max(1, Math.round(H / 4));
  dropMap.width = Math.round(W * DROP_SCALE);
  dropMap.height = Math.round(H * DROP_SCALE);
  drops.resize(W, H);
  wetMap.width = drops.gw;
  wetMap.height = drops.gh;
  wetImg = wetCtx.createImageData(drops.gw, drops.gh);
}
addEventListener('resize', resize);
resize();

// 水洼贴图：几团软圆叠成不规则轮廓，再按液态玻璃方式算法线——中间平、边缘弯折光线
const puddleSprites = new Map();
const PUDDLE_SPRITE = 96;
function puddleSprite(p) {
  let c = puddleSprites.get(p.id);
  if (c) return c;
  const S = PUDDLE_SPRITE;
  c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  // 归一化坐标 [-1.4, 1.4] 映射到整张贴图，留出模糊余量
  const toPx = (v) => (v / 1.4 + 1) * (S / 2);
  for (const b of p.blobs) {
    ctx.beginPath();
    ctx.arc(toPx(b.x), toPx(b.y), (b.r / 1.4) * (S / 2), 0, Math.PI * 2);
    ctx.fill();
  }
  const src = ctx.getImageData(0, 0, S, S).data;
  const mask = new Float32Array(S * S);
  for (let i = 0; i < mask.length; i++) mask[i] = src[i * 4 + 3] / 255;
  const img = ctx.createImageData(S, S);
  img.data.set(glassFromMask(mask, S, S, S * 0.05));
  ctx.putImageData(img, 0, 0);
  puddleSprites.set(p.id, c);
  return c;
}

function renderPuddles(k) {
  const alive = new Set();
  for (const p of drops.puddles) {
    if (p.age < 0) continue;
    alive.add(p.id);
    // 刚砸上来时迅速摊开
    const grow = 1 - Math.exp(-p.age * 14);
    const w = p.rx * 1.4 * (0.5 + 0.5 * grow) * k;
    const h = p.ry * 1.4 * (0.5 + 0.5 * grow) * k;
    dropCtx.drawImage(puddleSprite(p), p.x * k - w, p.y * k - h, w * 2, h * 2);
  }
  for (const id of puddleSprites.keys()) if (!alive.has(id)) puddleSprites.delete(id);
}


// ---------- 状态 ----------
let track = null;
let power = Number(ui.power.value) / 100;
let fog = 1; // 雾气浓度目标：1 = 全雾
let fogNow = 1;
let welcomeAt = -1;
let drizzleAcc = 0;
let shake = { amp: 0, t: 0, ax: 0, ay: 0 };
let flash = 0;
let last = performance.now();
let idleStrikeIn = 1.5;
// 刮水器：从上到下扫一遍，把玻璃恢复到初始状态
let wiper = null;
const rings = []; // 撞击处扩散的水环

let toastTimer = 0;
function announce(text) {
  ui.status.textContent = '';
  // 先清空再赋值，确保读屏器重复播报相同内容
  requestAnimationFrame(() => {
    ui.status.textContent = text;
    ui.status.classList.add('show');
  });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.status.classList.remove('show'), 4200);
}

function kick(strength, flashAmount = strength) {
  const amp = strength * strength * (reduceMotion.matches ? 0 : 0.007);
  if (amp > shake.amp * Math.exp(-shake.t * 9)) {
    const a = Math.random() * Math.PI * 2;
    shake = { amp, t: 0, ax: Math.cos(a), ay: Math.sin(a) };
  }
  flash = Math.max(flash, flashAmount);
}

// 按频率与力度选择水的形态：低频重击 → 浪涌，中等击打 → 整团水花，清脆高频 → 零散水珠
function strike(onset, a, drive) {
  if (wiper) return;
  const s = Math.min(1, onset * (0.5 + a.level * 1.2) * drive);
  if (s < 0.04) return;
  let kind;
  drops.shake(s);
  if (s > 0.42 && a.tone > 0.55) {
    kind = 'surge';
    ripple(drops.surge(s));
    kick(s, s * 0.8);
  } else if (s > 0.2 && a.tone > 0.3) {
    kind = 'splash';
    ripple(drops.splash(s));
    if (s > 0.6) ripple(drops.splash(s * 0.55));
    kick(s * 0.8, s * 0.5);
  } else {
    kind = 'spray';
    drops.spray(Math.min(1, s * 1.6));
    kick(s * 0.3, s * 0.15);
  }
  debug?.strikes.push({ t: +audio.currentTime.toFixed(2), kind, s: +s.toFixed(2), tone: +a.tone.toFixed(2) });
}

// 撞击处扩散的水环，让每一下击打都看得见
function ripple(hit) {
  if (!hit) return;
  const big = hit.kind === 'surge';
  rings.push({
    x: hit.x,
    y: hit.y,
    r0: hit.coreR * (big ? 0.6 : 1),
    grow: (big ? 900 : 380 + 520 * hit.strength) * drops.unit,
    age: 0,
    life: 0.45 + 0.25 * hit.strength,
    s: hit.strength,
    wide: big ? 3.2 : 1,
  });
}

function startWipe({ refog = false } = {}) {
  rings.length = 0;
  wiper = { y: -20, speed: H / 0.65, vol: 0, refog };
}

// ---------- 渲染 ----------
function renderDropMap() {
  dropCtx.clearRect(0, 0, dropMap.width, dropMap.height);
  const k = DROP_SCALE;
  renderPuddles(k);
  // 鼓点震动时水滴微微颤动
  const quiver = drops.jolt * 0.12;
  const now = performance.now() * 0.06;
  for (const d of drops.drops) {
    const r = Math.max(d.r * k * (1 + quiver * Math.sin(d.phase * 7 + now)), 0.9);
    // 滑动中的水滴被拉成上窄下圆的泪滴形，流得越快拉得越长
    const stretch = d.sliding ? 1 + Math.min(0.9, d.vy / 500) : 1;
    const rw = r * (d.spreading ? 1.2 : 1);
    dropCtx.drawImage(sprite, d.x * k - rw, d.y * k - r * (2 * stretch - 1), rw * 2, r * 2 * stretch);
  }
  for (const ring of rings) {
    const p = ring.age / ring.life;
    const rad = (ring.r0 + ring.grow * (1 - (1 - p) ** 2.4)) * k;
    dropCtx.globalAlpha = (1 - p) ** 1.5 * (0.55 + 0.45 * ring.s);
    dropCtx.drawImage(ringSprite, ring.x * k - rad * ring.wide, ring.y * k - rad, rad * 2 * ring.wide, rad * 2);
  }
  // 还在空中的飞沫：从撞击中心甩出，拉成运动拖影
  for (const p of drops.pending) {
    if (!p.life) continue;
    const f = 1 - Math.max(0, p.delay) / p.life;
    const dx = p.x - p.ox;
    const dy = p.y - p.oy;
    const ang = Math.atan2(dy, dx);
    const len = Math.max(p.r * 2, Math.hypot(dx, dy) * 0.18) * k;
    const r = Math.max(0.9, p.r * k * 0.9);
    dropCtx.globalAlpha = 0.5 + 0.5 * f;
    dropCtx.setTransform(Math.cos(ang), Math.sin(ang), -Math.sin(ang), Math.cos(ang), (p.ox + dx * f) * k, (p.oy + dy * f) * k);
    dropCtx.drawImage(sprite, -len, -r, len + r, r * 2);
  }
  dropCtx.setTransform(1, 0, 0, 1, 0, 0);
  dropCtx.globalAlpha = 1;
  if (wiper) {
    // 刮条前沿推着的一道水
    const t = 3 + Math.min(18, Math.cbrt(wiper.vol) * 0.25);
    dropCtx.drawImage(sprite, -20, (wiper.y - t) * k, dropMap.width + 40, t * 2 * k);
  }
}

function renderWetMap() {
  const src = drops.wet;
  const px = wetImg.data;
  for (let i = 0, j = 0; i < src.length; i++, j += 4) {
    const v = Math.min(255, src[i] * 255) | 0;
    px[j] = px[j + 1] = px[j + 2] = v;
    px[j + 3] = 255;
  }
  wetCtx.putImageData(wetImg, 0, 0);
}

function renderFallback() {
  fallbackCtx.drawImage(scene, 0, 0);
  fallbackCtx.fillStyle = 'rgb(200 220 255 / 0.22)';
  const k = sceneScale;
  for (const d of drops.drops) {
    fallbackCtx.beginPath();
    fallbackCtx.arc(d.x * k, d.y * k, d.r * k, 0, Math.PI * 2);
    fallbackCtx.fill();
  }
  for (const p of drops.puddles) {
    if (p.age < 0) continue;
    fallbackCtx.beginPath();
    fallbackCtx.ellipse(p.x * k, p.y * k, p.rx * k, p.ry * k, 0, 0, Math.PI * 2);
    fallbackCtx.fill();
  }
}

function frame(now) {
  // 后台节流时一帧可能很长，用子步保证物理按真实时间推进
  const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
  last = now;
  const t = now / 1000;
  const a = audio.analyze(dt);
  const motion = reduceMotion.matches ? 0.35 : 1;
  const drive = power * motion;

  if (welcomeAt >= 0 && t >= welcomeAt) {
    welcomeAt = -1;
    ripple(drops.splash(0.75 * Math.max(0.5, drive), W * 0.5, H * 0.22));
    drops.shake(0.7);
    kick(0.7, 0.4);
  }
  fogNow += (fog - fogNow) * Math.min(1, dt * 2.2);

  if (!wiper) {
    if (track) {
      // 持续的高频与响度带来细密水雾
      drizzleAcc += dt * (1.5 + 90 * a.high * a.high + 60 * a.level * a.level) * drive;
      if (a.onset > 0) strike(a.onset, a, drive);
    } else {
      drizzleAcc += dt * 5 * motion;
      idleStrikeIn -= dt;
      if (idleStrikeIn <= 0) {
        const r = Math.random();
        if (r < 0.5) drops.spray(0.4);
        else drops.splash(0.25 + Math.random() * 0.25);
        idleStrikeIn = 2.5 + Math.random() * 3;
      }
    }
    const n = Math.floor(drizzleAcc);
    if (n > 0) {
      drops.drizzle(n);
      drizzleAcc -= n;
    }
  }

  for (let left = dt; left > 1e-4; left -= 1 / 60) drops.update(Math.min(left, 1 / 60));
  for (const ring of rings) ring.age += dt;
  if (rings.length) rings.splice(0, rings.length, ...rings.filter((r) => r.age < r.life));

  if (wiper) {
    wiper.y += wiper.speed * dt;
    wiper.vol += drops.wipe(wiper.y);
    if (wiper.y > H + 40) {
      drops.clear();
      if (wiper.refog) fogNow = fog;
      wiper = null;
    }
  }

  sceneCtx.setTransform(sceneScale, 0, 0, sceneScale, 0, 0);
  const progress = audio.duration ? audio.currentTime / audio.duration : 0;
  drawScene(sceneCtx, W, H, { time: t, track, audio: a, progress });

  shake.t += dt;
  const wobble = Math.sin(shake.t * 70) * shake.amp * Math.exp(-shake.t * 9);
  flash *= Math.exp(-dt * 7);

  if (glass) {
    if (BLUR_FILTER) blurCtx.filter = 'blur(6px)';
    blurCtx.drawImage(scene, 0, 0, blur.width, blur.height);
    renderDropMap();
    renderWetMap();
    glass.render({
      scene,
      blur,
      drops: dropMap,
      clear: wetMap,
      shakeX: wobble * shake.ax,
      shakeY: wobble * shake.ay,
      flash,
      fog: fogNow,
      refract: 0.045,
    });
  } else {
    renderFallback();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- 交互 ----------
const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

function setPlaying(playing) {
  ui.play.dataset.state = playing ? 'playing' : 'paused';
  ui.play.setAttribute('aria-label', playing ? '暂停' : '播放');
}

async function openFile(file) {
  if (!file) return;
  if (!isAudioFile(file)) {
    announce('这个文件看起来不是音频，请选择 mp3、wav、flac、ogg 或 m4a');
    return;
  }
  document.body.dataset.state = track ? 'switching' : 'loading';
  announce(`正在载入 ${file.name}`);
  try {
    await audio.load(file);
  } catch (err) {
    document.body.dataset.state = track ? 'ready' : 'empty';
    announce(err.message);
    return;
  }
  const { artist, title, key } = parseTrackName(file.name);
  track = {
    title,
    subtitle: [artist, file.type.replace('audio/', '').toUpperCase() || '音频', fmt(audio.duration)]
      .filter(Boolean)
      .join(' · '),
    hue: hueFromString(key),
  };
  ui.dur.textContent = fmt(audio.duration);
  ui.seek.value = '0';
  document.body.dataset.state = 'ready';

  fogNow = 1;
  fog = 0.32;
  // 导入或换歌：玻璃回到初始状态——重新起雾、刮净，再缓缓露出新界面
  startWipe();
  welcomeAt = performance.now() / 1000 + 0.9;

  try {
    await audio.play();
    announce(`正在播放 ${track.title}`);
  } catch {
    announce('浏览器阻止了自动播放，按播放键开始');
  }
}

ui.pick.addEventListener('click', () => ui.file.click());
ui.swap.addEventListener('click', () => ui.file.click());
ui.wipe.addEventListener('click', () => startWipe());
ui.file.addEventListener('change', () => {
  openFile(ui.file.files[0]);
  ui.file.value = '';
});

// 轻点玻璃：刮净水痕
let down = null;
view.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now() };
});
view.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  if (moved < 10 && performance.now() - down.t < 500) startWipe();
  down = null;
});

let dragDepth = 0;
addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  openFile(e.dataTransfer?.files[0]);
});

ui.play.addEventListener('click', togglePlay);
function togglePlay() {
  if (!track) return;
  if (audio.paused) audio.play().catch((err) => announce(`无法播放：${err.message}`));
  else audio.pause();
}
audio.el.addEventListener('play', () => setPlaying(true));
audio.el.addEventListener('pause', () => setPlaying(false));
audio.el.addEventListener('ended', () => setPlaying(false));

let seeking = false;
ui.seek.addEventListener('input', () => {
  seeking = true;
  ui.cur.textContent = fmt((ui.seek.value / 1000) * audio.duration);
});
ui.seek.addEventListener('change', () => {
  audio.seek((ui.seek.value / 1000) * audio.duration);
  seeking = false;
});
audio.el.addEventListener('timeupdate', () => {
  ui.cur.textContent = fmt(audio.currentTime);
  if (!seeking && audio.duration) {
    ui.seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  }
  ui.seek.setAttribute('aria-valuetext', `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`);
});

ui.vol.addEventListener('input', () => audio.setVolume(ui.vol.value / 100));
audio.setVolume(ui.vol.value / 100);
ui.power.addEventListener('input', () => {
  power = ui.power.value / 100;
});

addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const tag = e.target.tagName;
  const onControl = tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA';
  if (onControl) return;
  if (e.key === 'w' || e.key === 'W') startWipe();
  if (!track) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    audio.seek(audio.currentTime + (e.key === 'ArrowLeft' ? -5 : 5));
  }
});
