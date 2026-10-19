/* ==========================================================================
   util.js — 时间轴 / 缓动 / 绘图原语 / 字体与色彩令牌
   MG 动画：PROMPT → VIDEO
   ========================================================================== */
(function (global) {
  'use strict';

  const W = 1920, H = 1080;                 // 设计画布
  const FPS = 30;

  /* ------------------------------ 数学 ------------------------------ */
  const clamp = (v, a = 0, b = 1) => v < a ? a : (v > b ? b : v);
  const lerp  = (a, b, t) => a + (b - a) * t;
  const inv   = (a, b, v) => b === a ? 0 : (v - a) / (b - a);

  // 把绝对时间 t 映射到 [a,b] 区间内的 0..1（自动 clamp）
  const span = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a));

  /* ------------------------------ 缓动 ------------------------------ */
  const ease = {
    lin:  t => t,
    in2:  t => t * t,
    out2: t => 1 - (1 - t) * (1 - t),
    in3:  t => t * t * t,
    out3: t => 1 - Math.pow(1 - t, 3),
    in4:  t => t * t * t * t,
    out4: t => 1 - Math.pow(1 - t, 4),
    out5: t => 1 - Math.pow(1 - t, 5),
    io2:  t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
    io3:  t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    io4:  t => t < .5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
    io5:  t => t < .5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2,
    // 轻微过冲，用于 HUD / 卡片的“落位感”
    back: (t, s = 1.7) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
    // 弹簧逼近，用于进度条 / 扫描头
    spring: (t, k = 7) => 1 - Math.exp(-k * t) * Math.cos(4.2 * t)
  };

  /* ------------------------------ 随机 ------------------------------ */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function rng(seed) {
    const r = mulberry32(seed);
    return {
      next: r,
      range: (a, b) => a + (b - a) * r(),
      int: (a, b) => Math.floor(a + (b - a + 1) * r()),
      pick: arr => arr[Math.floor(r() * arr.length) % arr.length],
      sign: () => (r() < .5 ? -1 : 1)
    };
  }

  /* ------------------------------ 颜色 ------------------------------ */
  const C = {
    ink:    '#05080F',
    ink2:   '#080D1A',
    cyan:   '#5FE3FF',
    cyanD:  '#1E7FA8',
    violet: '#9B7DFF',
    violetD:'#5A3FA8',
    amber:  '#FFC46B',
    amberD: '#B87A28',
    mint:   '#7BF2C0',
    rose:   '#FF7BA8',
    txt:    '#DCE6FA',
    dim:    '#7C8DAE',
    faint:  '#3B4A66'
  };
  const rgba = (hex, a = 1) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  // 双色线性插值（t: 0..1）
  function mix(hexA, hexB, t) {
    const pa = parseInt(hexA.slice(1), 16), pb = parseInt(hexB.slice(1), 16);
    const r = Math.round(lerp((pa >> 16) & 255, (pb >> 16) & 255, t));
    const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t));
    const b = Math.round(lerp(pa & 255, pb & 255, t));
    return `rgb(${r},${g},${b})`;
  }

  /* ------------------------------ 字体 ------------------------------ */
  const F = {
    ui:   '"Inter","HarmonyOS Sans SC","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif',
    mono: '"JetBrains Mono","Cascadia Mono","Consolas","SFMono-Regular","Courier New",monospace'
  };
  const font = {
    mono:  (px, weight = 500) => `${weight} ${px}px ${F.mono}`,
    ui:    (px, weight = 500) => `${weight} ${px}px ${F.ui}`,
    cn:    (px, weight = 500) => `${weight} ${px}px ${F.ui}`
  };

  /* ------------------------------ 文本工具 ------------------------------ */
  // 手动字距的文本宽度
  function trackedWidth(ctx, text, tracking) {
    let w = 0;
    for (const ch of text) w += ctx.measureText(ch).width + tracking;
    return Math.max(0, w - tracking);
  }
  // 手动字距绘制；opt.align: 'left'|'center'|'right'
  function drawTracked(ctx, text, x, y, tracking, opt = {}) {
    const align = opt.align || 'left';
    const chars = Array.from(text);
    const total = trackedWidth(ctx, text, tracking);
    let cx = x;
    if (align === 'center') cx = x - total / 2;
    else if (align === 'right') cx = x - total;
    ctx.save();
    if (opt.alpha != null) ctx.globalAlpha *= opt.alpha;
    if (opt.fill) ctx.fillStyle = opt.fill;
    ctx.textAlign = 'left';
    ctx.textBaseline = opt.baseline || 'alphabetic';
    for (const ch of chars) {
      if (opt.grad) {
        ctx.save();
        ctx.fillStyle = opt.grad;
        ctx.fillText(ch, cx, y);
        ctx.restore();
      } else {
        ctx.fillText(ch, cx, y);
      }
      if (opt.onChar) opt.onChar(ch, cx, y, ctx.measureText(ch).width);
      cx += ctx.measureText(ch).width + tracking;
    }
    ctx.restore();
    return total;
  }
  // 自动适配宽度的文本（中文长句）
  function fitFont(ctx, text, maxW, startPx, weight, family) {
    let px = startPx;
    for (let i = 0; i < 40; i++) {
      ctx.font = `${weight} ${px}px ${family}`;
      if (ctx.measureText(text).width <= maxW) break;
      px -= Math.max(1, px * 0.03);
    }
    return px;
  }

  // 把带字距的标题压进安全区（避免贴边或溢出）
  function fitTracked(ctx, text, tracking, maxW, startPx, weight, family) {
    let px = startPx;
    for (let i = 0; i < 46; i++) {
      ctx.font = `${weight} ${px}px ${family}`;
      if (trackedWidth(ctx, text, tracking) <= maxW) break;
      px -= Math.max(.5, px * 0.025);
    }
    return px;
  }

  /* ------------------------------ 发光原语 ------------------------------ */
  function glow(ctx, color, blur, alpha = 1) {
    ctx.shadowColor = rgba(color, alpha);
    ctx.shadowBlur = blur;
  }
  function noGlow(ctx) { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; }

  // 圆角矩形路径
  function rr(ctx, x, y, w, h, r) {
    const rad = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  // 带渐变的描边矩形（缺角 / 边角强调）
  function strokeGrad(ctx, x, y, w, h, r, grad, lw = 1.5, alpha = 1) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.strokeStyle = grad;
    ctx.lineWidth = lw;
    rr(ctx, x, y, w, h, r);
    ctx.stroke();
    ctx.restore();
  }

  // 四角括号
  function brackets(ctx, x, y, w, h, len, color, lw = 2, alpha = 1) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'square';
    const pts = [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]];
    for (const [px, py, sx, sy] of pts) {
      ctx.beginPath();
      ctx.moveTo(px + sx * len, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + sy * len);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 十字准星
  function cross(ctx, x, y, r, color, alpha = 1) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
    ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
    ctx.stroke();
    ctx.restore();
  }

  // 线性渐变（水平 / 垂直 / 斜向）
  function lg(ctx, x0, y0, x1, y1, stops) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [p, c] of stops) g.addColorStop(p, c);
    return g;
  }
  function rg(ctx, x, y, r, stops) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(0.01, r));
    for (const [p, c] of stops) g.addColorStop(p, c);
    return g;
  }
  const gradBrand = (ctx, x0, y0, x1, y1, a = 1) =>
    lg(ctx, x0, y0, x1, y1, [[0, rgba(C.cyan, a)], [.52, rgba(C.violet, a)], [1, rgba(C.rose, a)]]);

  /* ------------------------------ 缓动数值工具 ------------------------------ */
  // 0→1 的“入场”包络（用于镜头元素出现）
  function pop(t, at, dur = .5, e = ease.out3) { return e(span(t, at, at + dur)); }
  // 淡入淡出（镜头转场）
  function fadeIO(lt, dur, fin = .45, fout = .45, ein = ease.out2, eout = ease.in2) {
    return Math.min(ein(span(lt, 0, fin)), eout(1 - span(lt, dur - fout, dur)));
  }

  /* ------------------------------ 时间轴 ------------------------------ */
  class Timeline {
    constructor(shots) {
      let t = 0;
      this.shots = shots.map((s, i) => {
        const o = Object.assign({}, s, { index: i, start: t, end: t + s.dur });
        t += s.dur;
        return o;
      });
      this.duration = t;
    }
    at(time) {
      const t = clamp(time, 0, this.duration - 1e-4);
      let cur = this.shots[this.shots.length - 1];
      for (const s of this.shots) if (t >= s.start && t < s.end) { cur = s; break; }
      return { shot: cur, lt: t - cur.start, idx: cur.index, t };
    }
  }

  /* ------------------------------ 画布初始化 ------------------------------ */
  function initCanvas(canvas) {
    const DPR = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return { ctx, DPR };
  }

  function offscreen(w, h, dpr = 1) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { canvas: c, ctx: x, w, h };
  }

  global.MGU = {
    W, H, FPS, clamp, lerp, inv, span, ease, rng, mulberry32,
    C, rgba, mix, F, font, trackedWidth, drawTracked, fitFont, fitTracked,
    glow, noGlow, rr, strokeGrad, brackets, cross, lg, rg, gradBrand,
    pop, fadeIO, Timeline, initCanvas, offscreen
  };
})(window);
