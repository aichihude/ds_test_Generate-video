/* ==========================================================================
   shots.js — 九个分镜的绘制逻辑
   叙事：提示词 → 分词编码 → 潜空间扩散 → 时序一致性 → 解码 → 超分 → 视频
   贯穿元素：一条“光流”（琥珀 → 青 → 紫），全程不熄灭，在镜头间平滑传递。
   ========================================================================== */
(function (global) {
  'use strict';
  const U = global.MGU, BG = global.BG, FILM = global.FILM;
  const { W, H, clamp, lerp, span, ease, rgba, C, font, drawTracked, glow, noGlow, rr, brackets } = U;

  /* ------------------------------ 时间轴定义 ------------------------------ */
  const TIMELINE = new U.Timeline([
    { id: 'void',    name: '初始化',       dur: 3.9 },
    { id: 'prompt',  name: '提示词注入',   dur: 5.4 },
    { id: 'token',   name: '分词 · 编码',  dur: 5.2 },
    { id: 'latent',  name: '潜空间扩散',   dur: 6.8 },
    { id: 'temporal',name: '时序一致性',   dur: 7.2 },
    { id: 'decode',  name: '解码重建',     dur: 5.4 },
    { id: 'upscale', name: '超分 · 修复',  dur: 5.6 },
    { id: 'player',  name: '播放',         dur: 7.4 },
    { id: 'outro',   name: '签名 · 循环',  dur: 5.8 }
  ]);

  /* ------------------------------ 共享场景变量 ------------------------------ */
  const PROMPT = '一只金色的鸟掠过黎明的海面，水面碎成千万片光';
  const SUB = 'cinematic, volumetric light, 4k, slow motion';
  const S = {                                   // 分镜间传递的“连续性”状态
    gridBox: { sx: 560, sy: 300, sw: 1320, sh: 700 },
    flow: new Float32Array(46),                 // 光流粒子
    flowInit: false
  };

  // 光流粒子：沿 x 轴循环的流点，y 由若干正弦叠加决定 → 有机的“数据流”
  function initFlow() {
    if (S.flowInit) return;
    const r = U.rng(77);
    S.flowParams = [];
    for (let i = 0; i < 46; i++) {
      S.flowParams.push({
        off: r.range(0, 1), y: r.range(-1, 1), amp: r.range(6, 26),
        sp: r.range(.05, .16), sz: r.range(.8, 2.4), ph: r.range(0, 6.28),
        hue: r.range(0, 1)
      });
    }
    S.flowInit = true;
  }

  // 通用：一条贯穿屏幕的光流带（在给定 y 附近流动）
  function flowRibbon(ctx, x0, x1, y, t, opt = {}) {
    initFlow();
    const alpha = opt.alpha == null ? 1 : opt.alpha;
    const thick = opt.thick || 1;
    ctx.save();
    for (const p of S.flowParams) {
      const u = ((p.off + t * p.sp) % 1);
      const x = lerp(x0, x1, u);
      if (x < x0 - 20 || x > x1 + 20) continue;
      const yy = y + p.y * (opt.spread || 16) + Math.sin(t * 1.4 + p.ph) * p.amp * .4;
      const fade = Math.sin(u * Math.PI);                       // 两端渐隐
      const col = p.hue < .34 ? C.amber : (p.hue < .72 ? C.cyan : C.violet);
      ctx.globalAlpha = alpha * fade * .9;
      ctx.globalCompositeOperation = 'lighter';
      glow(ctx, col, 10);
      ctx.fillStyle = rgba(col, .95);
      ctx.beginPath();
      ctx.ellipse(x, yy, p.sz * 7 * thick, p.sz * thick, 0, 0, 6.2832);
      ctx.fill();
      noGlow(ctx);
    }
    ctx.restore();
  }

  /* ------------------------------ 通用面板 ------------------------------ */
  function panel(ctx, box, opt = {}) {
    const a = opt.alpha == null ? 1 : opt.alpha;
    if (a <= .002) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = opt.fill || U.lg(ctx, box.x, box.y, box.x, box.y + box.h,
      [[0, 'rgba(9,16,30,.90)'], [1, 'rgba(5,9,18,.94)']]);
    rr(ctx, box.x, box.y, box.w, box.h, opt.r == null ? 12 : opt.r);
    ctx.fill();
    ctx.strokeStyle = opt.stroke || rgba('#6E90BC', .22);
    ctx.lineWidth = 1.25;
    ctx.stroke();
    if (opt.brackets !== false) {
      brackets(ctx, box.x, box.y, box.w, box.h, opt.bLen || 16, rgba(C.cyan, .45), 1.6);
    }
    ctx.restore();
  }

  /* ==========================================================================
     分镜 1 · 初始化 VOID
     ========================================================================== */
  function shot1(ctx, lt, dur, t) {
    const p = lt / dur;
    BG.frags(ctx, t, { alpha: .5 * ease.out2(span(lt, .2, 2.0)), spread: .25, dim: .8 });
    BG.floorGrid(ctx, t, { hy: H * .74, alpha: .13 * ease.out2(span(lt, .1, 1.6)), vpx: Math.sin(t * .2) * 20 });

    const cx = W / 2, cy = H * .47;

    // 汇聚：从四周飞入的碎屑
    const conv = ease.io3(span(lt, .3, 1.6));
    ctx.save();
    for (let i = 0; i < 40; i++) {
      const r = U.rng(1000 + i);
      const ang = r.range(0, 6.2832), dist = lerp(r.range(420, 1100), 40, conv);
      const x = cx + Math.cos(ang) * dist * 1.6, y = cy + Math.sin(ang) * dist * .8;
      const a = (1 - conv) * .5 + (conv > .95 ? 0 : 0);
      if (a <= .01) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = i % 5 === 0 ? rgba(C.amber, .8) : rgba('#9FC8EA', .7);
      ctx.fillRect(x, y, 2.5, 2.5);
    }
    ctx.restore();

    flowRibbon(ctx, 0, W, cy, t, { alpha: .55 * ease.out2(span(lt, .1, 1.2)), spread: 26, thick: .9 });

    // 主光点：呼吸 → 爆开 → 拉成横线（成为贯穿全片的“管道”）
    const pulse = 1 + .18 * Math.sin(t * 3.1);
    const burst = span(lt, 1.55, 1.9);
    const baseR = lerp(26, 5, ease.in4(span(lt, .1, 1.5))) * pulse;
    const beamW = ease.out4(span(lt, 1.62, 2.25));
    const beamH = lerp(2.4, 1.1, ease.out3(span(lt, 1.7, 2.6)));
    const beamA = ease.out3(span(lt, 1.6, 2.0)) * (1 - .55 * span(lt, 2.9, 3.4));

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // 中心核
    if (lt < 1.95) {
      const a = (1 - burst) * .95 + .05;
      ctx.globalAlpha = a;
      ctx.fillStyle = U.rg(ctx, cx, cy, baseR * 6, [[0, rgba('#FFF6E2', .95)], [.25, rgba(C.amber, .5)], [1, 'rgba(0,0,0,0)']]);
      ctx.beginPath(); ctx.arc(cx, cy, baseR * 6, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#FFFDF6';
      ctx.beginPath(); ctx.arc(cx, cy, baseR, 0, 6.2832); ctx.fill();
    }
    // 冲击波
    if (burst > 0 && burst < 1) {
      const r = lerp(26, 392, ease.out4(burst));
      const k = 1 - burst;
      ctx.globalAlpha = k * k * .62;
      ctx.strokeStyle = rgba(C.amber, .95); ctx.lineWidth = lerp(2.4, .4, burst);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.2832); ctx.stroke();
      ctx.globalAlpha = k * k * .35;
      ctx.strokeStyle = rgba('#FFFFFF', .5); ctx.lineWidth = .8;
      ctx.beginPath(); ctx.arc(cx, cy, r * .84, 0, 6.2832); ctx.stroke();
      ctx.globalAlpha = k * .22;
      ctx.strokeStyle = rgba(C.cyan, .6); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.14, 0, 6.2832); ctx.stroke();
    }
    // 横向光柱（管道本体）
    if (beamA > 0) {
      const w = beamW * W * .5, hh = beamH;
      glow(ctx, C.amber, 46, .85);
      ctx.globalAlpha = beamA;
      ctx.fillStyle = U.lg(ctx, cx - w, 0, cx + w, 0, [
        [0, rgba(C.amber, 0)], [.18, rgba(C.amber, .25)], [.5, rgba('#FFFCEE', .95)],
        [.82, rgba(C.amber, .25)], [1, rgba(C.amber, 0)]
      ]);
      ctx.fillRect(cx - w, cy - hh * 2.6, w * 2, hh * 5.2);
      noGlow(ctx);
      ctx.globalAlpha = beamA * .95;
      ctx.fillStyle = rgba('#FFFFFF', .9);
      ctx.fillRect(cx - w, cy - hh * .5, w * 2, hh);
    }
    ctx.restore();

    // 镜头镜片环（透视椭圆）
    const ringA = ease.out2(span(lt, .5, 1.7)) * (1 - span(lt, 2.6, 3.3));
    if (ringA > .01) {
      ctx.save();
      ctx.globalAlpha = ringA * .30;
      ctx.translate(cx, cy);
      for (let i = 0; i < 4; i++) {
        const rr0 = lerp(180, 700, i / 3) * (1 + .04 * Math.sin(t * .8 + i));
        ctx.strokeStyle = rgba(i % 2 ? C.cyan : C.violet, .30 - i * .05);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(0, 0, rr0 * 1.9, rr0 * .7, 0, 0, 6.2832); ctx.stroke();
      }
      ctx.restore();
    }

    // 底部刻度尺（时间轴隐喻）—— 逐格点亮
    const rulerA = ease.out2(span(lt, .8, 1.5)) * (1 - span(lt, 2.8, 3.3));
    if (rulerA > .01) {
      const ry = H * .845, n = 34, x0 = W * .5 - 620, x1 = W * .5 + 620;
      ctx.save();
      ctx.globalAlpha = rulerA;
      ctx.strokeStyle = rgba('#7EA3CC', .5); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, ry); ctx.lineTo(x1, ry); ctx.stroke();
      const lit = ease.out3(span(lt, .9, 2.7)) * n;
      for (let i = 0; i <= n; i++) {
        const x = lerp(x0, x1, i / n);
        const on = i <= lit;
        const h = on ? (i % 5 === 0 ? 13 : 7) : (i % 5 === 0 ? 9 : 5);
        ctx.globalAlpha = rulerA * (on ? .95 : .3);
        ctx.strokeStyle = on && i % 5 === 0 ? rgba(C.amber, .95) : rgba('#7EA3CC', .7);
        ctx.beginPath(); ctx.moveTo(x, ry); ctx.lineTo(x, ry - h); ctx.stroke();
      }
      ctx.globalAlpha = rulerA * .9;
      ctx.font = font.mono(12, 500);
      ctx.fillStyle = rgba('#7EA3CC', .8);
      drawTracked(ctx, '0s', x0, ry + 22, 1.4);
      drawTracked(ctx, '30s', x1, ry + 22, 1.4, { align: 'right' });
      ctx.restore();
    }

    // HUD
    const hudA = ease.out2(span(lt, .9, 1.7));
    ctx.save();
    ctx.globalAlpha = hudA;
    BG.kv(ctx, 92, H * .22, 'PIPELINE', 'txt2video / v3.2', { size: 15 });
    BG.kv(ctx, 92, H * .22 + 30, 'DEVICE', 'CUDA:0 · 24GB', { size: 15 });
    BG.kv(ctx, 92, H * .22 + 60, 'PRECISION', 'BF16 · flash-attn', { size: 15 });
    BG.kv(ctx, 92, H * .22 + 90, 'SEED', '77419', { size: 15, color: rgba(C.amber, .95) });
    ctx.restore();

    // 状态字幕
    if (lt > 2.5) {
      BG.caption(ctx, 'SYSTEM READY · 等待提示词', W * .5 - 262, H * .615, lt - 2.5,
        { size: 19, cps: 20, color: rgba('#CFE2FA', .95) });
    }
  }

  /* ==========================================================================
     分镜 2 · 提示词注入
     ========================================================================== */
  const BOX = { x: 372, y: 292, w: 1176, h: 268 };

  function shot2(ctx, lt, dur, t) {
    BG.frags(ctx, t, { alpha: .34, spread: .5, dim: .7, bandY: H * .74 });
    BG.floorGrid(ctx, t, { hy: H * .78, alpha: .10, vpx: Math.sin(t * .18) * 26 });

    const appear = ease.out4(span(lt, .05, .55));
    const typeP = span(lt, .75, 3.4);
    const cx = BOX.x + BOX.w / 2;

    // 从上一镜延续的横向光柱：收拢成盒子上沿的一道细光
    const prev = 1 - ease.out3(span(lt, 0, .5));
    if (prev > .01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = prev * .55;
      glow(ctx, C.amber, 30, .8);
      ctx.fillStyle = U.lg(ctx, cx - 620, 0, cx + 620, 0, [
        [0, rgba(C.amber, 0)], [.5, rgba('#FFFCEE', .85)], [1, rgba(C.amber, 0)]]);
      ctx.fillRect(cx - 620, BOX.y, 1240, 1.6);
      noGlow(ctx);
      ctx.restore();
    }

    // 盒子
    ctx.save();
    const sc = lerp(.94, 1, appear);
    ctx.translate(cx, BOX.y + BOX.h / 2);
    ctx.scale(sc, sc);
    ctx.translate(-cx, -(BOX.y + BOX.h / 2));
    ctx.globalAlpha = appear;
    ctx.save();
    glow(ctx, C.amber, 22, .22 * appear);
    ctx.fillStyle = U.lg(ctx, BOX.x, BOX.y, BOX.x, BOX.y + BOX.h,
      [[0, 'rgba(12,15,24,.95)'], [1, 'rgba(6,9,16,.97)']]);
    rr(ctx, BOX.x, BOX.y, BOX.w, BOX.h, 14); ctx.fill();
    noGlow(ctx);
    // 顶部一道极细的暖色内高光
    ctx.save();
    rr(ctx, BOX.x, BOX.y, BOX.w, BOX.h, 14); ctx.clip();
    ctx.fillStyle = U.lg(ctx, BOX.x, 0, BOX.x + BOX.w, 0,
      [[0, rgba(C.amber, 0)], [.5, rgba(C.amber, .55)], [1, rgba(C.amber, 0)]]);
    ctx.fillRect(BOX.x, BOX.y, BOX.w, 1.4);
    ctx.restore();
    // 斜向条纹（提示词专属质感）
    ctx.save();
    rr(ctx, BOX.x, BOX.y, BOX.w, BOX.h, 14); ctx.clip();
    ctx.globalAlpha = .05; ctx.strokeStyle = rgba(C.amber, .9); ctx.lineWidth = 1;
    for (let i = -BOX.h; i < BOX.w; i += 14) {
      ctx.beginPath(); ctx.moveTo(BOX.x + i, BOX.y + BOX.h); ctx.lineTo(BOX.x + i + BOX.h, BOX.y); ctx.stroke();
    }
    ctx.restore();
    // 边框：左→右流动的琥珀描边
    ctx.strokeStyle = U.gradBrand(ctx, BOX.x, BOX.y, BOX.x + BOX.w, BOX.y);
    ctx.lineWidth = 1.23; ctx.strokeStyle = rgba(C.amber, .45);
    rr(ctx, BOX.x, BOX.y, BOX.w, BOX.h, 14); ctx.stroke();
    brackets(ctx, BOX.x - 6, BOX.y - 6, BOX.w + 12, BOX.h + 12, 20, rgba(C.amber, .75), 2, appear);
    ctx.restore();

    // 提示词正文本：逐字点亮
    const px = BOX.x + 56, py = BOX.y + 108;
    ctx.save();
    ctx.font = font.cn(40, 600);
    ctx.textBaseline = 'middle';
    let cursorX = px;
    const chars = Array.from(PROMPT);
    const n = typeP * chars.length;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const wch = ctx.measureText(ch).width;
      const on = i < n;
      const entering = clamp(n - i);
      if (on) {
        ctx.globalAlpha = appear;
        glow(ctx, C.amber, 12 * entering, .45 * entering);
        ctx.fillStyle = U.lg(ctx, cursorX - 10, py - 26, cursorX + wch + 10, py + 26,
          [[0, '#FFF4DE'], [1, rgba(C.amber, .96)]]);
        ctx.fillText(ch, cursorX, py + (1 - ease.out3(entering)) * 8);
        noGlow(ctx);
      } else {
        ctx.globalAlpha = appear * .26;
        ctx.fillStyle = rgba('#9FB6D8', .9);
        ctx.fillText(ch, cursorX, py);
      }
      cursorX += wch + 1.2;
    }
    ctx.restore();

    // 光标
    if (typeP < 1 && lt > .8) {
      const blink = (Math.sin(t * 13) > -.2) ? 1 : .12;
      ctx.save();
      ctx.globalAlpha = blink * appear;
      glow(ctx, C.amber, 16, .8);
      ctx.fillStyle = rgba('#FFE9BE', .95);
      ctx.fillRect(cursorX + 2, py - 24, 3, 48);
      noGlow(ctx);
      ctx.restore();
    }

    // 副提示词（英文风格串）
    const subP = span(lt, 2.6, 3.6);
    if (subP > 0) {
      ctx.save();
      ctx.globalAlpha = subP * .8 * appear;
      ctx.font = font.mono(19, 500);
      ctx.fillStyle = rgba('#9FB6D8', .95);
      drawTracked(ctx, SUB, BOX.x + 58, BOX.y + 178, 1.6);
      ctx.restore();
    }

    // 参数芯片
    const chips = [['LAYER', '1280×720'], ['FRAMES', '121'], ['RATIO', '16:9'], ['CFG', '7.5']];
    const chipP = ease.out3(span(lt, 3.35, 4.2));
    if (chipP > .01) {
      ctx.save();
      let x = BOX.x + 4;
      const y = BOX.y + BOX.h + 34;
      for (let i = 0; i < chips.length; i++) {
        const cp = ease.out3(clamp(chipP * 1.6 - i * .16));
        if (cp <= .001) continue;
        ctx.font = font.mono(14, 600);
        const label = chips[i][0], value = chips[i][1];
        const lw = U.trackedWidth(ctx, label, 1.6), vw = U.trackedWidth(ctx, value, 1.6);
        const w = lw + vw + 42, h = 40;
        ctx.globalAlpha = cp;
        ctx.save();
        ctx.translate(0, (1 - cp) * 12);
        ctx.fillStyle = rgba('#0B1526', .85);
        rr(ctx, x, y, w, h, 8); ctx.fill();
        ctx.strokeStyle = rgba(C.cyan, .25); ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = rgba('#7C8DAE', .95);
        drawTracked(ctx, label, x + 14, y + h / 2 + 1, 1.6, { baseline: 'middle' });
        ctx.fillStyle = rgba('#DCEAFF', .98);
        drawTracked(ctx, value, x + 14 + lw + 14, y + h / 2 + 1, 1.6, { baseline: 'middle' });
        ctx.restore();
        x += w + 12;
      }
      ctx.restore();
    }

    // 光流：提示词 → 屏幕中央的管道
    if (lt > 1.1) {
      const fa = ease.out2(span(lt, 1.1, 1.9));
      ctx.save();
      ctx.globalAlpha = fa;
      const fx = BOX.x + BOX.w - 40, fy = BOX.y + BOX.h / 2;
      const ex = W * .5, ey = H * .74;
      for (let i = 0; i < 26; i++) {
        const k = ((i / 26 + t * .22) % 1);
        const u = ease.io2(k);
        const x = lerp(fx, ex, u * 1.0) + Math.sin(t * 2 + i) * 8;
        const y = lerp(fy, ey, u) + Math.sin(u * 6 + i) * 6;
        const a = Math.sin(k * Math.PI);
        ctx.globalCompositeOperation = 'lighter';
        glow(ctx, C.amber, 14, .8);
        ctx.fillStyle = rgba(i % 4 === 0 ? '#FFF3DA' : C.amber, .9 * a);
        ctx.beginPath(); ctx.arc(x, y, 2.2 + 1.6 * a, 0, 6.2832); ctx.fill();
        noGlow(ctx);
      }
      ctx.restore();
    }

    // 底部状态读数
    if (lt > 3.5) {
      const a = ease.out2(span(lt, 3.5, 4.0));
      ctx.save();
      ctx.globalAlpha = a;
      BG.kv(ctx, W * .5 - 300, H * .885, 'INPUT', `${PROMPT.length} chars · zh-CN`, { size: 15 });
      BG.kv(ctx, W * .5 + 120, H * .885, 'STATE', 'queued → encoding', { size: 15, color: rgba(C.mint, .95) });
      ctx.restore();
    }
  }

  /* ==========================================================================
     分镜 3 · 分词 · 编码
     ========================================================================== */
  const TOKENS = Array.from(PROMPT);

  function shot3(ctx, lt, dur, t) {
    BG.frags(ctx, t, { alpha: .22, spread: .7, dim: .6, bandY: H * .72 });

    const cx = W * .5, cy = H * .46;
    const cols = 13, rows = 2;
    const cw = TOKENS.length / cols <= 2 ? 88 : 78;
    const chh = 78;
    const gw = cols * cw, gh = rows * chh;

    // 阶段：0-1.3 成形 → 1.3-2.1 抖动锁定 → 2.1-2.6 收拢 → 2.6-5.2 编码
    const formP = ease.out4(span(lt, .05, 1.2));
    const lockP = ease.io3(span(lt, 1.35, 2.05));
    const collP = ease.io3(span(lt, 2.15, 2.6));
    const encP = span(lt, 2.6, 4.9);

    const scaleX = lerp(1, .26, collP);
    const scaleY = lerp(1, .11, collP);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(collP * .085);
    ctx.scale(scaleX, scaleY);
    ctx.translate(-cx, -cy);

    // 网格底色
    ctx.globalAlpha = formP * .9 * (1 - collP * .6);
    ctx.strokeStyle = rgba('#6E90BC', .20); ctx.lineWidth = 1 / Math.max(.2, scaleX);
    for (let i = 0; i <= cols; i++) {
      ctx.beginPath(); ctx.moveTo(cx - gw / 2 + i * cw, cy - gh / 2); ctx.lineTo(cx - gw / 2 + i * cw, cy + gh / 2); ctx.stroke();
    }
    for (let j = 0; j <= rows; j++) {
      ctx.beginPath(); ctx.moveTo(cx - gw / 2, cy - gh / 2 + j * chh); ctx.lineTo(cx + gw / 2, cy - gh / 2 + j * chh); ctx.stroke();
    }

    // 每个 token 格
    for (let k = 0; k < TOKENS.length; k++) {
      const i = k % cols, j = Math.floor(k / cols);
      const x = cx - gw / 2 + i * cw, y = cy - gh / 2 + j * chh;
      const appear = ease.out3(clamp((formP * 1.5 - (i + j) * .045)));
      if (appear <= .002) continue;
      const isLocked = k / TOKENS.length < lockP;
      const r = U.rng(500 + k * 31);
      // 未锁定时字符乱跳
      const sc = isLocked ? TOKENS[k] : String.fromCharCode(0x4E00 + Math.floor((Math.sin(t * 30 + k * 7.3) * .5 + .5) * 800));      const flash = isLocked ? clamp(1 - (lockP * TOKENS.length - k) * 1.6) : 0;
      const col = k < 12 ? C.amber : (k < 26 ? C.cyan : C.violet);

      ctx.save();
      ctx.globalAlpha = appear * lerp(1, .18, collP);
      // 已锁定 token 的色块底
      if (isLocked) {
        ctx.globalAlpha = appear * (.10 + .10 * flash) * lerp(1, .18, collP);
        ctx.fillStyle = rgba(col, .95);
        ctx.fillRect(x + 2, y + 2, cw - 4, chh - 4);
        ctx.globalAlpha = appear * lerp(1, .18, collP);
      }
      // 字符
      ctx.font = font.cn(40, 600);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (isLocked) {
        glow(ctx, col, 14 * (0.4 + flash), .5);
        ctx.fillStyle = rgba('#F2FAFF', .96);
      } else {
        ctx.fillStyle = rgba('#9FB6D8', .75);
      }
      ctx.fillText(sc, x + cw / 2, y + chh / 2 + 1);
      noGlow(ctx);
      // 序号
      ctx.globalAlpha = appear * .55;
      ctx.font = font.mono(11, 500);
      ctx.fillStyle = rgba('#7C8DAE', .9);
      ctx.textAlign = 'left';
      ctx.fillText(String(k + 1).padStart(2, '0'), x + 7, y + 15);
      ctx.restore();

      // 从 token 飞出的数据流
      if (collP > .01 && collP < 1) {
        ctx.save();
        for (let m = 0; m < 3; m++) {
          const kk = ((k / TOKENS.length + t * .55 + m / 3) % 1);
          const u = kk;
          const sx = lerp(x + cw / 2, cx, u), sy = lerp(y + chh / 2, cy, u);
          ctx.globalAlpha = Math.sin(u * Math.PI) * (1 - collP * .3) * .95;
          ctx.globalCompositeOperation = 'lighter';
          glow(ctx, col, 12, .8);
          ctx.fillStyle = rgba(col, .9);
          ctx.beginPath(); ctx.arc(sx, sy, 2.4, 0, 6.2832); ctx.fill();
          noGlow(ctx);
        }
        ctx.restore();
      }
    }
    ctx.restore();

    // 编码：向量柱状条（768 维）
    const barP = ease.out3(span(lt, 2.75, 3.5));
    if (barP > .01) {
      const bx = W * .5 - 300, bw = 600, by = cy + 96, bh = 128;
      ctx.save();
      ctx.globalAlpha = barP;
      // 容器
      ctx.fillStyle = rgba('#070E1C', .85);
      rr(ctx, bx - 14, by - 22, bw + 28, bh + 74, 10); ctx.fill();
      ctx.strokeStyle = rgba('#6E90BC', .22); ctx.lineWidth = 1; ctx.stroke();

      const n = 64;
      const reveal = ease.out3(span(lt, 2.9, 4.6));
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const on = u <= reveal;
        const r = U.rng(900 + i * 13);
        const hgt = (0.22 + 0.78 * Math.abs(Math.sin(i * 1.7 + r.range(0, 2)))) * bh * (on ? 1 : .12);
        const x = bx + u * bw;
        const col = u < .4 ? C.amber : (u < .75 ? C.cyan : C.violet);
        ctx.globalAlpha = barP * (on ? .95 : .22);
        const g = U.lg(ctx, 0, by + bh - hgt, 0, by + bh, [[0, rgba(col, .95)], [1, rgba(col, .12)]]);
        ctx.fillStyle = g;
        ctx.fillRect(x, by + bh - hgt, bw / n - 2.4, hgt);
        if (on && Math.abs(u - reveal) < .04) {
          glow(ctx, col, 18, .9);
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(x, by + bh - hgt, bw / n - 2.4, 3);
          noGlow(ctx);
        }
      }
      // 维度标尺
      ctx.globalAlpha = barP * .9;
      ctx.strokeStyle = rgba('#6E90BC', .45); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, by + bh + 10); ctx.lineTo(bx + bw, by + bh + 10); ctx.stroke();
      ctx.font = font.mono(12, 500);
      ctx.fillStyle = rgba('#7C8DAE', .95);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('0', bx, by + bh + 26);
      ctx.textAlign = 'right';
      ctx.fillText('768', bx + bw, by + bh + 26);
      ctx.textAlign = 'center';
      ctx.fillStyle = rgba(C.cyan, .95);
      drawTracked(ctx, 'EMBEDDING  d=768', bx + bw / 2, by - 34, 2.4, { align: 'center' });
      ctx.restore();
    }

    // HUD 计数器
    const hudA = ease.out2(span(lt, .6, 1.2));
    ctx.save();
    ctx.globalAlpha = hudA;
    const tokN = Math.floor(lockP * TOKENS.length);
    BG.kv(ctx, 92, H * .22, 'TOKENS', String(tokN).padStart(2, '0') + ' / 26', { size: 15, color: rgba(C.amber, .95) });
    BG.kv(ctx, 92, H * .22 + 30, 'VOCAB', 'cl100k · multilingual', { size: 15 });
    BG.kv(ctx, 92, H * .22 + 60, 'ENCODER', 'frozen · ViT-bigG', { size: 15 });
    if (lockP >= 1) BG.kv(ctx, 92, H * .22 + 90, 'STATUS', 'encoded ✓', { size: 15, color: rgba(C.mint, .95) });
    ctx.restore();

    if (lt > 1.7 && lt < 3.0) {
      BG.caption(ctx, '切分为 token 并映射到语义向量空间', W * .5 - 300, H * .80, lt - 1.7, { size: 17, cps: 34 });
    }
    if (lt > 4.2) {
      BG.caption(ctx, '向量已就位 · 进入潜空间', W * .5 - 220, H * .80, lt - 4.2,
        { size: 17, cps: 26, color: rgba(C.mint, .95) });
    }
  }

  /* ==========================================================================
     分镜 4 · 潜空间扩散
     ========================================================================== */
  function shot4(ctx, lt, dur, t) {
    BG.frags(ctx, t, { alpha: .2, spread: .8, dim: .55, bandY: H * .74 });
    BG.floorGrid(ctx, t, { hy: H * .80, alpha: .09, vpx: Math.sin(t * .16) * 30 });

    const bx = 560, by = 300, bw = 1320, bh = 700;
    S.gridBox = { sx: bx, sy: by, sw: bw, sh: bh };

    const inP = ease.out4(span(lt, .05, .75));
    const tilt = ease.io3(span(lt, .2, .9)) * (1 - span(lt, 5.6, 6.3));
    const prog = ease.io2(span(lt, 2.0, 5.6));
    const outP = ease.in3(span(lt, 6.1, 6.8));

    // 3D 微倾，制造“浮在空间中”的感觉
    ctx.save();
    ctx.translate(bx + bw / 2, by + bh / 2);
    ctx.rotate(lerp(0, -.035, tilt));
    ctx.scale(lerp(.96, 1, inP), lerp(.96, 1, inP));
    ctx.transform(1, 0, lerp(-.08, 0, ease.out3(span(lt, .2, 1.2))), 1, 0, 0);
    ctx.translate(-(bx + bw / 2), -(by + bh / 2));
    ctx.globalAlpha = inP * (1 - outP);

    // 面板
    panel(ctx, { x: bx - 26, y: by - 74, w: bw + 52, h: bh + 130 }, { brackets: true, bLen: 22 });

    // 深度感：先铺一层被压扁的“远平面”
    ctx.save();
    ctx.globalAlpha = inP * .28 * (1 - prog * .5);
    FILM.drawGrid(ctx, { sx: bx + 60, sy: by - 42, sw: bw - 120, sh: 90 }, t * .6, prog * .35, { skipBg: true, glow: .4, id: 3 });
    ctx.restore();

    // 主体噪声场 → 逐渐去噪
    FILM.drawGrid(ctx, { sx: bx, sy: by, sw: bw, sh: bh }, t, prog, { id: 1, glow: 1, speed: lerp(1.9, .5, prog) });
    FILM.grainOver(ctx, { sx: bx, sy: by, sw: bw, sh: bh }, t, (1 - prog) * .95, 0);

    // 噪声强度衰减（诊断风）
    ctx.save();
    ctx.globalAlpha = inP * (1 - outP);
    ctx.font = font.mono(13, 500);
    ctx.fillStyle = rgba(C.rose, .8);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const noiseVal = (lerp(1.0, 0.021, prog)).toFixed(3);
    drawTracked(ctx, `σ_noise ${noiseVal}`, bx + 14, by + bh - 16, 1.6);
    ctx.restore();
    ctx.restore();

    // 左侧：来自上一镜的 embedding 柱，化成流向网格的通量
    const fluxP = ease.out3(span(lt, .7, 1.6));
    ctx.save();
    ctx.globalAlpha = fluxP * (1 - outP);
    const ex = W * .5 - 420, ey = H * .46;
    for (let i = 0; i < 22; i++) {
      const u = (i / 21 - .5), len = 10 + 26 * Math.abs(Math.sin(i * 1.7 + 1));
      const col = i % 3 === 0 ? C.amber : C.cyan;
      ctx.globalAlpha = fluxP * (1 - outP) * (.35 + .65 * (0.5 + .5 * Math.sin(t * 3 + i * .5)));
      ctx.fillStyle = rgba(col, .85);
      ctx.fillRect(ex + 26, ey + u * 72, len, 1.6);
    }
    ctx.globalAlpha = fluxP * (1 - outP);
    ctx.font = font.mono(12, 500);
    ctx.fillStyle = rgba('#7C8DAE', .9);
    drawTracked(ctx, 'z  (768)', ex, ey - 62, 1.6, { align: 'center' });
    ctx.strokeStyle = rgba(C.cyan, .40); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(ex + 22, ey - 44); ctx.lineTo(ex + 22, ey + 44); ctx.stroke();
    ctx.restore();

    // 通量弧线
    if (fluxP > .02 && outP < .9) {
      ctx.save();
      ctx.globalAlpha = fluxP * (1 - outP) * .75;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const u = (i / 5 + t * .18) % 1;
        const p0 = { x: ex + 16, y: ey + (i - 2) * 16 };
        const p3 = { x: bx + 40, y: by + bh * .5 + Math.sin(i) * 120 };
        const p1 = { x: lerp(p0.x, p3.x, .35), y: p0.y - 90 };
        const p2 = { x: lerp(p0.x, p3.x, .7), y: p3.y + 60 };
        ctx.strokeStyle = U.lg(ctx, p0.x, 0, p3.x, 0, [[0, rgba(C.amber, .0)], [1, rgba(C.cyan, .55)]]);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        const steps = 26;
        for (let s = 1; s <= steps; s++) {
          const tt = s / steps;
          const x = Math.pow(1 - tt, 3) * p0.x + 3 * Math.pow(1 - tt, 2) * tt * p1.x + 3 * (1 - tt) * tt * tt * p2.x + tt ** 3 * p3.x;
          const y = Math.pow(1 - tt, 3) * p0.y + 3 * Math.pow(1 - tt, 2) * tt * p1.y + 3 * (1 - tt) * tt * tt * p2.y + tt ** 3 * p3.y;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        // 沿曲线跑动的光点
        const tt2 = u;
        const px2 = Math.pow(1 - tt2, 3) * p0.x + 3 * Math.pow(1 - tt2, 2) * tt2 * p1.x + 3 * (1 - tt2) * tt2 * tt2 * p2.x + tt2 ** 3 * p3.x;
        const py2 = Math.pow(1 - tt2, 3) * p0.y + 3 * Math.pow(1 - tt2, 2) * tt2 * p1.y + 3 * (1 - tt2) * tt2 * tt2 * p2.y + tt2 ** 3 * p3.y;
        glow(ctx, C.cyan, 12, .9);
        ctx.fillStyle = rgba('#E9FBFF', .95);
        ctx.beginPath(); ctx.arc(px2, py2, 2.4, 0, 6.2832); ctx.fill();
        noGlow(ctx);
      }
      ctx.restore();
    }

    /* ---- HUD：扩散步进 ---- */
    // 右侧步进计数器
    const stepA = ease.out2(span(lt, 1.5, 2.0)) * (1 - outP);
    if (stepA > .01) {
      const step = Math.min(28, Math.floor(span(lt, 2.0, 5.5) * 28));
      ctx.save();
      ctx.globalAlpha = stepA;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.font = font.mono(12, 600);
      ctx.fillStyle = rgba('#7C8DAE', .9);
      drawTracked(ctx, 'DENOISE STEP', W - 96, H * .30, 2.4, { align: 'right' });
      ctx.font = font.mono(74, 300);
      const cur = String(step).padStart(2, '0');
      ctx.fillStyle = rgba('#EAF4FF', .96);
      glow(ctx, C.cyan, 26, .5);
      drawTracked(ctx, cur, W - 96, H * .30 + 56, 2, { align: 'right' });
      noGlow(ctx);
      ctx.font = font.mono(22, 400);
      ctx.fillStyle = rgba('#7C8DAE', .7);
      drawTracked(ctx, '/ 28', W - 96, H * .30 + 100, 1.6, { align: 'right' });
      ctx.restore();

      // 垂直步进刻度
      ctx.save();
      ctx.globalAlpha = stepA * .85;
      const gx = W - 150, gy0 = H * .30 + 150, gy1 = H * .74;
      ctx.strokeStyle = rgba('#6E90BC', .35); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(gx, gy0); ctx.lineTo(gx, gy1); ctx.stroke();
      for (let i = 0; i <= 14; i++) {
        const yy = lerp(gy0, gy1, i / 14);
        const on = i / 14 <= step / 28;
        ctx.strokeStyle = on ? rgba(C.cyan, .9) : rgba('#6E90BC', .35);
        ctx.lineWidth = on ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(gx - (i % 2 ? 7 : 13) * (on ? 1 : .6), yy); ctx.lineTo(gx, yy); ctx.stroke();
      }
      ctx.restore();
    }

    // 时间条件（时序注意力的伏笔）
    if (lt > 3.4 && outP < .9) {
      const a = ease.out2(span(lt, 3.4, 4.0)) * (1 - outP);
      ctx.save();
      ctx.globalAlpha = a;
      const wx = bx, wy = by + bh + 62, ww = bw, wh = 46;
      ctx.strokeStyle = rgba(C.violet, .30); ctx.lineWidth = 1;
      rr(ctx, wx, wy, ww, wh, 6); ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i <= 260; i++) {
        const u = i / 260;
        const x = wx + u * ww;
        const y = wy + wh / 2 + Math.sin(u * 22 + t * 3.4) * 12 * (0.4 + 0.6 * Math.sin(u * 3.1 + t));
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = rgba(C.violet, .9); ctx.lineWidth = 1.6;
      glow(ctx, C.violet, 14, .6); ctx.stroke(); noGlow(ctx);
      ctx.font = font.mono(12, 500);
      ctx.fillStyle = rgba('#7C8DAE', .9);
      drawTracked(ctx, 'TEMPORAL ATTENTION  121 frames', wx + 10, wy - 14, 1.8);
      ctx.restore();
    }

    // 左上标题
    const titleA = ease.out2(span(lt, .9, 1.6)) * (1 - outP);
    ctx.save();
    ctx.globalAlpha = titleA;
    ctx.textBaseline = 'middle';
    ctx.font = font.cn(30, 600);
    const tstr = '潜空间 · 从纯噪声中显现';
    const tw = U.trackedWidth(ctx, tstr, 3);
    ctx.fillStyle = U.lg(ctx, 92, 0, 92 + tw, 0, [[0, '#FFFFFF'], [1, rgba(C.cyan, .85)]]);
    drawTracked(ctx, tstr, 92, H * .22 - 40, 3);
    ctx.font = font.mono(14, 500);
    ctx.fillStyle = rgba('#7C8DAE', .95);
    drawTracked(ctx, 'LATENT SPACE  128 × 96 × 16  ·  DDIM-28', 92, H * .22 - 8, 2.2);
    ctx.restore();
  }

  /* ==========================================================================
     分镜 5 · 时序一致性
     ========================================================================== */
  const NF = 12;

  // 胶片槽的“定形成品”缓存：一次性画好，之后每帧只做一次 drawImage
  const _slotCache = {};
  function slotCanvas(k) {
    if (_slotCache[k]) return _slotCache[k];
    const CW = 352, CH = 224;                       // 2.5 倍超采样
    const off = U.offscreen(CW, CH, 1);
    const x = off.ctx;
    x.fillStyle = U.lg(x, 0, 0, 0, CH, [[0, '#050A14'], [.45, '#08111F'], [1, '#04070E']]);
    x.fillRect(0, 0, CW, CH);
    const cw = CW / FILM.GX, chh = CH / FILM.GY;
    for (let j = 0; j < FILM.GY; j++) {
      for (let i = 0; i < FILM.GX; i++) {
        const c = FILM.cellOf(i, j);
        x.globalAlpha = clamp(.88 + .12 * FILM.lumOf(c), 0, 1);
        x.fillStyle = c.color;
        x.fillRect(i * cw, j * chh, cw + .6, chh + .6);
        // 顶部亮边（缩略图尺度下只需一条细亮线）
        x.globalAlpha = .78;
        x.fillStyle = rgba('#EAFBFF', .62);
        x.fillRect(i * cw, j * chh, cw + .6, Math.max(1.2, chh * .12));
        if (c.warm > .12) {
          x.globalAlpha = c.warm * .8;
          x.fillStyle = rgba(C.amber, .9);
          x.fillRect(i * cw, j * chh + chh * .55, cw + .6, Math.max(1.2, chh * .18));
        }
      }
    }
    x.globalAlpha = .14;
    x.fillStyle = U.lg(x, 0, 0, CW, 0, [[0, 'rgba(0,0,0,0)'], [.5, rgba(C.cyan, .55)], [1, 'rgba(0,0,0,0)']]);
    x.fillRect(0, 0, CW, CH);
    _slotCache[k] = off.canvas;
    return _slotCache[k];
  }

  function shot5(ctx, lt, dur, t) {
    BG.frags(ctx, t, { alpha: .18, spread: 1, dim: .5 });

    const stripY = H * .365, sw = 140, sh = 89, gap = 20;
    const totalW = NF * sw + (NF - 1) * gap;        // 1900 < 1920，两侧各留 10px
    const x0 = (W - totalW) / 2;
    const tx0 = 88;                                  // 文字另起安全左边距，不跟着胶片条贴边

    const inP = ease.out4(span(lt, .05, .7));
    const outP = ease.in3(span(lt, 6.3, 7.2));
    const scan = span(lt, .9, 4.5);
    const scanX = x0 - 40 + (totalW + 80) * ease.io2(scan);

    ctx.save();
    ctx.globalAlpha = inP * (1 - outP);

    // 顶部标题
    ctx.textBaseline = 'middle';
    const tstr = '时序一致性 · 让 121 帧像同一台摄影机拍的';
    const tPx = U.fitTracked(ctx, tstr, 3, W - 260, 30, 600, U.F.ui);
    ctx.font = font.cn(tPx, 600);
    const tw = U.trackedWidth(ctx, tstr, 3);
    ctx.fillStyle = U.lg(ctx, tx0, 0, tx0 + tw, 0, [[0, '#FFFFFF'], [1, rgba(C.violet, .9)]]);
    drawTracked(ctx, tstr, tx0, H * .195, 3);
    ctx.font = font.mono(14, 500);
    ctx.fillStyle = rgba('#7C8DAE', .95);
    drawTracked(ctx, 'TEMPORAL CONSISTENCY  ·  Δframe ≤ 0.008', tx0, H * .195 + 30, 2.2);

    // 关键帧槽：噪声 → 清晰，随扫描头推进
    for (let k = 0; k < NF; k++) {
      const x = x0 + k * (sw + gap), y = stripY;
      const local = clamp((scanX - (x - 60)) / (sw * 1.1));
      const settled = ease.out3(local);
      const revealA = ease.out2(clamp(span(lt, .25 + k * .04, .8 + k * .04)));

      ctx.save();
      ctx.globalAlpha = inP * (1 - outP) * revealA;
      // 槽体
      ctx.fillStyle = rgba('#070E1C', .9);
      rr(ctx, x - 3, y - 3, sw + 6, sh + 6, 6); ctx.fill();
      ctx.strokeStyle = settled > .98 ? rgba(C.cyan, .55) : rgba('#6E90BC', .25);
      ctx.lineWidth = 1;
      rr(ctx, x - 3, y - 3, sw + 6, sh + 6, 6); ctx.stroke();

      // 内容：已定形的格子直接贴缓存的成品缩略图（286 格 → 1 次 drawImage）
      const done = settled >= 0.999;
      ctx.save();
      rr(ctx, x, y, sw, sh, 4); ctx.clip();
      if (done) {
        ctx.drawImage(slotCanvas(k), x, y);
      } else {
        FILM.drawGrid(ctx, { sx: x, sy: y, sw, sh }, t * .5 + k, settled, { id: k, quality: .6, glow: .5, speed: .8 });
        FILM.grainOver(ctx, { sx: x, sy: y, sw, sh }, t + k, (1 - settled) * .8, k % 3);
        // 显影扫线（只在“正在显影”的一格上出现）
        if (settled > .02) {
          const mx = x + sw * local;
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = U.lg(ctx, mx - 46, 0, mx + 8, 0, [[0, rgba(C.cyan, 0)], [.75, rgba(C.cyan, .18)], [1, rgba('#EAFBFF', .34)]]);
          ctx.fillRect(x, y, sw, sh);
        }
      }
      ctx.restore();

      // 帧号
      ctx.globalAlpha = inP * (1 - outP) * .8;
      ctx.font = font.mono(10, 500);
      ctx.fillStyle = done ? rgba(C.cyan, .9) : rgba('#7C8DAE', .8);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('f' + String(k * 11 + 1).padStart(3, '0'), x, y + sh + 15);
      ctx.restore();
    }

    // 运动轨迹：关键帧之间的连续光带（体现“连贯”）
    const curveA = ease.out2(span(lt, 1.3, 2.2)) * (1 - outP);
    if (curveA > .01) {
      const cy0 = stripY + sh + 78, amp = 62;
      const draw = ease.out3(span(lt, 1.5, 3.6));
      ctx.save();
      ctx.globalAlpha = curveA;
      // 参考网格
      ctx.strokeStyle = rgba('#6E90BC', .18); ctx.lineWidth = 1;
      for (let i = 0; i <= 8; i++) {
        const x = x0 + totalW * i / 8;
        ctx.beginPath(); ctx.moveTo(x, cy0 - amp - 24); ctx.lineTo(x, cy0 + amp + 24); ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(x0 - 20, cy0); ctx.lineTo(x0 + totalW + 20, cy0); ctx.stroke();

      // 平滑运动曲线
      const N = 240;
      ctx.beginPath();
      for (let i = 0; i <= N * draw; i++) {
        const u = i / N;
        const x = x0 + u * totalW;
        const y = cy0 - Math.sin(u * 3.4 + .6) * amp * (1 - .35 * u) - Math.sin(u * 9.1) * 9;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = rgba(C.cyan, .95); ctx.lineWidth = 2.2;
      glow(ctx, C.cyan, 18, .7); ctx.stroke(); noGlow(ctx);

      // 关键帧节点（把连续运动切成 12 段）
      for (let k = 0; k < NF; k++) {
        const u = (k + .5) / NF;
        const x = x0 + u * totalW;
        const y = cy0 - Math.sin(u * 3.4 + .6) * amp * (1 - .35 * u) - Math.sin(u * 9.1) * 9;
        const on = u <= draw;
        if (!on) continue;
        ctx.fillStyle = rgba('#EAF4FF', .95);
        glow(ctx, C.violet, 14, .8);
        ctx.beginPath(); ctx.arc(x, y, 4.2, 0, 6.2832); ctx.fill(); noGlow(ctx);
        ctx.strokeStyle = rgba(C.violet, .45); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, stripY + sh + 6); ctx.stroke();
      }
      ctx.font = font.mono(13, 500);
      ctx.fillStyle = rgba('#7C8DAE', .95);
      drawTracked(ctx, 'CAMERA MOTION  ·  keyframe interpolation', tx0, cy0 + amp + 54, 2);
      ctx.restore();
    }

    // 扫描头
    if (scan < 1 && inP > .5) {
      ctx.save();
      ctx.globalAlpha = inP * (1 - outP);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = U.lg(ctx, scanX - 90, 0, scanX + 14, 0, [[0, rgba(C.cyan, 0)], [1, rgba('#DFF8FF', .40)]]);
      ctx.fillRect(scanX - 90, stripY - 40, 104, sh + 80);
      ctx.fillStyle = rgba('#FFFFFF', .85);
      ctx.fillRect(scanX, stripY - 34, 1.6, sh + 68);
      noGlow(ctx);
      ctx.restore();
    }

    // HUD（放到底部，避开标题）
    const hudA = ease.out2(span(lt, 1.2, 1.8)) * (1 - outP);
    ctx.save();
    ctx.globalAlpha = hudA;
    const settledN = Math.min(121, Math.floor(scan * 121));
    const hy0 = H * .775;
    BG.kv(ctx, 92, hy0, 'FRAMES', `${String(settledN).padStart(3, '0')} / 121`, { size: 15 });
    BG.kv(ctx, 92, hy0 + 28, 'MOTION', 'optical-flow guided', { size: 15 });
    BG.kv(ctx, 92, hy0 + 56, 'ΔFRAME', (lerp(0.412, 0.006, ease.out3(scan))).toFixed(3), { size: 15, color: rgba(C.mint, .95) });
    BG.kv(ctx, 300, hy0 + 56, 'FLICKER', (lerp(18.4, 0.2, ease.out3(scan))).toFixed(1), { size: 15, color: rgba(C.mint, .95) });
    if (scan >= .99) BG.kv(ctx, 300, hy0, 'STATUS', 'seamless ✓', { size: 15, color: rgba(C.mint, .95) });
    ctx.restore();

    if (lt > 4.6 && lt < 6.1) {
      BG.caption(ctx, '逐帧对齐：轨迹平滑、无闪烁、无跳变', W * .5 - 240, H * .885, lt - 4.6, { size: 17, cps: 30 });
    }
    ctx.restore();
  }

  /* ==========================================================================
     分镜 6 · 解码重建
     ========================================================================== */
  const DK = { x: 700, y: 328, w: 520, h: 400 };
  const DCOLS = 16, DROWS = 13;

  // 能力探测：pattern 变换需要 DOMMatrix；不可用时走逐格绘制的降级路径
  const HAS_PATTERN_XFORM = (() => {
    try {
      const c = document.createElement('canvas').getContext('2d');
      const p = c.createPattern(document.createElement('canvas'), 'repeat');
      return typeof DOMMatrix === 'function' && !!p && typeof p.setTransform === 'function';
    } catch (e) { return false; }
  })();

  function shot6(ctx, lt, dur, t) {
    BG.frags(ctx, t, { alpha: .16, spread: 1.1, dim: .45, bandY: H * .80 });
    BG.floorGrid(ctx, t, { hy: H * .82, alpha: .07 });

    const inP = ease.out4(span(lt, .05, .6));
    const expand = ease.io3(span(lt, .75, 1.6));
    const decodeP = span(lt, 1.7, 4.5);
    const outP = ease.in3(span(lt, 4.8, 5.4));

    const cx = DK.x + DK.w / 2, cy = DK.y + DK.h / 2;

    ctx.save();
    ctx.globalAlpha = inP * (1 - outP);

    // 面板
    panel(ctx, { x: DK.x - 46, y: DK.y - 92, w: DK.w + 92, h: DK.h + 158 }, { bLen: 22 });

    ctx.textBaseline = 'middle';
    ctx.font = font.cn(26, 600);
    const tstr = '解码 · 潜变量还原为像素';
    const tw = U.trackedWidth(ctx, tstr, 2.6);
    ctx.fillStyle = U.lg(ctx, DK.x, 0, DK.x + tw, 0, [[0, '#FFFFFF'], [1, rgba(C.violet, .9)]]);
    drawTracked(ctx, tstr, DK.x, DK.y - 54, 2.6);
    ctx.font = font.mono(13, 500);
    ctx.fillStyle = rgba('#7C8DAE', .95);
    drawTracked(ctx, 'VAE DECODER  ·  patch 8×8  ·  RGB', DK.x, DK.y - 26, 2);

    // 从上一镜收拢进来的“压缩条” → 展开为像素网格
    const gH = DK.h * expand;                       // 网格当前总高
    const gY = cy - gH / 2;
    const cw = DK.w / DCOLS, chh = DK.h / DROWS;

    if (HAS_PATTERN_XFORM) {
      // 快路径：canvas pattern + 变换矩阵，一块矩形画出被压扁的整张图
      for (let k = 0; k < 3; k++) {
        const bandY = gY + gH * k / 3, bandH = gH / 3 + .5;
        const pat = ctx.createPattern(decodeCanvas(2 - k), 'repeat');
        if (!pat) break;
        ctx.save();
        ctx.globalAlpha = inP * (1 - outP) * (0.30 + 0.70 * expand);
        ctx.beginPath(); ctx.rect(DK.x, bandY, DK.w, bandH); ctx.clip();
        pat.setTransform(new DOMMatrix().translate(DK.x, bandY).scale(cw / 48, (bandH / DROWS) / 48));
        ctx.fillStyle = pat;
        ctx.fillRect(DK.x, bandY, DK.w, bandH);
        ctx.restore();
      }
    } else {
      // 降级路径：直接按格绘制，同样带解码波次（不支持 DOMMatrix / pattern 变换时使用）
      ctx.save();
      ctx.globalAlpha = inP * (1 - outP) * .95;
      for (let j = 0; j < DROWS; j++) {
        for (let i = 0; i < DCOLS; i++) {
          const u = i / (DCOLS - 1), v = j / (DROWS - 1);
          const ph = u * .48 + v * .52;
          const e = ease.io3(clamp(decodeP - ph * .60));
          const gi = clamp(Math.round(lerp(FILM.GX * .30, FILM.GX * .82 - 1, u)), 0, FILM.GX - 1);
          const gj = clamp(Math.round(lerp(FILM.GY * .22, FILM.GY * .92 - 1, v)), 0, FILM.GY - 1);
          const c = FILM.cellOf(gi, gj);
          const r = U.rng(6000 + i * 17 + j * 53);
          const cold = `rgb(${(26 + r.next() * 40) | 0},${(38 + r.next() * 46) | 0},${(60 + r.next() * 52) | 0})`;
          ctx.fillStyle = e > .86 ? c.color : cold;
          ctx.fillRect(DK.x + i * cw, gY + j * chh, cw + .6, chh + .6);
          if (e > .3) {
            ctx.globalAlpha = inP * (1 - outP) * (.3 + .45 * e);
            ctx.fillStyle = rgba('#EAFBFF', .9);
            ctx.fillRect(DK.x + i * cw, gY + j * chh, cw + .6, Math.max(1, chh * .14));
            ctx.globalAlpha = inP * (1 - outP) * .95;
          }
        }
      }
      ctx.restore();
    }

    // 解码完成：像素格亮边（让它读起来是“一块块像素”而不是一张图）
    if (expand > .96 && decodeP > .35) {
      ctx.save();
      ctx.globalAlpha = inP * (1 - outP) * .30 * clamp(span(lt, 2.0, 3.2));
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba('#CFEFFF', .5); ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < DCOLS; i++) { ctx.moveTo(DK.x + i * cw, gY); ctx.lineTo(DK.x + i * cw, gY + gH); }
      for (let j = 1; j < DROWS; j++) { ctx.moveTo(DK.x, gY + j * chh); ctx.lineTo(DK.x + DK.w, gY + j * chh); }
      ctx.stroke();
      ctx.restore();
    }

    // RGB 通道分离（短暂，只在解码刚完成时）
    const splitA = Math.sin(clamp(span(lt, 3.0, 4.2)) * Math.PI) * (expand > .95 ? 1 : 0);
    if (splitA > .02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = inP * (1 - outP) * splitA * .22;
      ctx.drawImage(decodeCanvas(1), DK.x - 7 * splitA, gY + 4 * splitA, DK.w, gH);
      ctx.drawImage(decodeCanvas(1), DK.x + 7 * splitA, gY - 4 * splitA, DK.w, gH);
      ctx.restore();
    }

    // 网格外框
    ctx.globalAlpha = inP * (1 - outP) * expand;
    ctx.strokeStyle = rgba('#6E90BC', .35); ctx.lineWidth = 1;
    ctx.strokeRect(DK.x - .5, gY - .5, DK.w + 1, gH + 1);
    brackets(ctx, DK.x - 10, gY - 10, DK.w + 20, gH + 20, 18, rgba(C.violet, .8), 2, expand);
    ctx.restore();

    // 解码进度 + HUD
    const hudA = ease.out2(span(lt, 1.4, 2.0)) * (1 - outP);
    ctx.save();
    ctx.globalAlpha = hudA;
    const done = ease.out3(decodeP);
    BG.kv(ctx, 92, H * .22, 'DECODER', 'vae.fp16', { size: 15 });
    BG.kv(ctx, 92, H * .22 + 30, 'TILES', '8 × 8', { size: 15 });
    BG.kv(ctx, 92, H * .22 + 60, 'PIXELS', `${Math.round(done * 100)} %`, { size: 15, color: rgba(C.violet, .95) });
    if (decodeP >= .99) BG.kv(ctx, 92, H * .22 + 90, 'STATUS', 'decoded ✓', { size: 15, color: rgba(C.mint, .95) });

    // 右侧：完成后从网格抽出一帧画面预览
    ctx.restore();

    if (lt > 4.0 && outP < .9) {
      const a = ease.out3(span(lt, 4.0, 4.7)) * (1 - outP);
      const sc = lerp(.72, 1, ease.out4(span(lt, 4.0, 4.9)));
      ctx.save();
      ctx.globalAlpha = a;
      const pw = 420, ph = 236, px = W - 100 - pw, py = H * .50;
      ctx.save();
      ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
      ctx.fillStyle = rgba('#060B16', .95);
      rr(ctx, px - 6, py - 6, pw + 12, ph + 12, 8); ctx.fill();
      ctx.drawImage(decodeCanvas(1), px, py, pw, ph);
      ctx.restore();
      brackets(ctx, px - 12, py - 12, pw + 24, ph + 24, 18, rgba(C.cyan, .85), 1.8, a);
      ctx.font = font.mono(13, 500);
      ctx.fillStyle = rgba('#7C8DAE', .95);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      drawTracked(ctx, 'FRAME 001  ·  960 × 540', px - 4, py + ph + 30, 1.8);
      ctx.restore();
    }
  }

  // 解码贴图缓存：三份不同解码相位的版本，用 pattern 实现“压扁 → 展开”
  const _dec = {};
  const DEC_RES = 48;                     // 每格 3px 的贴图尺寸
  function decodeCanvas(phase) {
    if (_dec[phase]) return _dec[phase];
    const off = U.offscreen(DEC_RES * DCOLS, DEC_RES * DROWS, 1);
    const p = off.ctx;
    // 计算整张贴图对应的地表区域（保证每格内容不重复）
    const ci0 = Math.floor(FILM.GX * 0.30), ci1 = Math.max(ci0 + DCOLS, Math.ceil(FILM.GX * 0.82));
    const cj0 = Math.floor(FILM.GY * 0.22), cj1 = Math.max(cj0 + DROWS, Math.ceil(FILM.GY * 0.92));
    p.fillStyle = '#05090F';
    p.fillRect(0, 0, off.w, off.h);
    for (let j = 0; j < DROWS; j++) {
      for (let i = 0; i < DCOLS; i++) {
        const u = i / (DCOLS - 1), v = j / (DROWS - 1);
        const gi = clamp(Math.round(lerp(ci0, ci1 - 1, u)), 0, FILM.GX - 1);
        const gj = clamp(Math.round(lerp(cj0, cj1 - 1, v)), 0, FILM.GY - 1);
        const c = FILM.cellOf(gi, gj);
        const tgt = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(c.color);
        const tr = tgt ? +tgt[1] : 90, tg = tgt ? +tgt[2] : 130, tb = tgt ? +tgt[3] : 180;
        const ph = u * .48 + v * .52;
        const e = ease.io3(clamp((3 - phase) / 4 - ph * .60));
        const r = U.rng(6000 + i * 17 + j * 53);
        // 冷灰未解码色 → 目标色
        const cr = lerp(26 + r.next() * 40, tr, e);
        const cg2 = lerp(38 + r.next() * 46, tg, e);
        const cb = lerp(60 + r.next() * 52, tb, e);
        p.fillStyle = `rgb(${cr | 0},${cg2 | 0},${cb | 0})`;
        const cellW = off.w / DCOLS, cellH = off.h / DROWS;
        p.fillRect(i * cellW, j * cellH, cellW + .4, cellH + .4);
        // 顶部亮边
        p.globalAlpha = .30 + .45 * e;
        p.fillStyle = 'rgba(234,251,255,1)';
        p.fillRect(i * cellW, j * cellH, cellW + .4, Math.max(1, cellH * .14));
        p.globalAlpha = 1;
      }
    }
    _dec[phase] = off.canvas;
    return off.canvas;
  }

  /* ==========================================================================
     分镜 7 · 超分 · 修复
     ========================================================================== */
  const UP = { x: 560, y: 300, w: 1200, h: 675 };

  // 低清层：1/9 分辨率渲染，由 canvas filter 柔化（不支持时退化为多次偏移叠加）
  const SUPPORTS_FILTER = (() => {
    try {
      const c = document.createElement('canvas').getContext('2d');
      c.filter = 'blur(2px)';
      return c.filter === 'blur(2px)';
    } catch (e) { return false; }
  })();
  let _upPlate = null;
  function upscaleBlurPlate() {
    if (_upPlate) return _upPlate;
    const off = U.offscreen(UP.w, UP.h, 1);
    const p = off.ctx;
    p.imageSmoothingEnabled = true;
    p.imageSmoothingQuality = 'high';
    p.globalAlpha = 1;
    p.drawImage(FILM.cleanFrame(Math.round(UP.w / 9), Math.round(UP.h / 9), { gain: .34 }), 0, 0, UP.w, UP.h);
    _upPlate = off.canvas;
    return _upPlate;
  }

  function shot7(ctx, lt, dur, t) {
    BG.frags(ctx, t, { alpha: .14, spread: 1.2, dim: .4, bandY: H * .82 });
    BG.floorGrid(ctx, t, { hy: H * .84, alpha: .06 });

    const inP = ease.out4(span(lt, .05, .6));
    const scrub = ease.io2(span(lt, .8, 4.2));
    const outP = ease.in3(span(lt, 5.0, 5.6));

    ctx.save();
    ctx.globalAlpha = inP * (1 - outP);

    // 外框
    ctx.fillStyle = rgba('#050A14', .9);
    rr(ctx, UP.x - 22, UP.y - 22, UP.w + 44, UP.h + 92, 14); ctx.fill();
    ctx.strokeStyle = rgba('#6E90BC', .28); ctx.lineWidth = 1.25;
    rr(ctx, UP.x - 22, UP.y - 22, UP.w + 44, UP.h + 92, 14); ctx.stroke();
    brackets(ctx, UP.x - 30, UP.y - 30, UP.w + 60, UP.h + 60, 24, rgba(C.cyan, .6), 2);

    // 画面：由糊到清 —— 先铺满清晰层，再用「放大后的低清图层」沿扫掠线擦除
    ctx.save();
    rr(ctx, UP.x, UP.y, UP.w, UP.h, 6); ctx.clip();

    FILM.drawGrid(ctx, { sx: UP.x, sy: UP.y, sw: UP.w, sh: UP.h }, t, 1, { id: 21, glow: .9 });
    // 调色：压一层冷色，避免亮色块糊成一片白
    ctx.fillStyle = 'rgba(8,13,24,.40)';
    ctx.fillRect(UP.x, UP.y, UP.w, UP.h);

    const low = upscaleBlurPlate();          // 低清层（已压暗），随扫掠线被清晰层替换
    const mx = UP.x + UP.w * scrub;
    ctx.save();
    if (scrub > .004) {
      ctx.beginPath();
      ctx.rect(mx, UP.y, Math.max(0, UP.x + UP.w - mx), UP.h);
      ctx.clip();
    }
    ctx.globalAlpha = .95 * (1 - ease.in2(scrub));
    if (SUPPORTS_FILTER) {
      ctx.filter = 'blur(12px)';
      ctx.drawImage(low, UP.x - 8, UP.y - 8, UP.w + 16, UP.h + 16);
      ctx.filter = 'none';
    } else {
      ctx.globalAlpha *= .34;
      for (const d of [[-14, 0], [14, 0], [0, -14], [0, 14], [0, 0]]) {
        ctx.drawImage(low, UP.x + d[0] - 8, UP.y + d[1] - 8, UP.w + 16, UP.h + 16);
      }
    }
    ctx.restore();

    // 扫掠线（只在扫掠头附近铺渐变，不能整块叠加）
    if (scrub > .01 && scrub < .995) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = U.lg(ctx, mx - 80, 0, mx + 12, 0, [[0, rgba(C.cyan, 0)], [1, rgba('#DFF8FF', .40)]]);
      ctx.fillRect(mx - 80, UP.y, 92, UP.h);
      ctx.fillStyle = rgba('#FFFFFF', .9);
      ctx.fillRect(mx, UP.y, 1.8, UP.h);
      ctx.restore();
    }

    // 细节网格覆盖（修复的“纹理”感）
    ctx.save();
    ctx.globalAlpha = .06 * scrub;
    ctx.strokeStyle = rgba('#BFEFFF', .9); ctx.lineWidth = 1;
    for (let i = 0; i < UP.w; i += 24) { ctx.beginPath(); ctx.moveTo(UP.x + i, UP.y); ctx.lineTo(UP.x + i, UP.y + UP.h); ctx.stroke(); }
    ctx.restore();

    ctx.restore();

    // 底部信息条
    ctx.save();
    ctx.globalAlpha = inP * (1 - outP);
    const res = Math.round(lerp(540, 1080, ease.out3(scrub)));
    ctx.font = font.mono(15, 600);
    ctx.fillStyle = rgba('#8FA8C8', .95);
    drawTracked(ctx, 'UPSCALE', UP.x + 4, UP.y + UP.h + 44, 2);
    ctx.fillStyle = rgba('#EAF4FF', .98);
    glow(ctx, C.cyan, 14, .5);
    drawTracked(ctx, `960×540 → ${res}×${Math.round(res * 9 / 16)}`, UP.x + 96, UP.y + UP.h + 44, 2);
    noGlow(ctx);
    ctx.fillStyle = rgba('#7C8DAE', .9);
    drawTracked(ctx, '×2  ESRGAN-lite  ·  denoise 0.35  ·  sharpen 0.6', UP.x + 470, UP.y + UP.h + 44, 1.8);
    ctx.restore();

    ctx.restore();

    // HUD
    const hudA = ease.out2(span(lt, .8, 1.4)) * (1 - outP);
    ctx.save();
    ctx.globalAlpha = hudA;
    BG.kv(ctx, 92, H * .22, 'RESOLUTION', '1920 × 1080', { size: 15 });
    BG.kv(ctx, 92, H * .22 + 30, 'FPS', '30.000', { size: 15 });
    BG.kv(ctx, 92, H * .22 + 60, 'CODEC', 'h.264 · yuv420p', { size: 15 });
    BG.kv(ctx, 92, H * .22 + 90, 'BITRATE', '18.4 Mbps', { size: 15, color: rgba(C.mint, .95) });
    ctx.restore();

    if (lt > 3.4) {
      BG.caption(ctx, '细节重建完成 · 输出就绪', W * .5 - 200, H * .885, lt - 3.4,
        { size: 17, cps: 26, color: rgba(C.mint, .95) });
    }
  }

  /* ==========================================================================
     分镜 8 · 播放
     ========================================================================== */
  const VID = { x: 400, y: 232, w: 1120, h: 630 };

  function shot8(ctx, lt, dur, t) {
    BG.frags(ctx, t, { alpha: .12, spread: 1.3, dim: .35 });
    BG.aurora(ctx, t, .7, .1);

    const inP = ease.out4(span(lt, .05, .7));
    const ken = ease.io2(span(lt, 0, dur));
    const uiP = ease.out3(span(lt, .9, 1.7));
    const loopN = 2;

    ctx.save();
    ctx.globalAlpha = inP;

    // 播放器外框
    ctx.save();
    glow(ctx, C.cyan, 40, .18);
    ctx.fillStyle = rgba('#050A14', .95);
    rr(ctx, VID.x - 16, VID.y - 16, VID.w + 32, VID.h + 74, 12); ctx.fill();
    noGlow(ctx);
    ctx.strokeStyle = rgba('#6E90BC', .30); ctx.lineWidth = 1.25;
    rr(ctx, VID.x - 16, VID.y - 16, VID.w + 32, VID.h + 74, 12); ctx.stroke();
    ctx.restore();

    // 画面（Ken Burns 缓推）
    ctx.save();
    rr(ctx, VID.x, VID.y, VID.w, VID.h, 4); ctx.clip();
    const zoom = 1.04 + .05 * ken;
    const px = VID.x + VID.w * (1 - zoom) / 2 - VID.w * .012 * ken;
    const py = VID.y + VID.h * (1 - zoom) / 2;
    // 色彩底 + 线绘网格双图层
    ctx.drawImage(FILM.cleanFrame(560, 315), px, py, VID.w * zoom, VID.h * zoom);
    FILM.drawGrid(ctx, {
      sx: px, sy: py, sw: VID.w * zoom, sh: VID.h * zoom
    }, t, 1, { id: 31, glow: .8, skipBg: true, skipGlow: true });
    ctx.restore();

    // 画面质感：调色 + 内暗角 + 胶片颗粒
    ctx.save();
    rr(ctx, VID.x, VID.y, VID.w, VID.h, 4); ctx.clip();
    ctx.fillStyle = 'rgba(7,12,22,.34)';
    ctx.fillRect(VID.x, VID.y, VID.w, VID.h);
    ctx.fillStyle = U.rg(ctx, VID.x + VID.w * .5, VID.y + VID.h * .46, VID.w * .72,
      [[0, 'rgba(0,0,0,0)'], [.62, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,.42)']]);
    ctx.fillRect(VID.x, VID.y, VID.w, VID.h);
    ctx.restore();
    FILM.grainOver(ctx, { sx: VID.x, sy: VID.y, sw: VID.w, sh: VID.h }, t, .35, 1);

    // 扫描线质感
    ctx.save();
    rr(ctx, VID.x, VID.y, VID.w, VID.h, 4); ctx.clip();
    ctx.globalAlpha = .07; ctx.fillStyle = '#000';
    for (let y = VID.y; y < VID.y + VID.h; y += 3) ctx.fillRect(VID.x, y, VID.w, 1);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = .05;
    ctx.fillStyle = U.lg(ctx, 0, VID.y, 0, VID.y + VID.h * .5, [[0, rgba(C.cyan, .35)], [1, 'rgba(0,0,0,0)']]);
    ctx.fillRect(VID.x, VID.y, VID.w, VID.h);
    ctx.restore();

    brackets(ctx, VID.x - 26, VID.y - 26, VID.w + 52, VID.h + 52, 26, rgba(C.cyan, .55), 2, inP);

    // 播放器 UI
    ctx.save();
    ctx.globalAlpha = inP * uiP;
    // 播放 / 暂停按钮
    const bxx = VID.x + 4, byy = VID.y + VID.h + 40;
    ctx.save();
    glow(ctx, C.cyan, 20, .35);
    ctx.fillStyle = rgba(C.cyan, .12);
    ctx.beginPath(); ctx.arc(bxx, byy, 17, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = rgba(C.cyan, .8); ctx.lineWidth = 1.4; ctx.stroke();
    noGlow(ctx);
    // 双竖线（暂停态 = 正在播放中）
    ctx.fillStyle = rgba('#DFF6FF', .95);
    const pulse = .7 + .3 * Math.sin(t * 4);
    ctx.globalAlpha = inP * uiP * pulse;
    ctx.fillRect(bxx - 5, byy - 7, 3.4, 14);
    ctx.fillRect(bxx + 1.6, byy - 7, 3.4, 14);
    ctx.restore();

    // 进度条
    const trackX = bxx + 34, trackW = VID.w - 34 - 190;
    const prog = ((t * .42) % 1);
    ctx.globalAlpha = inP * uiP;
    ctx.fillStyle = rgba('#22304A', .9);
    rr(ctx, trackX, byy - 2.5, trackW, 5, 3); ctx.fill();
    ctx.fillStyle = U.lg(ctx, trackX, 0, trackX + trackW, 0, [[0, C.amber], [.5, C.cyan], [1, C.violet]]);
    rr(ctx, trackX, byy - 2.5, trackW * prog, 5, 3); ctx.fill();
    // 已缓冲
    ctx.fillStyle = rgba('#5FE3FF', .18);
    rr(ctx, trackX, byy - 2.5, trackW * Math.min(1, prog + .18), 5, 3); ctx.fill();
    // 播放头
    ctx.save();
    glow(ctx, C.cyan, 16, .8);
    ctx.fillStyle = '#EAFBFF';
    ctx.beginPath(); ctx.arc(trackX + trackW * prog, byy, 5.4, 0, 6.2832); ctx.fill();
    noGlow(ctx);
    ctx.restore();

    // 时间码
    ctx.font = font.mono(15, 500);
    ctx.fillStyle = rgba('#C6D8F0', .95);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const el = prog * 8.0;
    ctx.fillText(`00:0${Math.floor(el)}.${String(Math.floor((el % 1) * 100)).padStart(2, '0')}`, trackX + trackW + 26, byy);

    // 右上角分辨率角标
    ctx.font = font.mono(12, 600);
    ctx.fillStyle = rgba('#9FB6D8', .9);
    drawTracked(ctx, '1080P · 30FPS', VID.x + VID.w - 2, VID.y + VID.h + 40, 1.8, { align: 'right' });
    ctx.restore();

    // 提示词回显（小字，琥珀）
    ctx.save();
    ctx.globalAlpha = inP * uiP * .9;
    ctx.font = font.mono(15, 500);
    ctx.fillStyle = rgba(C.amber, .8);
    drawTracked(ctx, '▸ ' + PROMPT, VID.x - 14, VID.y - 62, 1.5);
    ctx.font = font.mono(12, 500);
    ctx.fillStyle = rgba('#7C8DAE', .9);
    drawTracked(ctx, `seed 77419 · 121 frames · 4.0s · cfg 7.5`, VID.x - 14, VID.y - 38, 1.6);
    ctx.restore();

    ctx.restore();

    // 右下角 HUD 读数
    const hudA = ease.out2(span(lt, 1.4, 2.0));
    ctx.save();
    ctx.globalAlpha = hudA;
    BG.kv(ctx, 92, H * .22, 'RENDER', 'complete ✓', { size: 15, color: rgba(C.mint, .95) });
    BG.kv(ctx, 92, H * .22 + 30, 'TIME', `${(4.2 + lt * .1).toFixed(1)} s`, { size: 15 });
    BG.kv(ctx, 92, H * .22 + 60, 'VRAM', '21.4 / 24 GB', { size: 15 });
    BG.kv(ctx, 92, H * .22 + 90, 'OUTPUT', 'prompt_77419.mp4', { size: 15 });
    ctx.restore();
    void loopN;
  }

  /* ==========================================================================
     分镜 9 · 签名 · 循环
     ========================================================================== */
  function shot9(ctx, lt, dur, t) {
    BG.frags(ctx, t, { alpha: .1, spread: 1.5, dim: .3 });
    BG.aurora(ctx, t, .55, .18);

    const inP = ease.out4(span(lt, .05, .8));
    const cx = W / 2;

    // 主标题
    ctx.save();
    ctx.globalAlpha = inP;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const tstr = '提示词  →  视频';
    ctx.font = font.cn(96, 700);
    const tw = U.trackedWidth(ctx, tstr, 8);
    // 渐变填充 + 辉光
    const wave = clamp(span(lt, .2, 1.4));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, C.cyan, 60, .35 * wave);
    ctx.fillStyle = U.gradBrand(ctx, cx - tw / 2, 0, cx + tw / 2, 0, .96);
    drawTracked(ctx, tstr, cx, H * .38, 8, { align: 'center' });
    noGlow(ctx);
    ctx.restore();

    // 顶部细线扫过（装饰）
    if (lt > .35 && lt < 1.5) {
      const a = Math.sin(clamp(span(lt, .35, 1.5)) * Math.PI);
      ctx.globalAlpha = inP * a * .8;
      ctx.globalCompositeOperation = 'lighter';
      const sx = lerp(cx - tw / 2 - 200, cx + tw / 2 + 200, ease.io2(span(lt, .35, 1.5)));
      ctx.fillStyle = U.lg(ctx, sx - 160, 0, sx, 0, [[0, rgba(C.cyan, 0)], [1, rgba('#FFFFFF', .5)]]);
      ctx.fillRect(sx - 160, H * .38 - 86, 160, 3);
    }
    ctx.restore();

    // 副标题
    ctx.save();
    ctx.globalAlpha = inP * ease.out2(span(lt, .9, 1.6));
    ctx.font = font.mono(17, 500);
    ctx.fillStyle = rgba('#93A9C9', .95);
    drawTracked(ctx, 'ONE PROMPT  ·  TWENTY-EIGHT DENOISE STEPS  ·  ONE HUNDRED TWENTY-ONE FRAMES',
      cx, H * .38 + 82, 3, { align: 'center' });
    ctx.restore();

    // 三张作品卡
    const cards = [
      { x: cx - 640, y: H * .62, w: 380, h: 214, tag: 'TAKE 01', col: C.amber },
      { x: cx - 190, y: H * .62, w: 380, h: 214, tag: 'TAKE 02', col: C.cyan },
      { x: cx + 260, y: H * .62, w: 380, h: 214, tag: 'TAKE 03', col: C.violet }
    ];
    ctx.save();
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const a = ease.out3(clamp(span(lt, 1.1 + i * .16, 1.8 + i * .16))) * inP;
      if (a <= .002) continue;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(0, (1 - ease.out3(clamp(span(lt, 1.1 + i * .16, 1.9 + i * .16)))) * 26);
      ctx.save();
      glow(ctx, c.col, 18, .16);
      ctx.fillStyle = rgba('#070E1C', .94);
      rr(ctx, c.x, c.y, c.w, c.h, 10); ctx.fill();
      noGlow(ctx);
      ctx.strokeStyle = rgba(c.col, .40); ctx.lineWidth = 1.25;
      rr(ctx, c.x, c.y, c.w, c.h, 10); ctx.stroke();

      ctx.save();
      rr(ctx, c.x + 10, c.y + 10, c.w - 20, c.h - 52, 6); ctx.clip();
      const zb = 1 + .06 * Math.sin(t * .4 + i);
      ctx.translate(c.x + c.w / 2, c.y + (c.h - 42) / 2 + 10);
      ctx.scale(zb, zb);
      ctx.translate(-(c.x + c.w / 2), -(c.y + (c.h - 42) / 2 + 10));
      ctx.drawImage(FILM.cleanFrame(400, 225), c.x + 10, c.y + 10, c.w - 20, c.h - 52);
      FILM.drawGrid(ctx, { sx: c.x + 10, sy: c.y + 10, sw: c.w - 20, sh: c.h - 52 }, t + i, 1,
        { skipBg: true, skipGlow: true, id: 40 + i, glow: .6 });
      ctx.restore();

      ctx.font = font.mono(13, 600);
      ctx.fillStyle = rgba(c.col, .95);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      drawTracked(ctx, c.tag, c.x + 16, c.y + c.h - 26, 2);
      ctx.fillStyle = rgba('#7C8DAE', .9);
      ctx.textAlign = 'right';
      drawTracked(ctx, `${4 + i}s · 1080p`, c.x + c.w - 16, c.y + c.h - 26, 1.6, { align: 'right' });
      ctx.restore();
    }
    ctx.restore();

    // 底部签名行
    ctx.save();
    ctx.globalAlpha = inP * ease.out2(span(lt, 2.1, 2.8));
    const lineW = 420;
    ctx.strokeStyle = rgba('#6E90BC', .4); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - lineW / 2, H * .868); ctx.lineTo(cx - 26, H * .868); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 26, H * .868); ctx.lineTo(cx + lineW / 2, H * .868); ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, H * .868, 5, 0, 6.2832);
    ctx.strokeStyle = rgba(C.cyan, .8); ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, H * .868, 1.8, 0, 6.2832);
    ctx.fillStyle = rgba(C.cyan, .95); ctx.fill();

    ctx.font = font.mono(14, 500);
    ctx.fillStyle = rgba('#93A9C9', .95);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    drawTracked(ctx, 'MODEL', cx - 176, H * .868, 2);
    ctx.fillStyle = rgba('#DCEAFF', .95);
    drawTracked(ctx, 'txt2video v3.2', cx - 108, H * .868, 2);
    ctx.fillStyle = rgba('#93A9C9', .95);
    drawTracked(ctx, 'RUNTIME', cx + 66, H * .868, 2);
    ctx.fillStyle = rgba(C.mint, .95);
    drawTracked(ctx, '4.2s', cx + 148, H * .868, 2);
    ctx.restore();

    // 黑场收束（盖住除 HUD 外的全部内容，HUD 在 render 末尾统一淡出）
    const out = ease.in2(span(lt, dur - .8, dur));
    BG.veil(ctx, out * .94);
    return out;
  }

  /* ==========================================================================
     连续性层：把上一镜的元素带进下一镜（交叉淡化，几帧即可）
     ========================================================================== */
  function continuity(ctx, cur, lt, t) {
    // 1) 光柱：分镜1 → 2
    if (cur === 'prompt') {
      const a = 1 - ease.out3(span(lt, 0, .45));
      if (a > .01) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a * .9;
        glow(ctx, C.amber, 40, .9);
        ctx.fillStyle = U.lg(ctx, W * .5 - 700, 0, W * .5 + 700, 0,
          [[0, rgba(C.amber, 0)], [.5, rgba('#FFF8E6', .95)], [1, rgba(C.amber, 0)]]);
        ctx.fillRect(W * .5 - 700, H * .47 - 1.5, 1400, 3);
        noGlow(ctx); ctx.restore();
      }
    }
    // 2) 提示词盒 → 分词：暖色残影收缩
    if (cur === 'token') {
      const a = 1 - ease.out3(span(lt, 0, .4));
      if (a > .01) {
        ctx.save();
        ctx.globalAlpha = a * .5;
        ctx.globalCompositeOperation = 'lighter';
        const sc = lerp(1, .3, 1 - a);
        ctx.translate(W * .5, H * .46); ctx.scale(sc, sc); ctx.translate(-W * .5, -H * .46);
        ctx.strokeStyle = rgba(C.amber, .6); ctx.lineWidth = 2;
        rr(ctx, BOX.x, BOX.y + 100, BOX.w, 60, 30); ctx.stroke();
        noGlow(ctx); ctx.restore();
      }
    }
    // 3) 潜空间网格 → 时序：网格淡出把位置让给胶片条
    if (cur === 'temporal') {
      const a = 1 - ease.out2(span(lt, 0, .5));
      if (a > .01) {
        ctx.save();
        ctx.globalAlpha = a * .35;
        const b = S.gridBox;
        FILM.drawGrid(ctx, { sx: b.sx, sy: b.sy + 60, sw: b.sw, sh: b.sh * .6 },
          t, 1, { skipBg: true, skipGlow: true, id: 55, glow: .25 });
        ctx.restore();
      }
    }
    // 4) 解码 → 超分：上一帧画面残留
    if (cur === 'upscale') {
      const a = 1 - ease.out2(span(lt, 0, .35));
      if (a > .01) {
        ctx.save();
        ctx.globalAlpha = a * .35;
        ctx.drawImage(FILM.cleanFrame(560, 315), UP.x, UP.y, UP.w, UP.h);
        ctx.restore();
      }
    }
    // 5) 超分 → 播放：画面继续存在，被播放器接管
    if (cur === 'player') {
      const a = 1 - ease.out2(span(lt, 0, .28));
      if (a > .01) {
        ctx.save();
        ctx.globalAlpha = a * .5;
        ctx.drawImage(FILM.cleanFrame(560, 315), VID.x, VID.y, VID.w, VID.h);
        ctx.restore();
      }
    }
    void t;
  }

  /* ==========================================================================
     分镜总表：每镜绘制 + 底层氛围 + 连续性 + 切点闪光
     ========================================================================== */
  const SHOTS = {
    void: shot1, prompt: shot2, token: shot3, latent: shot4, temporal: shot5,
    decode: shot6, upscale: shot7, player: shot8, outro: shot9
  };

  // 每个镜头的氛围参数（同一片空间，只是“镜头”在移动）
  const MOOD = {
    void:     { inkA: 1.0, aurora: .45, warm: .10, grid: false, frags: 0, hud: 1 },
    prompt:   { inkA: 1.0, aurora: .40, warm: .45, grid: true,  frags: .34, hud: 1 },
    token:    { inkA: 1.0, aurora: .38, warm: .22, grid: false, frags: .22, hud: 1 },
    latent:   { inkA: 1.0, aurora: .46, warm: .05, grid: true,  frags: .20, hud: 1 },
    temporal: { inkA: 1.0, aurora: .40, warm: .03, grid: false, frags: .18, hud: 1 },
    decode:   { inkA: 1.0, aurora: .42, warm: .04, grid: true,  frags: .16, hud: 1 },
    upscale:  { inkA: 1.0, aurora: .44, warm: .03, grid: true,  frags: .14, hud: 1 },
    player:   { inkA: 1.0, aurora: .62, warm: .12, grid: false, frags: .12, hud: 1 },
    outro:    { inkA: 1.0, aurora: .58, warm: .20, grid: false, frags: .10, hud: 1 }
  };

  // 切点闪光表：镜头开始时刻的闪光强度
  const CUT_FLASH = { void: 0, prompt: .10, token: .14, latent: .18, temporal: .10, decode: .16, upscale: .10, player: .08, outro: .12 };

  function render(ctx, t) {
    const { shot, lt, idx } = TIMELINE.at(t);
    const mood = MOOD[shot.id] || MOOD.void;

    // 底层空间
    BG.bed(ctx, t, { inkA: mood.inkA });
    BG.aurora(ctx, t, mood.aurora, mood.warm);
    if (mood.grid) BG.floorGrid(ctx, t, { hy: H * .78, alpha: .10, vpx: Math.sin(t * .2 + idx) * 24 });

    // 连续层（上一镜残留）
    continuity(ctx, shot.id, lt, t);

    // 主体
    const outFade = (SHOTS[shot.id] || shot1)(ctx, lt, shot.dur, t) || 0;

    // 全局叠加（黑场收束时一并淡出，让首尾无缝）
    const ga = 1 - clamp(outFade);
    if (ga > .002) {
      ctx.save();
      ctx.globalAlpha = ga;
      BG.scanlines(ctx, t);
      BG.hudFrame(ctx, t, 1);

      // 镜头信息角标（底部中央，极淡）
      ctx.globalAlpha = ga * .30;
      ctx.font = font.mono(12, 500);
      ctx.fillStyle = rgba('#8FB6DE', .9);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      drawTracked(ctx, `SHOT ${String(idx + 1).padStart(2, '0')} / 09   ${shot.name}`,
        W / 2, H - 34, 3, { align: 'center' });
      ctx.restore();
    }

    // 切点闪光
    const cf = (CUT_FLASH[shot.id] || 0) * (1 - ease.out2(span(lt, 0, .22)));
    if (cf > .002) BG.flash(ctx, cf, '#EAF6FF');

    return { shot, lt };
  }

  global.SCENE = { TIMELINE, render, SHOTS, MOOD, PROMPT };
})(window);
