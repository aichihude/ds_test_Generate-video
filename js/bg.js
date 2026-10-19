/* ==========================================================================
   bg.js — 全局氛围层：深空底、极光、透视网格、飘浮代码、HUD 框、扫描线
   所有分镜共用同一套底层视觉语言，保证转场“不换皮只换景”。
   ========================================================================== */
(function (global) {
  'use strict';
  const U = global.MGU;
  const { W, H, clamp, lerp, span, ease, rgba, C, font, drawTracked } = U;

  /* ------------------------------ 静态碎片 ------------------------------ */
  const FRAG = (() => {
    const r = U.rng(4242);
    const pool = [
      'latent[7:12, 3:9]', 'σ=0.0241', 'cfg 7.5', 'step 28/28', 'F16 ✓',
      'attn.qk', 'vae.decode()', 'seed 77419', 't=1.000', 'x0̂', 'ε_θ',
      'gop:12', 'lut .cube', 'frames 121', 'h264 yuv420p', 'sr ×2.0',
      'pos_emb', 'kv-cache', 'flow: match', 'norm(μ,σ²)', 'z~N(0,I)',
      'tile 64', 'psnr 41.2', 'Δframe 0.003', 'opt.adamw', 'sched cosine'
    ];
    const out = [];
    for (let i = 0; i < 54; i++) {
      out.push({
        s: pool[i % pool.length],
        x: r.range(-120, W + 120),
        y: r.range(-80, H + 80),
        vx: r.range(-9, 9),
        vy: r.range(-5, 5),
        rot: r.range(-.12, .12),
        size: r.range(11, 17),
        a: r.range(.06, .26),
        ph: r.range(0, 6.28)
      });
    }
    return out;
  })();

  /* ------------------------------ 深空底 ------------------------------ */
  function bed(ctx, t, opt = {}) {
    const inkA = opt.inkA == null ? 1 : opt.inkA;
    ctx.save();
    ctx.globalAlpha = inkA;
    ctx.fillStyle = U.lg(ctx, 0, 0, W * .3, H, [[0, '#070C17'], [.55, '#05080F'], [1, '#03050B']]);
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /* ------------------------------ 极光 ------------------------------ */
  // 三团缓慢漂移的柔光；刻意压得很暗，只作为“深空里的一点余光”
  function aurora(ctx, t, base = .5, warm = 0) {
    const blobs = [
      { x: .20 + .05 * Math.sin(t * .11), y: .30 + .05 * Math.cos(t * .09), r: .52, c: C.cyan, a: .10 },
      { x: .80 + .05 * Math.cos(t * .08), y: .68 + .05 * Math.sin(t * .12), r: .50, c: C.violet, a: .10 },
      { x: .52 + .06 * Math.sin(t * .07 + 2), y: .50 + .05 * Math.cos(t * .06), r: .34, c: '#2A6CFF', a: .06 }
    ];
    ctx.save();
    for (const b of blobs) {
      const r = b.r * Math.max(W, H) * .72;
      const a = b.a * base * .95;
      ctx.globalAlpha = 1;
      ctx.fillStyle = U.rg(ctx, b.x * W, b.y * H, r, [
        [0, rgba(b.c, a)], [.5, rgba(b.c, a * .26)], [1, 'rgba(0,0,0,0)']
      ]);
      ctx.fillRect(0, 0, W, H);
    }
    if (warm > 0) {
      ctx.fillStyle = U.rg(ctx, W * .5, H * .40, W * .52, [[0, rgba(C.amber, .07 * warm)], [1, 'rgba(0,0,0,0)']]);
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  /* ------------------------------ 透视网格地面 ------------------------------ */
  // 一条向远处延伸的地平线网格，营造“空间深度”
  function floorGrid(ctx, t, opt = {}) {
    const hy = opt.hy == null ? H * .70 : opt.hy;
    const alpha = opt.alpha == null ? .16 : opt.alpha;
    const color = opt.color || C.cyan;
    const vpx = W * .5 + (opt.vpx || 0);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = rgba(color, .55);
    ctx.lineWidth = 1;

    // 纵深线
    const N = 22;
    for (let i = -N; i <= N; i++) {
      const xEnd = vpx + i * (W / N) * 2.4;
      ctx.beginPath();
      ctx.moveTo(vpx + i * 12, hy);
      ctx.lineTo(xEnd, H + 40);
      ctx.stroke();
    }
    // 横向线（向观察者推进）
    for (let k = 0; k < 16; k++) {
      const p = ((k + (t * .18) % 1) % 16) / 16;
      const y = hy + Math.pow(p, 2.6) * (H - hy) * 1.12;
      if (y > H + 10) continue;
      ctx.globalAlpha = alpha * (0.18 + 0.82 * p);
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();
    // 地平线辉光（收得很窄，只做一条淡淡的分界）
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = U.lg(ctx, 0, hy - 26, 0, hy + 26, [
      [0, 'rgba(0,0,0,0)'], [.5, rgba(color, .045 * (alpha / .16))], [1, 'rgba(0,0,0,0)']
    ]);
    ctx.fillRect(0, hy - 26, W, 52);
    ctx.restore();
  }

  /* ------------------------------ 飘浮代码 ------------------------------ */
  function frags(ctx, t, opt = {}) {
    const alpha = opt.alpha == null ? 1 : opt.alpha;
    const spread = opt.spread == null ? 1 : opt.spread;
    const bandY = opt.bandY;
    ctx.save();
    ctx.textBaseline = 'middle';
    for (let i = 0; i < FRAG.length; i++) {
      const f = FRAG[i];
      const x = ((f.x + f.vx * t * spread) % (W + 240) + W + 240) % (W + 240) - 120;
      const y = ((f.y + f.vy * t * spread) % (H + 160) + H + 160) % (H + 160) - 80;
      const tw = .45 + .55 * (.5 + .5 * Math.sin(t * 1.7 + f.ph));
      if (opt.exclude && opt.exclude(x, y)) continue;
      if (bandY && y > bandY) continue;      // 避免落进地面网格区
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(f.rot);
      ctx.globalAlpha = f.a * alpha * tw * (opt.dim == null ? 1 : opt.dim);
      ctx.fillStyle = i % 7 === 0 ? rgba(C.amber, .9) : rgba('#8FB6DE', .85);
      ctx.font = font.mono(f.size, 400);
      ctx.fillText(f.s, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  /* ------------------------------ 扫描线 ------------------------------ */
  function scanlines(ctx, t) {
    ctx.save();
    ctx.globalAlpha = .05;
    ctx.fillStyle = '#000';
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    // 缓慢滚动的亮带
    const y = ((t * 42) % (H + 400)) - 200;
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = U.lg(ctx, 0, y - 90, 0, y + 90, [
      [0, 'rgba(0,0,0,0)'], [.5, rgba(C.cyan, .035)], [1, 'rgba(0,0,0,0)']
    ]);
    ctx.fillRect(0, y - 90, W, 180);
    ctx.restore();
  }

  /* ------------------------------ 全片 HUD 边框 ------------------------------ */
  function hudFrame(ctx, t, alpha = 1, label = '') {
    if (alpha <= .001) return;
    const m = 46;
    ctx.save();
    ctx.globalAlpha = alpha;
    // 顶部 / 底部极细装饰线
    ctx.strokeStyle = rgba('#8FB6DE', .16);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(m, m); ctx.lineTo(m + 150, m);
    ctx.moveTo(W - m, m); ctx.lineTo(W - m - 150, m);
    ctx.moveTo(m, H - m); ctx.lineTo(m + 150, H - m);
    ctx.moveTo(W - m, H - m); ctx.lineTo(W - m - 150, H - m);
    ctx.moveTo(m, m); ctx.lineTo(m, m + 34);
    ctx.moveTo(W - m, m); ctx.lineTo(W - m, m + 34);
    ctx.moveTo(m, H - m); ctx.lineTo(m, H - m - 34);
    ctx.moveTo(W - m, H - m); ctx.lineTo(W - m, H - m - 34);
    ctx.stroke();

    // 左上角品牌
    ctx.textBaseline = 'middle';
    ctx.font = font.mono(12, 600);
    ctx.fillStyle = rgba('#9FC0E4', .55);
    drawTracked(ctx, 'DSH·STUDIO', m + 4, m + 22, 3.2);

    // 右上角时间码
    const tc = fmtTC(t);
    ctx.textAlign = 'right';
    ctx.fillStyle = rgba('#9FC0E4', .45);
    drawTracked(ctx, `TC ${tc}`, W - m - 4, m + 22, 2.6, { align: 'right' });

    // 右下角 REC 红点 + 帧计数
    const blink = .35 + .65 * (Math.sin(t * 6) > 0 ? 1 : 0);
    ctx.beginPath();
    ctx.fillStyle = rgba('#FF6B6B', .8 * blink);
    ctx.arc(W - m - 4 - 118, H - m - 16, 3.6, 0, 6.2832);
    ctx.fill();
    ctx.fillStyle = rgba('#9FC0E4', .42);
    drawTracked(ctx, `REC  ${String(Math.floor(t * U.FPS)).padStart(4, '0')}F`, W - m - 4, H - m - 16, 2.4, { align: 'right' });
    ctx.restore();
  }

  function fmtTC(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * U.FPS);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
  }

  /* ------------------------------ 白闪 / 黑闪 ------------------------------ */
  function flash(ctx, amount, color = '#EAF6FF') {
    if (amount <= .001) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = clamp(amount);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  function veil(ctx, amount) {
    if (amount <= .001) return;
    ctx.save();
    ctx.globalAlpha = clamp(amount);
    ctx.fillStyle = '#03050B';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /* ------------------------------ 字幕 / 说明条 ------------------------------ */
  // 逐字打出的等宽说明文字，带光标
  function caption(ctx, text, x, y, t, opt = {}) {
    const size = opt.size || 20;
    const tracking = opt.tracking == null ? 1.6 : opt.tracking;
    const cps = opt.cps || 26;
    const n = clamp(t * cps, 0, text.length);
    const shown = text.slice(0, Math.floor(n));
    const partial = n - Math.floor(n);
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = font.mono(size, 500);
    ctx.fillStyle = opt.color || rgba('#BFD6F2', .92);
    let w = 0;
    if (opt.chip) {
      const full = U.trackedWidth(ctx, text, tracking) + 34;
      ctx.save();
      ctx.globalAlpha *= .9;
      ctx.fillStyle = rgba('#0B1526', .75);
      U.rr(ctx, x - 9, y - size * 1.02, full, size * 2.04, 4);
      ctx.fill();
      ctx.strokeStyle = rgba(C.cyan, .18); ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
    }
    w = drawTracked(ctx, shown, x + 8, y, tracking);
    if (opt.caret !== false && n < text.length) {
      ctx.save();
      ctx.globalAlpha = .8 * (Math.sin(t * 12) > -.3 ? 1 : .1);
      ctx.fillStyle = rgba(C.cyan, .9);
      ctx.fillRect(x + 8 + w + 1, y - size * .52, size * .5, size * 1.04);
      ctx.restore();
    }
    ctx.restore();
    return w;
  }

  /* ------------------------------ 键值读数 ------------------------------ */
  // 一行 HUD： ▸ KEY  VALUE
  function kv(ctx, x, y, key, value, opt = {}) {
    const size = opt.size || 15;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = font.mono(size, 500);
    ctx.fillStyle = rgba(C.cyan, opt.dotA == null ? .85 : opt.dotA);
    ctx.fillRect(x, y - 3, 3, 6);
    ctx.fillStyle = rgba('#7C8DAE', .95);
    const kw = drawTracked(ctx, key, x + 12, y, 1.5);
    ctx.fillStyle = opt.color || rgba('#D8E6FA', .95);
    drawTracked(ctx, String(value), x + 12 + kw + 16, y, 1.5);
    ctx.restore();
  }

  global.BG = { bed, aurora, floorGrid, frags, scanlines, hudFrame, flash, veil, caption, kv, fmtTC, FRAG };
})(window);
