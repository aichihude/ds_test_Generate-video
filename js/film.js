/* ==========================================================================
   film.js — 程序化素材：被“生成”的那段视频（体素地形 / 光轨网格）
   整段动画里出现的“画面内容”全部由这里生产，保证各分镜视觉同源。
   ========================================================================== */
(function (global) {
  'use strict';
  const U = global.MGU;
  const { W, clamp, rgba, mix, mulberry32, offscreen, C } = U;

  /* --------------------------- 网格与配色 --------------------------- */
  const GX = 22, GY = 13;                      // 单元格数
  const GW = 1320, GH = 700;                   // 体素地形包围盒
  const X0 = (W - GW) / 2, Y0 = 250;

  const cellW = () => GW / GX;
  const cellH = () => GH / GY;
  const cellX = i => X0 + i * cellW();
  const cellY = j => Y0 + j * cellH();

  // 静态构图：一道从右上斜向左下的“光带”
  const palette = [];
  (function buildPalette() {
    const r = mulberry32(20240617);
    for (let j = 0; j < GY; j++) {
      for (let i = 0; i < GX; i++) {
        const u = i / (GX - 1), v = j / (GY - 1);
        // 一条从右上斜贯到中下的光带，两侧依次变暗
        const band = Math.exp(-Math.pow((u * 1.02 + v * 0.58 - .95) / 0.30, 2));
        const vign = Math.exp(-Math.pow((u - .62) / .68, 2)) * Math.exp(-Math.pow((v - .55) / .82, 2));
        let lum = 0.13 + 0.62 * band + 0.26 * vign * band;
        lum *= 0.88 + r() * 0.24;
        if (j === GY - 1) lum = Math.max(lum, .52);        // 地平线那一排
        const t = clamp(lum * 1.2);
        const col = mix('#11203C', '#5FE3FF', clamp(t * 1.35));
        const warm = clamp((band - .42) * 1.7) * (1 - v) * .9;
        palette.push({
          i, j, lum: clamp(lum),
          color: warm > 0.12 ? mix(col, '#FFD08A', warm * .8) : col,
          warm, t
        });
      }
    }
  })();
  const cellOf = (i, j) => palette[j * GX + i];
  // 显示用亮度：提亮一档（暗部抬到 0.34），否则缩略图与远景会糊成一片黑
  const lumOf = c => Math.pow(0.34 + 0.66 * clamp(c.lum), 0.78);

  /* --------------------------- 静态栅格（解码成品） --------------------------- */
  function drawRaster(x, box, opt = {}) {
    const { sw, sh } = box;
    const cw = sw / GX, ch = sh / GY;
    const g = opt.gain == null ? 1 : opt.gain;
    x.save();
    x.fillStyle = '#04070E';
    x.fillRect(box.sx, box.sy, sw, sh);
    for (let j = 0; j < GY; j++) {
      for (let i = 0; i < GX; i++) {
        const c = cellOf(i, j);
        const px = box.sx + i * cw, py = box.sy + j * ch;
        x.globalAlpha = (0.42 + 0.58 * lumOf(c)) * g;   // 只有最暗的格子变淡
        x.fillStyle = c.color;
        x.fillRect(px, py, cw + .5, ch + .5);
      }
    }
    // 叠加细网线，避免色块过“平”
    x.globalAlpha = .085;
    x.strokeStyle = '#03121E';
    x.lineWidth = 1;
    x.beginPath();
    for (let i = 1; i < GX; i++) { x.moveTo(box.sx + i * cw, box.sy); x.lineTo(box.sx + i * cw, box.sy + sh); }
    for (let j = 1; j < GY; j++) { x.moveTo(box.sx, box.sy + j * ch); x.lineTo(box.sx + sw, box.sy + j * ch); }
    x.stroke();
    x.restore();
  }

  /* --------------------------- 动态网格（潜空间 / 生成中） --------------------------- */
  // prog: 0=全噪声 1=全清晰；opt.id 用于错开各实例的抖动相位
  function drawGrid(x, box, t, prog = 1, opt = {}) {
    const { sw, sh } = box;
    const cw = sw / GX, ch = sh / GY;
    const quality = opt.quality == null ? 1 : opt.quality;
    const speed = opt.speed == null ? 1 : opt.speed;
    const glowA = opt.glow == null ? 1 : opt.glow;
    const id = opt.id || 0;

    if (!opt.skipBg) {
      x.fillStyle = lgV(x, box.sx, box.sy, sh);
      x.fillRect(box.sx, box.sy, sw, sh);
    }

    // 环境辉光（一次径向渐变，成本固定）
    if (!opt.skipGlow) {
      x.save();
      x.globalCompositeOperation = 'screen';
      x.globalAlpha = .55 * glowA * (0.35 + 0.65 * prog);
      x.fillStyle = U.rg(x, box.sx + sw * .68, box.sy + sh * .38, sw * .72, [
        [0, rgba(C.cyan, .40)], [.5, rgba(C.violet, .16)], [1, 'rgba(0,0,0,0)']
      ]);
      x.fillRect(box.sx, box.sy, sw, sh);
      x.restore();
    }

    x.save();
    x.beginPath(); x.rect(box.sx, box.sy, sw, sh); x.clip();
    for (let j = 0; j < GY; j++) {
      for (let i = 0; i < GX; i++) {
        const c = cellOf(i, j);
        const ph = (i * .40 + j * .12);            // 主波从左上推进
        const ramp = clamp(prog * 1.5);
        const p = clamp((ramp - ph * .42) / .58);
        const e = U.ease.io3(p);
        const lum = lumOf(c);

        // 未定形时的抖动位移
        const jitterAmp = (1 - e) * Math.min(cw, ch) * .22;
        const tt = (t * speed + ph * 4.1) * 2.7;
        const jx = Math.sin(tt * 1.13 + id) * jitterAmp;
        const jy = Math.cos(tt * 0.97 + id * 1.7) * jitterAmp;
        const fl = (1 - e) * (0.5 + 0.5 * Math.sin(tt * 3.1 + i * 2.3 + j * 1.7));
        const tx = box.sx + i * cw + jx, ty = box.sy + j * ch + jy;

        // 1) 渐显：底图始终可见，只是对比度被噪声压住
        x.globalAlpha = clamp(.88 + .12 * lum * (0.3 + 0.7 * e), 0, 1);
        x.fillStyle = mixC(c.color, e);
        x.fillRect(tx, ty, cw + .6, ch + .6);

        // 2) 雪花：未定形的随机亮块（随去噪推进快速退场）
        const sp = Math.pow(1 - e, 1.6) * (0.5 + 0.5 * Math.sin(tt * 5.3 + i * 3.1 + j * 2.7));
        if (sp > .34) {
          x.globalAlpha = clamp((sp - .34) * .92, 0, .62);
          x.fillStyle = rgba('#DCF0FF', .9);
          x.fillRect(tx, ty, cw + .6, ch + .6);
        }
        // 3) 闪烁：噪声期的亮度抖动
        if (fl > .55) {
          x.globalAlpha = (fl - .55) * .55;
          x.fillStyle = rgba('#0A1526', .9);
          x.fillRect(tx, ty, cw + .6, ch + .6);
        }

        if (e > .06 && quality > .5) {
          const h = Math.max(1.5, ch * (0.18 + 0.16 * e));
          x.globalAlpha = .8 * e * glowA;
          x.fillStyle = U.lg(x, 0, ty, 0, ty + h, [[0, rgba('#BFEFFF', .55 * e)], [1, rgba(C.cyan, 0)]]);
          x.fillRect(tx, ty, cw + .6, h);

          x.globalAlpha = (.40 + .60 * e) * glowA;         // 顶部亮线
          x.fillStyle = rgba('#EAFBFF', .62);
          x.fillRect(tx, ty, cw + .6, Math.max(1, ch * .09));

          if (c.warm > .12) {                              // 暖色高光带
            x.globalAlpha = c.warm * e * .85 * glowA;
            x.fillStyle = rgba(C.amber, .9);
            x.fillRect(tx, ty + ch * .55, cw + .6, Math.max(1, ch * .16));
          }
        }
      }
    }
    // 两侧竖向高光，制造景深
    if (!opt.skipGlow) {
      x.globalAlpha = .16 * prog;
      x.fillStyle = U.lg(x, box.sx, 0, box.sx + sw, 0, [
        [0, 'rgba(0,0,0,0)'], [.5, rgba(C.cyan, .18)], [1, 'rgba(0,0,0,0)']
      ]);
      x.fillRect(box.sx, box.sy, sw, sh);
    }
    x.restore();
  }

  function lgV(x, sx, sy, sh) {
    return U.lg(x, 0, sy, 0, sy + sh, [[0, '#050A14'], [.45, '#08111F'], [1, '#04070E']]);
  }
  // 未定形时把颜色压向冷灰蓝（保留大部分明度，避免糊成黑块）
  function mixC(col, e) {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(col);
    if (!m) return col;
    const k = .55 + .45 * Math.sqrt(e);
    return `rgb(${Math.round(+m[1] * k + 86 * (1 - k))},${Math.round(+m[2] * k + 110 * (1 - k))},${Math.round(+m[3] * k + 146 * (1 - k))})`;
  }

  /* --------------------------- 噪声贴图（缓存 3 帧） --------------------------- */
  const NOISE = { tiles: [], nw: 480, nh: 270 };
  function noiseTile(idx, seed) {
    if (NOISE.tiles[idx]) return NOISE.tiles[idx];
    const { canvas, ctx } = offscreen(NOISE.nw, NOISE.nh, 1);
    const img = ctx.createImageData(NOISE.nw, NOISE.nh);
    const r = mulberry32(9137 + seed * 7717 + idx * 131);
    for (let k = 0; k < img.data.length; k += 4) {
      const v = (r() * 255) | 0;
      img.data[k] = v * .55; img.data[k + 1] = v * .78; img.data[k + 2] = v; img.data[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    NOISE.tiles[idx] = canvas;
    return canvas;
  }
  // 以 screen 混合叠一层噪声；amount = 需要保留的噪声量
  function grainOver(x, box, t, amount = 1, seed = 0) {
    if (amount <= 0.001) return;
    const f = Math.floor(t * 14) % 3;
    const tile = noiseTile(((f + seed) % 3 + 3) % 3, seed);
    x.save();
    x.beginPath(); x.rect(box.sx, box.sy, box.sw, box.sh); x.clip();
    x.globalCompositeOperation = 'screen';
    x.globalAlpha = .55 * amount;
    const ox = -20 + (Math.floor(t * 47) % 40);
    const oy = -16 + (Math.floor(t * 31) % 32);
    x.drawImage(tile, box.sx + ox, box.sy + oy, box.sw + 40, box.sh + 32);
    x.restore();
  }

  /* --------------------------- 成品帧缓存 --------------------------- */
  const cache = {};
  function cleanFrame(w, h, opt) {
    const key = 'c' + w + 'x' + h + (opt && opt.gain ? 'g' + opt.gain : '');
    if (cache[key]) return cache[key];
    const off = offscreen(w, h, 1);
    drawRaster(off.ctx, { sx: 0, sy: 0, sw: w, sh: h }, opt || {});
    cache[key] = off.canvas;
    return off.canvas;
  }

  global.FILM = {
    GX, GY, GW, GH, X0, Y0, cellW, cellH, cellX, cellY, palette, cellOf, lumOf,
    drawRaster, drawGrid, grainOver, cleanFrame, noiseTile
  };
})(window);
