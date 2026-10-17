# Splash · 玻璃水花播放器

[![test](https://github.com/vnf123/splash/actions/workflows/test.yml/badge.svg)](https://github.com/vnf123/splash/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> 隔着一扇淋湿的玻璃听歌：音乐越响，水花越猛。

把本地音频拖进窗口，Web Audio 实时解析响度与频谱——鼓点会砸在玻璃上溅起水花，高频带来细密的雨雾，而所有画面都要透过一层用 WebGL 写的雾面玻璃折射合成。

纯前端、零依赖、零构建。

**[在线体验 →](https://vnf123.github.io/splash/)**

---

## 特性

- **跟着节拍砸水**：用频谱通量做起音检测，低频与全频段分别归一化，鼓点不会被一堆高频 bin 稀释掉。击打力度决定水花大小。
- **按音色分流水的形态**：低频重击 → 浪涌；中等击打 → 整团水花；清脆高频 → 零散水珠。
- **水滴是法线贴图**：把每颗水珠编码为 R/G 表面法线、B 厚度、A 覆盖度，交给片元着色器做折射、色散、投影与焦散。滑动中的水珠会被拉成上窄下圆的泪滴，流得越快拉得越长。
- **液态玻璃水洼**：水洼由几团软圆叠成不规则轮廓，再按液态玻璃的方式算法线——中间平、边缘弯折光线。
- **湿润度地图**：水痕越积越糊，视线被真正"糊住"；轻点玻璃、按 `W` 或点「擦玻璃」，刮水条从上往下推着一道水扫过，玻璃重新清亮。
- **换歌重来一遍**：导入新曲时玻璃重新起雾 → 刮净 → 缓缓露出新界面，主题色由文件名哈希决定，同一首歌总是同一个颜色。
- **音频不出浏览器**：文件只经 `ObjectURL` 本地解码，没有任何上传。
- **降级与无障碍**：WebGL 不可用时回退到 Canvas 2D；尊重 `prefers-reduced-motion`；状态变化通过 `aria-live` 播报。

## 快速开始

需要 Node.js 18+（仅用于本地静态服务和跑测试）。

```bash
git clone https://github.com/vnf123/splash.git
cd splash
npm start          # http://127.0.0.1:5173
```

没有构建步骤——`index.html` 直接引用 ES Module，丢给任意静态服务器（或 GitHub Pages）即可运行。

```bash
npm test           # 32 个单元测试，node:test，无第三方依赖
```

## 操作

| 操作 | 效果 |
| --- | --- |
| 拖入文件 / 点「选择音频文件」 | 导入 MP3 / WAV / FLAC / OGG / M4A |
| 轻点玻璃 / 按 `W` | 刮净水痕 |
| `空格` | 播放 / 暂停 |
| `←` `→` | 后退 / 前进 5 秒 |
| 水花滑块 | 总强度（0–150%） |

调试模式：在 URL 后加 `?debug`，节拍检测结果会挂到 `window.__splash`。

## 结构

```
index.html          页面骨架与无障碍标签
styles.css          控制条 / 引导层 / 拖放提示
src/
  audio.js          AudioEngine（MediaElementSource + AnalyserNode）
                    OnsetDetector（三频段频谱通量 + 自适应门限）
  drops.js          水滴物理：喷雾、水花、浪涌、水洼、湿润度、刮水
  glass.js          WebGL 玻璃合成着色器 + 法线贴图编码
  scene.js          玻璃背后的"界面"：氛围光、封面、曲名、频谱（2D canvas）
  main.js           主循环：把音频分析接到水的物理，再把水交给玻璃折射
test/               node:test 单元测试
server.mjs          零依赖本地静态服务器（只监听 127.0.0.1）
```

渲染链路：2D canvas 画场景 → 降采样模糊 → 水滴/水洼/湿润度分别烘到三张纹理 → 片元着色器按法线偏移采样场景，叠加雾、投影、焦散、震动与闪光。

## 浏览器支持

支持 WebGL 的现代浏览器：Chrome / Edge / Firefox / Safari 最新两个版本。移动端可用，但高像素密度屏幕会自动限制渲染分辨率。

## License

[Apache License 2.0](LICENSE) © 2026 XiaoNan

你可以自由使用、修改、分发本项目（包括商业用途），但需保留版权与许可声明，并在修改过的文件中标注变更。
