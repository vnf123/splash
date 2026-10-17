// WebGL 玻璃合成：把界面场景透过雾面玻璃与水滴折射后画到屏幕。
// 水滴贴图编码：R/G = 表面法线 x/y，B = 厚度，A = 覆盖度。

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBlur;
uniform sampler2D uDrops;
uniform sampler2D uClear;
uniform vec2 uRes;
uniform vec2 uShake;
uniform float uRefract;
uniform float uFlash;
uniform float uFog;

// 面板位于玻璃后方：比玻璃略小一圈，留出景深余量
vec2 panelUv(vec2 uv) {
  return clamp((uv - 0.5) * 0.97 + 0.5, 0.001, 0.999);
}

vec3 panel(vec2 uv) {
  return texture2D(uScene, panelUv(uv)).rgb;
}

// 色散：三原色折射率略有不同，水与玻璃边缘泛出彩虹边
vec3 panelDispersed(vec2 uv, vec2 off) {
  return vec3(
    texture2D(uScene, panelUv(uv + off * 0.92)).r,
    texture2D(uScene, panelUv(uv + off)).g,
    texture2D(uScene, panelUv(uv + off * 1.1)).b);
}

void main() {
  // canvas 纹理以左上角为原点，统一换算到图像坐标
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y) + uShake;
  float aspect = uRes.x / uRes.y;
  vec4 d = texture2D(uDrops, uv);
  vec2 n = (d.rg - 0.5) * 2.0;
  float h = d.b;
  float cover = smoothstep(0.08, 0.42, d.a);

  // 水膜：清晰度来自湿润度，水膜边缘有轻微折射
  vec2 px = vec2(1.0 / 160.0, aspect / 160.0);
  float wet = texture2D(uClear, uv).r;
  float wx = texture2D(uClear, uv + vec2(px.x, 0.0)).r - texture2D(uClear, uv - vec2(px.x, 0.0)).r;
  float wy = texture2D(uClear, uv + vec2(0.0, px.y)).r - texture2D(uClear, uv - vec2(0.0, px.y)).r;
  vec2 filmUv = uv + vec2(wx, wy) * 0.004;
  float clearness = clamp(max(1.0 - uFog, wet), 0.0, 1.0);

  // 水滴投在后方面板上的影子与焦散（光源固定在左上方）
  vec2 shadowOff = vec2(0.006, 0.009 * aspect);
  vec4 sd = texture2D(uDrops, uv - shadowOff);
  float shadow = smoothstep(0.1, 0.6, sd.a) * (1.0 - sd.b * 0.85);
  float caustic = smoothstep(0.55, 1.0, sd.b) * smoothstep(0.3, 0.8, sd.a);

  vec3 frosted = texture2D(uBlur, panelUv(filmUv)).rgb * 0.8 + vec3(0.04, 0.045, 0.055);
  vec3 behind = mix(frosted, panel(filmUv), clearness);
  behind *= 1.0 - 0.22 * shadow;
  behind += caustic * 0.07 * (0.4 + clearness);

  // 水滴是一枚小凸透镜：法线越斜，折射越强
  vec2 offset = -n * vec2(1.0, aspect) * uRefract * (0.4 + h);
  vec3 refr = panelDispersed(uv, offset);
  refr *= 1.0 - 0.5 * pow(1.0 - h, 3.0);
  refr += 0.05 * h;

  vec3 L = normalize(vec3(-0.45, -0.6, 0.66));
  vec3 N = normalize(vec3(n * 1.35, 1.0 - min(0.95, dot(n, n))));
  float spec = pow(max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 90.0);
  // 背光一侧的次高光，让水和玻璃字更“透”
  float spec2 = pow(max(dot(N, normalize(vec3(0.5, 0.65, 0.6))), 0.0), 40.0) * 0.35;
  float rim = smoothstep(0.55, 1.0, length(n));
  // 边缘受光：法线朝左上的一侧亮起一道细线（液态玻璃的典型高光）
  float edgeLit = smoothstep(0.3, 0.75, length(n)) * max(0.0, dot(normalize(n + 1e-4), vec2(-0.6, -0.8)));

  vec3 col = mix(behind, refr, cover);
  col += (spec * 1.15 + spec2 + rim * 0.05 + edgeLit * 0.32) * cover;
  // 水滴边缘一圈暗线，水与玻璃的分界
  col *= 1.0 - rim * cover * 0.32;

  // 玻璃边缘固定的菲涅尔反光
  vec2 e = abs(vUv - 0.5) * 2.0;
  col += pow(max(e.x, e.y), 7.0) * 0.05 * (1.0 - cover * 0.6) * vec3(0.85, 0.92, 1.0);
  col += uFlash * vec3(0.9, 0.95, 1.0) * 0.05;

  float vig = smoothstep(1.25, 0.35, length(vUv - 0.5) * 1.6);
  col *= 0.76 + 0.24 * vig;
  gl_FragColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`着色器编译失败：${log}`);
  }
  return sh;
}

export function createGlass(canvas) {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  let program;
  let uniforms;
  let textures;

  function init() {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`着色器链接失败：${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    uniforms = {};
    for (const name of ['uRes', 'uShake', 'uRefract', 'uFlash', 'uFog']) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

    textures = ['uScene', 'uBlur', 'uDrops', 'uClear'].map((name, unit) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
      return t;
    });
  }

  init();
  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    init();
    lost = false;
  });

  return {
    render({ scene, blur, drops, clear, shakeX = 0, shakeY = 0, flash = 0, fog = 0.3, refract = 0.05 }) {
      if (lost) return;
      const sources = [scene, blur, drops, clear];
      for (let i = 0; i < 4; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, textures[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sources[i]);
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
      gl.uniform2f(uniforms.uShake, shakeX, shakeY);
      gl.uniform1f(uniforms.uRefract, refract);
      gl.uniform1f(uniforms.uFlash, flash);
      gl.uniform1f(uniforms.uFog, fog);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

// 预生成一张水滴法线贴图，绘制时按半径缩放
export function createDropSprite(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5 - half) / half;
      const ny = (y + 0.5 - half) / half;
      const r = Math.hypot(nx, ny);
      const i = (y * size + x) * 4;
      if (r >= 1) continue;
      const z = Math.sqrt(1 - r * r);
      // 下半部分略厚，模拟重力让水滴下沉
      const thick = Math.min(1, z * (0.85 + 0.25 * Math.max(0, ny)));
      const edge = Math.min(1, (1 - r) * half * 0.5);
      img.data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round(thick * 255);
      img.data[i + 3] = Math.round(edge * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// 可分离盒式模糊（单通道），跑三遍近似高斯；不依赖 canvas filter，Safari 也能用
export function blurField(src, w, h, radius, passes = 3) {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  const r = Math.max(1, Math.round(radius));
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc * inv;
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc * inv;
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

// 把文字遮罩变成“液态玻璃”：模糊后的遮罩当作高度场，边缘陡、中间平，
// 于是笔画中心几乎不折射，边缘像透镜一样强烈弯折光线
export function glassFromMask(mask, w, h, radius) {
  const field = blurField(mask, w, h, radius);
  const out = new Uint8ClampedArray(w * h * 4);
  const k = radius * 0.9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = field[i];
      if (v < 0.02) continue;
      const hgt = Math.sqrt(Math.min(1, v * 1.6));
      const sx = Math.sqrt(Math.min(1, field[y * w + Math.min(w - 1, x + 1)] * 1.6)) - Math.sqrt(Math.min(1, field[y * w + Math.max(0, x - 1)] * 1.6));
      const sy = Math.sqrt(Math.min(1, field[Math.min(h - 1, y + 1) * w + x] * 1.6)) - Math.sqrt(Math.min(1, field[Math.max(0, y - 1) * w + x] * 1.6));
      // 法线指向外侧（高度下降的方向）
      let nx = -sx * k;
      let ny = -sy * k;
      // 限制最大倾角：玻璃字边缘只做柔和弯折，不像水珠那样整幅倒像
      const len = Math.hypot(nx, ny);
      const cap = 0.75;
      if (len > cap) {
        nx *= cap / len;
        ny *= cap / len;
      }
      const j = i * 4;
      out[j] = (nx * 0.5 + 0.5) * 255;
      out[j + 1] = (ny * 0.5 + 0.5) * 255;
      // 厚度保持较高，避免着色器把边缘压暗
      out[j + 2] = (0.65 + 0.35 * hgt) * 255;
      out[j + 3] = Math.min(1, v * 2.4) * 255;
    }
  }
  return out;
}

// 撞击处向外扩散的水环：一圈隆起的水膜，内外两侧法线方向相反
export function createRingSprite(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const r = Math.hypot(dx, dy);
      const t = (r - 0.78) / 0.14;
      const bump = Math.exp(-t * t);
      if (bump < 0.02 || r === 0) continue;
      const slope = -2 * t * bump;
      const i = (y * size + x) * 4;
      img.data[i] = ((dx / r) * -slope * 0.5 * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((dy / r) * -slope * 0.5 * 0.5 + 0.5) * 255;
      img.data[i + 2] = bump * 0.6 * 255;
      img.data[i + 3] = Math.min(1, bump * 1.4) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
