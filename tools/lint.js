/* ==========================================================================
   tools/lint.js — 无浏览器排版/几何静态检查
   用 harness 真实执行分镜代码，然后检查指令流里的潜在缺陷：
     1. 文字被 clip 区域裁切（画到框外）
     2. 文字出血到画布安全区外
     3. 不同层级的大块文字互相重叠（可读性）
     4. 非有限坐标 / 超大元素 / 阴影溢出等几何异常
     5. 各分镜的绘制负载（性能预算）
   用法：
     node tools/lint.js                  # 每个分镜取 6 个采样点
     node tools/lint.js --per=10         # 每镜 10 个采样点
     node tools/lint.js --t=24.6,36      # 只检查指定时间点
   ========================================================================== */
'use strict';
const H = require('./harness');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const hit = args.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.split('=')[1] : d;
};
const PER = parseInt(getArg('per', '6'), 10);
const CUSTOM = getArg('t', '');

const W = 1920, H_H = 1080;
const SAFE = 30;              // 安全边距
const FRAME = 40;             // 硬边界（HUD 装饰线在 46，元素不应越过 30）

const findings = [];
const add = (sev, cat, where, msg, extra) =>
  findings.push({ sev, cat, where, msg, extra: extra || '' });

/* ------------------------------ 几何工具 ------------------------------ */
function bboxOfPath(o) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of o.path) for (const p of s.pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}
function bboxOfPts(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}
// 文字盒（按字宽估算），并把局部坐标经变换矩阵映射到世界坐标
function textBox(o) {
  const m = /(\d+(?:\.\d+)?)px/.exec(o.f || '');
  const size = m ? parseFloat(m[1]) : 12;
  const w = H.glyphWidth(o.s, o.f);
  const align = o.align || 'left';
  const base = o.base || 'alphabetic';
  // 局部坐标（相对锚点）
  const X = o.x, Y = o.y;
  let lx0 = X;
  if (align === 'center') lx0 = X - w / 2;
  else if (align === 'right') lx0 = X - w;
  let ly0, ly1;
  if (base === 'middle') { ly0 = Y - size * 0.62; ly1 = Y + size * 0.62; }
  else if (base === 'top') { ly0 = Y; ly1 = Y + size * 1.24; }
  else { ly0 = Y - size * 0.82; ly1 = Y + size * 0.24; }
  // 变换到世界坐标：四角分别变换后取包围盒（可覆盖旋转/倾斜）
  const M = o.m || [1, 0, 0, 1, 0, 0];
  const P = (x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const xs = [], ys = [];
  for (const cx of [lx0, lx0 + w]) {
    for (const cy of [ly0, ly1]) { const p = P(cx, cy); xs.push(p[0]); ys.push(p[1]); }
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const overlapArea = (a, b) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return (w > 0 && h > 0) ? w * h : 0;
};
const area = b => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
// 一个盒是否基本落在 clip 区域里
function insideRatio(box, clipPolys) {
  if (!clipPolys || !clipPolys.length) return 1;
  const clip = bboxOfPts(clipPolys.flatMap(s => s.pts));
  const inter = overlapArea(box, clip) / Math.max(1, area(box));
  return inter;
}

/* ------------------------------ 启动 ------------------------------ */
const app = H.boot();
const DUR = app.CTX.__dsh.duration;
const SHOTS = app.CTX.SCENE.TIMELINE.shots;

console.log('总时长 %ss，%d 个分镜', DUR.toFixed(1), SHOTS.length);

/* ------------------------------ 采样时间点 ------------------------------ */
let times = [];
if (CUSTOM) {
  times = CUSTOM.split(',').map(Number);
} else {
  for (const s of SHOTS) {
    // 避开切点前后 0.15s 的转场瞬间，取镜内均匀采样
    const a = s.start + 0.15, b = s.end - 0.15;
    for (let i = 0; i < PER; i++) times.push(a + (b - a) * (i / (PER - 1)));
  }
}
times.sort((x, y) => x - y);

/* ------------------------------ 逐帧检查 ------------------------------ */
const load = {};      // 分镜 -> {ops, frames}
let totalOps = 0, totalFrames = 0;

for (const t of times) {
  let ops;
  try {
    ops = H.renderAt(app, t);
  } catch (e) {
    add('严重', '运行异常', `t=${t.toFixed(1)}s`, String(e && e.message || e));
    continue;
  }
  const shot = SHOTS.find(s => t >= s.start && t < s.end) || SHOTS[SHOTS.length - 1];
  const where = `t=${t.toFixed(1)}s · ${shot.name}`;
  load[shot.name] = load[shot.name] || { ops: 0, frames: 0 };
  load[shot.name].ops += ops.length;
  load[shot.name].frames++;

  let shadowArea = 0, bigElements = 0;
  const texts = [];

  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    // 1) 变换与坐标必须有限
    if (o.m.some(v => !Number.isFinite(v))) {
      add('严重', '非有限变换', where, `第 ${i} 条 ${o.t} 的变换矩阵含 NaN/Inf`);
    }
    if (o.t === 'text') {
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) {
        add('严重', '非有限坐标', where, `文本“${o.s}”坐标非有限`);
        continue;
      }
      const box = textBox(o);
      texts.push({ o, box, i });
      // 刻意贴边/越界的装饰文字（低透明度层）不做安全区判定
      const decorative = !!o.bleed;
      // 2) 被 clip 裁切
      if (o.clip) {
        const r = insideRatio(box, o.clip);
        if (r < 0.985) {
          add(decorative ? '低' : '高', '文字被裁切', where,
            `“${clip(o.s, 18)}” 有 ${((1 - r) * 100).toFixed(0)}% 落在裁剪区外（box=${box.map(Math.round)}）`);
        }
      }
      // 3) 出血到安全区外
      if (!decorative && (box[0] < SAFE || box[2] > W - SAFE)) {
        const sev = (box[0] < 0 || box[2] > W) ? '高' : '中';
        add(sev, '文字出血', where,
          `“${clip(o.s, 18)}” x 范围 ${box[0].toFixed(0)}…${box[2].toFixed(0)}（安全区 ${SAFE}…${W - SAFE}）`);
      }
      if (!decorative && (box[1] < SAFE || box[3] > H_H - SAFE)) {
        add('中', '文字出血(纵)', where, `“${clip(o.s, 18)}” y 范围 ${box[1].toFixed(0)}…${box[3].toFixed(0)}`);
      }
    } else if (o.t === 'fill' || o.t === 'stroke') {
      const b = bboxOfPath(o);
      if (b.some(v => !Number.isFinite(v))) {
        add('严重', '非有限路径', where, `第 ${i} 条 ${o.t} 含非有限坐标`);
        continue;
      }
      const w = b[2] - b[0], h = b[3] - b[1];
      // 只对“实心填充”判定溢出；描边的包围盒会被椭圆/曲线的控制点放大，属于误报。
      // 满幅出血是设计手法（极光、地面网格、镜头环），阈值放到 2.5 倍。
      if (o.t === 'fill' && (w > W * 2.5 || h > H_H * 2.5)) {
        bigElements++;
        add('低', '超大元素', where, `${o.t} 覆盖 ${w.toFixed(0)}×${h.toFixed(0)}，超出画布 2.5 倍`);
      }
      if (o.sb && w * h > 300000) shadowArea += w * h;
    } else if (o.t === 'img') {
      if ([o.dx, o.dy, o.dw, o.dh].some(v => !Number.isFinite(v))) {
        add('严重', '非有限图像', where, `第 ${i} 条 drawImage 目标矩形非有限`);
      }
    }
  }

  // 4) 大块文字互相重叠（忽略小字号 HUD 与碎片）
  const big = texts.filter(x => {
    const m = /(\d+(?:\.\d+)?)px/.exec(x.o.f || '');
    return m && parseFloat(m[1]) >= 17;
  });
  for (let a = 0; a < big.length; a++) {
    for (let b = a + 1; b < big.length; b++) {
      const ov = overlapArea(big[a].box, big[b].box);
      if (ov <= 1) continue;
      const ratio = ov / Math.max(1, Math.min(area(big[a].box), area(big[b].box)));
      if (ratio > 0.18) {
        add('中', '文字重叠', where,
          `“${clip(big[a].o.s, 12)}” × “${clip(big[b].o.s, 12)}” 重叠 ${(ratio * 100).toFixed(0)}%`);
      }
    }
  }
  // 5) 阴影开销
  if (shadowArea > 1.2e6) {
    add('低', '阴影开销', where, `大面积阴影模糊累计 ${(shadowArea / 1e6).toFixed(1)}M px²`);
  }
  void bigElements;
}

function clip(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

/* ------------------------------ 汇总 ------------------------------ */
totalOps = Object.values(load).reduce((a, b) => a + b.ops, 0);
totalFrames = Object.values(load).reduce((a, b) => a + b.frames, 0);

console.log('\n=== 各分镜绘制负载（每帧平均指令数）===');
const rows = Object.entries(load).map(([k, v]) => [k, Math.round(v.ops / v.frames)]);
rows.sort((a, b) => b[1] - a[1]);
for (const [k, v] of rows) console.log('  %s %s', String(v).padStart(6), k);
console.log('  总平均 %s / 帧，采样 %d 帧', Math.round(totalOps / totalFrames), totalFrames);

const order = { '严重': 0, '高': 1, '中': 2, '低': 3 };
findings.sort((a, b) => (order[a.sev] - order[b.sev]) || a.cat.localeCompare(b.cat));

console.log('\n=== 检查结果 ===');
if (!findings.length) {
  console.log('  未发现排版 / 几何缺陷 ✓');
} else {
  const byCat = {};
  for (const f of findings) {
    byCat[f.cat] = byCat[f.cat] || [];
    byCat[f.cat].push(f);
  }
  for (const [cat, list] of Object.entries(byCat)) {
    console.log('\n[%s] %s  (%d 处)', list[0].sev, cat, list.length);
    const shown = list.slice(0, 8);
    for (const f of shown) console.log('   - %s: %s', f.where, f.msg);
    if (list.length > shown.length) console.log('   … 另有 %d 处同类', list.length - shown.length);
  }
}

const counts = findings.reduce((a, f) => (a[f.sev] = (a[f.sev] || 0) + 1, a), {});
console.log('\n=== 统计 ===');
console.log('  严重 %d / 高 %d / 中 %d / 低 %d',
  counts['严重'] || 0, counts['高'] || 0, counts['中'] || 0, counts['低'] || 0);
process.exitCode = (counts['严重'] || counts['高']) ? 1 : 0;
