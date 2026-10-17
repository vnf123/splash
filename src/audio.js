// 音频播放与实时分析：响度、低频能量、频谱通量起音检测。

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm|weba)$/i;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function isAudioFile(file) {
  if (!file) return false;
  return (typeof file.type === 'string' && file.type.startsWith('audio/')) || AUDIO_EXT.test(file.name || '');
}

// 频谱通量起音检测。低频与全频段分别归一化，避免鼓点被大量高频 bin 稀释。
export class OnsetDetector {
  constructor({ minGap = 0.11 } = {}) {
    this.minGap = minGap;
    this.prev = null;
    this.reset();
  }

  reset() {
    this.avg = 0.02;
    this.since = 1;
    this.prev?.fill(0);
  }

  // spectrum: 0..255 的幅度数组；bassEnd/midEnd/fullEnd 为各频段 bin 下标上限
  push(spectrum, bassEnd, fullEnd, dt, midEnd = Math.round((bassEnd + fullEnd) / 3)) {
    if (!this.prev || this.prev.length !== spectrum.length) this.prev = new Float32Array(spectrum.length);
    const e = [0, 0, 0];
    const fx = [0, 0, 0];
    for (let i = 1; i < fullEnd; i++) {
      const v = spectrum[i] / 255;
      const diff = v - this.prev[i];
      const b = i < bassEnd ? 0 : i < midEnd ? 1 : 2;
      e[b] += v;
      if (diff > 0) fx[b] += diff;
      this.prev[i] = v;
    }
    const n = [Math.max(1, bassEnd - 1), Math.max(1, midEnd - bassEnd), Math.max(1, fullEnd - midEnd)];
    const bands = { bass: e[0] / n[0], mid: e[1] / n[1], high: e[2] / n[2] };
    const bf = [fx[0] / n[0], fx[1] / n[1], fx[2] / n[2]];
    const flux = 0.6 * bf[0] + 0.25 * bf[1] + 0.15 * bf[2];
    // 本次击打的音色：0 = 偏高频的清脆打击，1 = 低频重击
    const total = bf[0] + bf[1] + bf[2] + 1e-6;
    const tone = clamp((bf[0] * 1.4) / total, 0, 1);

    this.since += dt;
    let onset = 0;
    if (flux > this.avg * 1.5 + 0.02 && this.since > this.minGap) {
      // 用通量跃升的绝对量衡量力度，越响的击打越猛
      onset = clamp((flux - this.avg) * 1.8, 0.05, 1);
      this.since = 0;
    }
    // 先判定再更新均值，免得击打本身抬高门限
    this.avg += (flux - this.avg) * Math.min(1, dt * 2.5);
    return { onset, tone, flux, ...bands };
  }
}

export class AudioEngine {
  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.ctx = null;
    this.analyser = null;
    this.url = null;
    this.resetAnalysis();
  }

  // 必须在用户手势内调用，否则浏览器会挂起 AudioContext
  ensureGraph() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('当前浏览器不支持 Web Audio，无法驱动水花效果');
    this.ctx = new AC();
    const source = this.ctx.createMediaElementSource(this.el);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.55;
    source.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.time = new Float32Array(this.analyser.fftSize);
  }

  resetAnalysis() {
    this.level = 0;
    this.bass = 0;
    this.mid = 0;
    this.high = 0;
    (this.detector ??= new OnsetDetector()).reset();
  }

  async load(file, { timeoutMs = 4500 } = {}) {
    if (!isAudioFile(file)) throw new Error('这个文件看起来不是音频，请换一个试试');
    this.ensureGraph();
    this.ctx.resume?.();
    this.el.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.el.src = this.url;
    this.el.load();

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.el.removeEventListener('canplay', onReady);
        this.el.removeEventListener('error', onError);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('浏览器无法解码这个音频文件'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('载入超时，文件可能损坏或格式不受支持'));
      }, timeoutMs);
      this.el.addEventListener('canplay', onReady);
      this.el.addEventListener('error', onError);
    });
    this.resetAnalysis();
  }

  play() {
    this.ctx?.resume?.();
    return this.el.play();
  }

  pause() {
    this.el.pause();
  }

  seek(seconds) {
    const d = this.duration;
    if (!d) return;
    this.el.currentTime = clamp(seconds, 0, d);
  }

  setVolume(v) {
    this.el.volume = clamp(v, 0, 1);
  }

  get paused() {
    return this.el.paused;
  }

  get duration() {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }

  get currentTime() {
    return this.el.currentTime || 0;
  }

  // 每帧调用。onset > 0 表示这一帧检测到一次“击打”，数值为力度
  analyze(dt) {
    if (!this.analyser) return { level: 0, bass: 0, onset: 0, spectrum: null };
    const paused = this.el.paused;

    this.analyser.getFloatTimeDomainData(this.time);
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
    const rms = Math.sqrt(sum / this.time.length);

    this.analyser.getByteFrequencyData(this.freq);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const bassEnd = Math.max(2, Math.ceil(160 / binHz));
    const midEnd = Math.ceil(2000 / binHz);
    const fullEnd = Math.min(this.freq.length, Math.ceil(9000 / binHz));
    const det = this.detector.push(this.freq, bassEnd, fullEnd, dt, midEnd);

    const target = paused ? 0 : clamp(rms * 3.4, 0, 1);
    const rate = target > this.level ? 18 : 5;
    const k = Math.min(1, dt * 10);
    this.level += (target - this.level) * Math.min(1, dt * rate);
    this.bass += ((paused ? 0 : det.bass) - this.bass) * k;
    this.mid += ((paused ? 0 : det.mid) - this.mid) * k;
    this.high += ((paused ? 0 : det.high) - this.high) * k;

    return {
      level: this.level,
      bass: this.bass,
      mid: this.mid,
      high: this.high,
      onset: paused ? 0 : det.onset,
      tone: det.tone,
      spectrum: this.freq,
    };
  }
}
