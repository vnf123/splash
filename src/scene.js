// 玻璃背后的“界面”：氛围光、封面、曲名与频谱，全部画在一张 2D canvas 上。

const TAU = Math.PI * 2;
let fontCache = null;

export function hueFromString(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

// 从文件名解析“艺术家 - 曲名”，兼容网络下载常见的 + 和 _ 代替空格
export function parseTrackName(filename) {
  const base = String(filename).replace(/\.[^.]+$/, '');
  const name = base.replace(/[+_]+/g, ' ').replace(/\s+/g, ' ').trim() || base;
  const m = name.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1], title: m[2], key: name } : { artist: null, title: name, key: name };
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// track: { title, subtitle, hue } | null；audio: { level, bass, spectrum }
export function drawScene(ctx, w, h, { time, track, audio, progress = 0 }) {
  const hue = track ? track.hue : 212;
  const bass = audio?.bass ?? 0;
  const level = audio?.level ?? 0;
  fontCache ??= getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'system-ui, sans-serif';
  const font = fontCache;

  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, `hsl(${hue} 45% 9%)`);
  bg.addColorStop(1, `hsl(${(hue + 50) % 360} 40% 5%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 缓慢漂移的氛围光斑，随低频呼吸
  const minSide = Math.min(w, h);
  for (let i = 0; i < 4; i++) {
    const t = time * (0.05 + i * 0.017) + i * 1.7;
    const x = w * (0.5 + 0.38 * Math.cos(t * 1.3 + i));
    const y = h * (0.45 + 0.32 * Math.sin(t + i * 2.1));
    const r = minSide * (0.45 + 0.12 * i) * (1 + bass * 0.25);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const hh = (hue + i * 38) % 360;
    g.addColorStop(0, `hsl(${hh} 75% 55% / ${0.2 + bass * 0.22})`);
    g.addColorStop(1, `hsl(${hh} 75% 50% / 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  const portrait = h > w;
  const card = Math.round(Math.min(portrait ? w * 0.62 : h * 0.36, 380));
  const cx = w / 2;
  const top = Math.max(24, (h - card - 210) / 2 - 20);

  // 封面：由曲名生成的抽象图案，随响度轻微缩放
  const pulse = 1 + level * 0.035;
  const cw = card * pulse;
  const x0 = cx - cw / 2;
  const y0 = top + (card - cw) / 2;
  ctx.save();
  ctx.shadowColor = `hsl(${hue} 70% 4% / 0.7)`;
  ctx.shadowBlur = card * 0.18;
  ctx.shadowOffsetY = card * 0.05;
  roundRect(ctx, x0, y0, cw, cw, cw * 0.06);
  const art = ctx.createLinearGradient(x0, y0, x0 + cw, y0 + cw);
  art.addColorStop(0, `hsl(${hue} 70% 58%)`);
  art.addColorStop(0.55, `hsl(${(hue + 40) % 360} 60% 38%)`);
  art.addColorStop(1, `hsl(${(hue + 90) % 360} 55% 18%)`);
  ctx.fillStyle = art;
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, x0, y0, cw, cw, cw * 0.06);
  ctx.clip();
  ctx.strokeStyle = 'rgb(255 255 255 / 0.16)';
  ctx.lineWidth = Math.max(1, cw * 0.006);
  for (let i = 1; i <= 7; i++) {
    ctx.beginPath();
    ctx.arc(x0 + cw * 0.72, y0 + cw * 0.3, cw * 0.09 * i * (1 + level * 0.06 * i), 0, TAU);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgb(255 255 255 / 0.9)';
  ctx.font = `600 ${Math.round(cw * 0.22)}px ${font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(track ? '♫' : '♪', x0 + cw * 0.09, y0 + cw * 0.9);
  ctx.restore();

  // 曲名与信息
  const textTop = top + card + 44;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgb(255 255 255 / 0.94)';
  ctx.font = `650 ${Math.round(Math.max(20, Math.min(34, w * 0.035)))}px ${font}`;
  ctx.fillText(fitText(ctx, track ? track.title : 'Splash', w * 0.84), cx, textTop);
  ctx.fillStyle = 'rgb(255 255 255 / 0.58)';
  ctx.font = `400 ${Math.round(Math.max(13, Math.min(17, w * 0.018)))}px ${font}`;
  ctx.fillText(fitText(ctx, track ? track.subtitle : '隔着一扇淋湿的玻璃听歌', w * 0.84), cx, textTop + 30);

  // 镜像频谱
  const bars = portrait ? 40 : 72;
  const spanW = Math.min(w * 0.82, 760);
  const baseY = textTop + 112;
  const step = spanW / bars;
  const spec = audio?.spectrum;
  ctx.fillStyle = `hsl(${hue} 85% 82% / 0.85)`;
  for (let i = 0; i < bars; i++) {
    let v;
    if (spec) {
      // 对数分布频段，低频细、高频粗
      const a = Math.floor(2 * Math.pow(spec.length / 6 / 2, i / bars));
      const b = Math.max(a + 1, Math.floor(2 * Math.pow(spec.length / 6 / 2, (i + 1) / bars)));
      let s = 0;
      for (let k = a; k < b; k++) s += spec[k];
      v = s / (b - a) / 255;
    } else {
      v = 0.06 + 0.05 * Math.sin(time * 1.6 + i * 0.35);
    }
    const bh = Math.max(2, v * v * 70);
    const bx = cx - spanW / 2 + i * step + step * 0.2;
    const played = i / bars <= progress;
    ctx.globalAlpha = played ? 1 : 0.45;
    ctx.fillRect(bx, baseY - bh, step * 0.6, bh);
    ctx.globalAlpha = (played ? 1 : 0.45) * 0.3;
    ctx.fillRect(bx, baseY + 3, step * 0.6, bh * 0.45);
  }
  ctx.globalAlpha = 1;
}
