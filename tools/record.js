/* ==========================================================================
   tools/record.js — 在 Node 里真实执行浏览器动画代码，并把所有 Canvas2D
   调用录制成 JSON，交给 tools/rasterize.py 用 Pillow 回放成 PNG。
   用途：在没有浏览器可用时逐帧校验构图与精致度。
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------ 变换矩阵 ------------------------------ */
const I = () => [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/* ------------------------------ 路径 ------------------------------ */
class Path {
  constructor() { this.subs = []; this.cur = null; }
  moveTo(x, y) { this.cur = { pts: [{ x, y }], closed: false }; this.subs.push(this.cur); }
  lineTo(x, y) { if (!this.cur) this.moveTo(x, y); else this.cur.pts.push({ x, y }); }
  close() { if (this.cur) this.cur.closed = true; }
  rect(x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.close(); }
  arcTo(x1, y1, x2, y2, r) {
    // 真正的 arcTo：当前点 → 切点 → 圆弧 → 切点
    const p0 = this.cur && this.cur.pts.length ? this.cur.pts[this.cur.pts.length - 1] : { x: x1, y: y1 };
    const v1 = { x: p0.x - x1, y: p0.y - y1 };
    const v2 = { x: x2 - x1, y: y2 - y1 };
    const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
    if (l1 < 1e-6 || l2 < 1e-6 || r <= 0) { this.lineTo(x1, y1); return; }
    const a1 = Math.atan2(v1.y, v1.x), a2 = Math.atan2(v2.y, v2.x);
    const c = Math.cos(a1) - Math.cos(a2), s = Math.sin(a1) - Math.sin(a2);
    const l = Math.hypot(c, s);
    if (l < 1e-6) { this.lineTo(x1, y1); return; }
    const d = Math.abs(r * Math.tan((a1 - a2) / 2));
    const t1 = { x: x1 + Math.cos(a1) * d, y: y1 + Math.sin(a1) * d };
    const t2 = { x: x1 + Math.cos(a2) * d, y: y1 + Math.sin(a2) * d };
    this.lineTo(t1.x, t1.y);
    let ccw = ((a2 - a1 + Math.PI * 3) % (Math.PI * 2)) - Math.PI < 0;
    this.arc(x1, y1, r / Math.abs(Math.sin((a1 - a2) / 2) || 1), a1, a2, ccw);
    this.lineTo(t2.x, t2.y);
  }
  quadTo(cx, cy, x, y) { this.lineTo(cx, cy); this.lineTo(x, y); }
  bezierTo(c1x, c1y, c2x, c2y, x, y) { this.lineTo(c1x, c1y); this.lineTo(c2x, c2y); this.lineTo(x, y); }
  arc(cx, cy, r, a0, a1, ccw) {
    const n = Math.max(24, Math.ceil(Math.abs(a1 - a0) / 0.12));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * i / n;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i === 0 && !this.cur ? this.moveTo(x, y) : this.lineTo(x, y);
    }
    this.close();
  }
  ellipse(cx, cy, rx, ry, rot, a0, a1, ccw) {
    const n = Math.max(28, Math.ceil(Math.abs(a1 - a0) / 0.1));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * i / n;
      const ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
      const x = cx + ex * Math.cos(rot) - ey * Math.sin(rot);
      const y = cy + ex * Math.sin(rot) + ey * Math.cos(rot);
      i === 0 && !this.cur ? this.moveTo(x, y) : this.lineTo(x, y);
    }
    this.close();
  }
  toJSON() {
    return this.subs.map(s => ({ pts: s.pts.map(p => [round(p.x), round(p.y)]), closed: s.closed }));
  }
}
const round = v => Math.round(v * 100) / 100;

/* ------------------------------ 渐变 / 图案 ------------------------------ */
class Gradient {
  constructor(kind, a) { this.kind = kind; this.a = a; this.stops = []; }
  addColorStop(p, c) { if (p >= 0 && p <= 1) this.stops.push([p, c]); }
  toJSON() { return { kind: this.kind, a: this.a.map(round), stops: this.stops }; }
}
class Pattern {
  constructor(img, rep) { this.img = img; this.rep = rep; this.m = I(); }
  setTransform(m) { if (m) this.m = [m.a, m.b, m.c, m.d, m.e, m.f]; }
  toJSON() { return { img: this.img.__id, m: this.m.map(round) }; }
}
class DOMMatrixShim {
  constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
  translate(x, y) { const m = new DOMMatrixShim(); m.e = x; m.f = y; return this._mul(m); }
  scale(sx, sy) { const m = new DOMMatrixShim(); m.a = sx; m.d = sy == null ? sx : sy; return this._mul(m); }
  _mul(n) {
    const r = new DOMMatrixShim();
    const m = [this.a, this.b, this.c, this.d, this.e, this.f];
    const o = [n.a, n.b, n.c, n.d, n.e, n.f];
    const q = mul(m, o);
    r.a = q[0]; r.b = q[1]; r.c = q[2]; r.d = q[3]; r.e = q[4]; r.f = q[5];
    return r;
  }
}

/* ------------------------------ 画布 ------------------------------ */
let CANVAS_ID = 0;
const REGISTRY = [];      // 所有画布的元信息
const CANVASES_BY_ID = {};
function targetOf(canvas) {
  if (!canvas.__ops) canvas.__ops = [];
  return canvas.__ops;
}

class Ctx {
  constructor(canvas) {
    this.canvas = canvas;
    this.m = I();
    this.stack = [];
    this.path = new Path();
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.font = '10px sans-serif';
    this._textAlign = 'left';
    this._textBaseline = 'alphabetic';
    this.shadowColor = 'rgba(0,0,0,0)';
    this.shadowBlur = 0;
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = 'high';
    this._clip = null;
  }
  get textAlign() { return this._textAlign; }
  set textAlign(v) { this._textAlign = v; this.op({ t: 'align', v }); }
  get textBaseline() { return this._textBaseline; }
  set textBaseline(v) { this._textBaseline = v; this.op({ t: 'baseline', v }); }
  /* 记录一条 op */
  op(o) {
    o.m = this.m.map(round);
    o.a = this.globalAlpha;
    o.c = this.globalCompositeOperation;
    if (this.shadowBlur > 0) {
      o.sb = this.shadowBlur;
      o.sc = this.shadowColor;
    }
    if (o.t === 'text') o.f = this.font;
    targetOf(this.canvas).push(o);
  }
  /* --- 状态 --- */
  save() {
    this.stack.push({
      m: this.m.slice(), fillStyle: this.fillStyle, strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth, globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation, font: this.font,
      textAlign: this.textAlign, textBaseline: this.textBaseline,
      shadowColor: this.shadowColor, shadowBlur: this.shadowBlur, _clip: this._clip
    });
    this.op({ t: 'save' });
  }
  restore() {
    const s = this.stack.pop();
    if (s) Object.assign(this, s);
    this.op({ t: 'restore' });
  }
  /* --- 变换 --- */
  setTransform(a, b, c, d, e, f) { this.m = [a, b, c, d, e, f]; this.op({ t: 'setTransform', m: this.m.map(round) }); }
  transform(a, b, c, d, e, f) { this.m = mul(this.m, [a, b, c, d, e, f]); this.op({ t: 'transform', m: this.m.map(round) }); }
  translate(x, y) { this.m = mul(this.m, [1, 0, 0, 1, x, y]); }
  scale(x, y) { this.m = mul(this.m, [x, 0, 0, y, 0, 0]); }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this.m = mul(this.m, [c, s, -s, c, 0, 0]); }
  /* --- 路径 --- */
  beginPath() { this.path = new Path(); }
  closePath() { this.path.close(); }
  moveTo(x, y) { this.path.moveTo(x, y); }
  lineTo(x, y) { this.path.lineTo(x, y); }
  rect(x, y, w, h) { this.path.rect(x, y, w, h); }
  arcTo(x1, y1, x2, y2, r) { this.path.arcTo(x1, y1, x2, y2, r); }
  quadraticCurveTo(cx, cy, x, y) { this.path.quadTo(cx, cy, x, y); }
  bezierCurveTo(a, b, c, d, e, f) { this.path.bezierTo(a, b, c, d, e, f); }
  arc(x, y, r, a0, a1, ccw) { this.path.arc(x, y, r, a0 == null ? 0 : a0, a1 == null ? 6.2832 : a1, ccw); }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
    this.path.ellipse(x, y, rx, ry, rot || 0, a0 == null ? 0 : a0, a1 == null ? 6.2832 : a1, ccw);
  }
  /* --- 绘制 --- */
  fill() { this.op({ t: 'fill', path: this.path.toJSON(), style: styleOf(this.fillStyle), clip: this._clip }); }
  stroke() { this.op({ t: 'stroke', path: this.path.toJSON(), style: styleOf(this.strokeStyle), lw: this.lineWidth, cap: this.lineCap, clip: this._clip }); }
  fillRect(x, y, w, h) {
    const p = new Path(); p.rect(x, y, w, h);
    this.op({ t: 'fill', path: p.toJSON(), style: styleOf(this.fillStyle), clip: this._clip });
  }
  strokeRect(x, y, w, h) {
    const p = new Path(); p.rect(x, y, w, h);
    this.op({ t: 'stroke', path: p.toJSON(), style: styleOf(this.strokeStyle), lw: this.lineWidth, cap: this.lineCap, clip: this._clip });
  }
  clearRect() { }
  clip() { this._clip = this.path.toJSON(); }
  /* --- 文本 --- */
  measureText(s) {
    const g = glyphsOf(s, this.font).reduce((a, b) => a + b.w, 0);
    return { width: g };
  }
  fillText(s, x, y) { this.op({ t: 'text', s: String(s), x, y, style: styleOf(this.fillStyle), clip: this._clip }); }
  strokeText(s, x, y) { this.op({ t: 'text', s: String(s), x, y, style: styleOf(this.strokeStyle), clip: this._clip, stroke: true }); }
  /* --- 图像 --- */
  drawImage(img, ...a) {
    if (!img.__id) return;
    let sx = 0, sy = 0, sw = img.width, sh = img.height, dx, dy, dw, dh;
    if (a.length === 2) { dx = a[0]; dy = a[1]; dw = img.width; dh = img.height; }
    else if (a.length === 4) { dx = a[0]; dy = a[1]; dw = a[2]; dh = a[3]; }
    else { sx = a[0]; sy = a[1]; sw = a[2]; sh = a[3]; dx = a[4]; dy = a[5]; dw = a[6]; dh = a[7]; }
    this.op({ t: 'img', id: img.__id, sx, sy, sw, sh, dx, dy, dw, dh, clip: this._clip });
  }
  createImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData(img, x, y) {
    this.op({ t: 'pixels', w: img.width, h: img.height, x, y, data: Array.from(img.data) });
  }
  createLinearGradient(x0, y0, x1, y1) { return new Gradient('linear', [x0, y0, x1, y1]); }
  createRadialGradient(x0, y0, r0, x1, y1, r1) { return new Gradient('radial', [x0, y0, r0, x1, y1, r1]); }
  createPattern(img, rep) { return new Pattern(img, rep); }
  setLineDash() { }
  getImageData() { return this.createImageData(1, 1); }
}

function styleOf(s) {
  if (s instanceof Gradient) return { g: s.toJSON() };
  if (s instanceof Pattern) return { p: s.toJSON() };
  return { s: String(s) };
}
function glyphsOf(text, font) {
  const size = parseFontSize(font);
  const out = [];
  for (const ch of Array.from(text)) {
    const code = ch.codePointAt(0);
    const wide = code > 0x2E80;                    // CJK 视为全角
    out.push({ ch, w: round(size * (wide ? 1.0 : 0.56)) });
  }
  return out;
}
function parseFontSize(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font || '');
  return m ? parseFloat(m[1]) : 12;
}

class Canvas {
  constructor(w, h) {
    this.__id = ++CANVAS_ID;
    this._w = w || 300; this._h = h || 150;
    this._ctx = null;
    this.__ops = [];
    this._meta = { id: this.__id, w: this._w, h: this._h, dpr: 1 };
    REGISTRY.push(this._meta);
    CANVASES_BY_ID[this.__id] = this;
  }
  get width() { return this._w; }
  set width(v) { this._w = v | 0; this._meta.w = this._w; }
  get height() { return this._h; }
  set height(v) { this._h = v | 0; this._meta.h = this._h; }
  getContext(kind, opts) { if (!this._ctx) this._ctx = new Ctx(this, opts); return this._ctx; }
  toDataURL() { return 'data:,'; }
}

/* ------------------------------ DOM 壳 ------------------------------ */
function makeEl(id) {
  const el = {
    id, style: {}, textContent: '', dataset: {},
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    addEventListener() { }, removeEventListener() { },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1920, height: 1080 }; },
    appendChild() { }, querySelector() { return makeEl('x'); }
  };
  return el;
}

/* ------------------------------ 运行 ------------------------------ */
function load(file) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInContext(code, CTX, { filename: file });
}

const els = {};
els.screen = new Canvas(1920, 1080);
els['#bar i'] = makeEl('#bar i');
els.bar = makeEl('bar');
const CTX = vm.createContext({});
CTX.window = CTX;
CTX.globalThis = CTX;
CTX.console = console;
CTX.Math = Math;
CTX.performance = { now: () => 0 };
CTX.requestAnimationFrame = () => 0;
CTX.setTimeout = () => 0;
CTX.DOMMatrix = DOMMatrixShim;
CTX.Uint8ClampedArray = Uint8ClampedArray;
CTX.Float32Array = Float32Array;
CTX.URLSearchParams = URLSearchParams;
CTX.location = { search: process.env.DSH_QUERY || '' };
CTX.document = {
  createElement(tag) {
    if (tag === 'canvas') return new Canvas(300, 150);
    return makeEl(tag);
  },
  getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
  querySelector(sel) { return els[sel] || (els[sel] = makeEl(sel)); },
  addEventListener() { }
};
CTX.addEventListener = () => 0;

["js/util.js", "js/film.js", "js/bg.js", "js/shots.js", "js/main.js"].forEach(load);

/* ------------------------------ 出帧 ------------------------------ */
const times = (process.env.DSH_TIMES || '1.6').split(',').map(Number);
const outDir = path.join(ROOT, 'shots');
fs.mkdirSync(outDir, { recursive: true });
const problems = [];

for (const t of times) {
  // 注意：不清空离屏画布的操作流 —— 浏览器里离屏画布的内容会跨帧保留，
  // 只清空主画布，离屏内容按“累积”语义重建。
  els.screen.__ops = [];
  try {
    CTX.__dsh.render(t);
  } catch (e) {
    problems.push(`t=${t} 抛出异常: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
    continue;
  }
  // 收集：主画布 + 本帧被引用过的离屏画布（递归，保证依赖齐全）
  const canvases = [{ id: els.screen.__id, w: els.screen.width, h: els.screen.height, ops: els.screen.__ops }];
  const seen = {};
  const walk = (ops) => {
    for (const o of ops) {
      if (o.t !== 'img' || seen[o.id]) continue;
      seen[o.id] = 1;
      const c = CANVASES_BY_ID[o.id];
      const meta = REGISTRY.find(r => r.id === o.id);
      if (!c || !meta) continue;
      const list = c.__ops || [];
      canvases.push({ id: o.id, w: meta.w, h: meta.h, ops: list });
      walk(list);
    }
  };
  walk(els.screen.__ops);
  // NaN / Infinity 检查（主帧）
  let nan = 0;
  for (const o of els.screen.__ops) {
    if (o.m.some(v => !isFinite(v))) nan++;
    if (o.path) for (const s of o.path) for (const p of s.pts) if (!isFinite(p[0]) || !isFinite(p[1])) nan++;
    if (o.t === 'text' && (!isFinite(o.x) || !isFinite(o.y))) nan++;
    if (o.t === 'img' && [o.dx, o.dy, o.dw, o.dh].some(v => !isFinite(v))) nan++;
  }
  if (nan) problems.push(`t=${t} 存在 ${nan} 条非有限坐标的绘制指令`);
  const name = `f_${String(Math.round(t * 10)).padStart(4, '0')}`;
  fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify({
    t, w: 1920, h: 1080, registry: REGISTRY, canvases
  }));
  const texts = els.screen.__ops.filter(o => o.t === 'text').length;
  process.stdout.write(`t=${t.toFixed(1)}s  ops=${String(els.screen.__ops.length).padStart(5)}  text=${String(texts).padStart(4)}  panels=${canvases.length - 1}  -> ${name}.json\n`);
}

if (problems.length) {
  console.log('\n=== 问题 ===');
  problems.forEach(p => console.log(' - ' + p));
  process.exitCode = 1;
} else {
  console.log('\n全部帧录制成功，无 NaN / 异常。');
}
