/* ==========================================================================
   tools/harness.js — 校验用运行壳（供 record.js / lint.js 共用）
   在 Node 里提供一套 Canvas2D + DOM 的最小实现，用来真实执行分镜代码
   并把绘制指令录下来；同时暴露坐标变换与几何信息，便于静态检查。
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
const round = v => Math.round(v * 100) / 100;

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
    const d = Math.abs(r * Math.tan((a1 - a2) / 2));
    const t1 = { x: x1 + Math.cos(a1) * d, y: y1 + Math.sin(a1) * d };
    const t2 = { x: x1 + Math.cos(a2) * d, y: y1 + Math.sin(a2) * d };
    this.lineTo(t1.x, t1.y);
    const ccw = ((a2 - a1 + Math.PI * 3) % (Math.PI * 2)) - Math.PI < 0;
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

/* ------------------------------ 渐变 / 图案 ------------------------------ */
class Gradient {
  constructor(kind, a) { this.kind = kind; this.a = a; this.stops = []; }
  addColorStop(p, c) { if (p >= 0 && p <= 1) this.stops.push([p, c]); }
  toJSON() { return { kind: this.kind, a: this.a.map(round), stops: this.stops }; }
}
class Pattern {
  constructor(img, rep) { this.img = img; this.rep = rep; this.m = I(); }
  setTransform(m) {
    if (!m) return;
    if (typeof m.a === 'number') this.m = [m.a, m.b, m.c, m.d, m.e, m.f];
    else if (m.length === 6) this.m = m.slice();
  }
  toJSON() { return { img: this.img && this.img.__id, m: this.m.map(round) }; }
}
class DOMMatrixShim {
  constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
  translate(x, y) { const m = new DOMMatrixShim(); m.e = x; m.f = y; return this._mul(m); }
  scale(sx, sy) { const m = new DOMMatrixShim(); m.a = sx; m.d = sy == null ? sx : sy; return this._mul(m); }
  _mul(n) {
    const r = new DOMMatrixShim();
    const q = mul([this.a, this.b, this.c, this.d, this.e, this.f], [n.a, n.b, n.c, n.d, n.e, n.f]);
    r.a = q[0]; r.b = q[1]; r.c = q[2]; r.d = q[3]; r.e = q[4]; r.f = q[5];
    return r;
  }
}

/* ------------------------------ 画布 ------------------------------ */
let CANVAS_ID = 0;
const REGISTRY = [];
const CANVASES_BY_ID = {};
const OPTS = { filter: true, domMatrix: true };   // 可关闭，用于覆盖降级分支

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
    this._filter = 'none';
  }
  get filter() { return OPTS.filter ? this._filter : 'none'; }
  set filter(v) { this._filter = OPTS.filter ? v : 'none'; }
  get textAlign() { return this._textAlign; }
  set textAlign(v) { this._textAlign = v; this.op({ t: 'align', v }); }
  get textBaseline() { return this._textBaseline; }
  set textBaseline(v) { this._textBaseline = v; this.op({ t: 'baseline', v }); }

  op(o) {
    o.m = this.m.map(round);
    o.a = this.globalAlpha;
    o.c = this.globalCompositeOperation;
    if (this.shadowBlur > 0) { o.sb = this.shadowBlur; o.sc = this.shadowColor; }
    if (o.t === 'text') o.f = this.font;
    if (!this.canvas.__ops) this.canvas.__ops = [];
    this.canvas.__ops.push(o);
  }
  save() {
    this.stack.push({
      m: this.m.slice(), fillStyle: this.fillStyle, strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth, globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation, font: this.font,
      textAlign: this._textAlign, textBaseline: this._textBaseline,
      shadowColor: this.shadowColor, shadowBlur: this.shadowBlur,
      filter: this._filter, _clip: this._clip
    });
    this.op({ t: 'save' });
  }
  restore() {
    const s = this.stack.pop();
    if (s) {
      this.m = s.m; this.fillStyle = s.fillStyle; this.strokeStyle = s.strokeStyle;
      this.lineWidth = s.lineWidth; this.globalAlpha = s.globalAlpha;
      this.globalCompositeOperation = s.globalCompositeOperation; this.font = s.font;
      this._textAlign = s.textAlign; this._textBaseline = s.textBaseline;
      this.shadowColor = s.shadowColor; this.shadowBlur = s.shadowBlur;
      this._filter = s.filter; this._clip = s._clip;
    }
    this.op({ t: 'restore' });
  }
  setTransform(a, b, c, d, e, f) { this.m = [a, b, c, d, e, f]; this.op({ t: 'setTransform', m: this.m.map(round) }); }
  transform(a, b, c, d, e, f) { this.m = mul(this.m, [a, b, c, d, e, f]); }
  translate(x, y) { this.m = mul(this.m, [1, 0, 0, 1, x, y]); }
  scale(x, y) { this.m = mul(this.m, [x, 0, 0, y, 0, 0]); }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this.m = mul(this.m, [c, s, -s, c, 0, 0]); }
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
  measureText(s) { return { width: glyphWidth(s, this.font) }; }
  fillText(s, x, y) {
    const o = { t: 'text', s: String(s), x, y, align: this._textAlign, base: this._textBaseline, style: styleOf(this.fillStyle), clip: this._clip };
    if (this.globalAlpha < 0.42) o.bleed = 1;   // 淡入淡出/极淡的文字允许贴边或越界
    this.op(o);
  }
  strokeText(s, x, y) { this.op({ t: 'text', s: String(s), x, y, align: this._textAlign, base: this._textBaseline, style: styleOf(this.strokeStyle), clip: this._clip, stroke: true }); }
  drawImage(img, ...a) {
    if (!img || !img.__id) return;
    let sx = 0, sy = 0, sw = img.width, sh = img.height, dx, dy, dw, dh;
    if (a.length === 2) { dx = a[0]; dy = a[1]; dw = img.width; dh = img.height; }
    else if (a.length === 4) { dx = a[0]; dy = a[1]; dw = a[2]; dh = a[3]; }
    else { sx = a[0]; sy = a[1]; sw = a[2]; sh = a[3]; dx = a[4]; dy = a[5]; dw = a[6]; dh = a[7]; }
    this.op({ t: 'img', id: img.__id, sx, sy, sw, sh, dx, dy, dw, dh, clip: this._clip, filter: this.filter });
  }
  createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData(img, x, y) { this.op({ t: 'pixels', w: img.width, h: img.height, x, y, data: Array.from(img.data) }); }
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
// 与浏览器近似的字宽估算：CJK 全角，其余按 0.56em
function glyphWidth(text, font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font || '');
  const size = m ? parseFloat(m[1]) : 12;
  let w = 0;
  for (const ch of Array.from(String(text))) w += size * (ch.codePointAt(0) > 0x2E80 ? 1.0 : 0.56);
  return round(w);
}

class Canvas {
  constructor(w, h) {
    this.__id = ++CANVAS_ID;
    this._w = w || 300; this._h = h || 150;
    this._ctx = null;
    this.__ops = [];
    this._meta = { id: this.__id, w: this._w, h: this._h };
    REGISTRY.push(this._meta);
    CANVASES_BY_ID[this.__id] = this;
  }
  get width() { return this._w; }
  set width(v) { this._w = v | 0; this._meta.w = this._w; }
  get height() { return this._h; }
  set height(v) { this._h = v | 0; this._meta.h = this._h; }
  getContext() { if (!this._ctx) this._ctx = new Ctx(this); return this._ctx; }
  toDataURL() { return 'data:,'; }
}

/* ------------------------------ DOM 壳 ------------------------------ */
function makeEl(id) {
  return {
    id, style: {}, textContent: '', dataset: {}, width: 1920, height: 1080,
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    addEventListener() { }, removeEventListener() { },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1920, height: 1080 }; },
    appendChild() { }, querySelector() { return makeEl('x'); }
  };
}

/* ------------------------------ 启动 ------------------------------ */
function boot(opts = {}) {
  OPTS.filter = opts.filter !== false;
  OPTS.domMatrix = opts.domMatrix !== false;
  CANVAS_ID = 0;
  REGISTRY.length = 0;
  for (const k in CANVASES_BY_ID) delete CANVASES_BY_ID[k];

  const els = {};
  els.screen = new Canvas(1920, 1080);
  els.bar = makeEl('bar');
  els['#bar i'] = makeEl('#bar i');

  const CTX = vm.createContext({});
  CTX.window = CTX;
  CTX.globalThis = CTX;
  CTX.console = console;
  CTX.Math = Math;
  CTX.performance = { now: () => 0 };
  CTX.requestAnimationFrame = () => 0;
  CTX.setTimeout = () => 0;
  if (OPTS.domMatrix) CTX.DOMMatrix = DOMMatrixShim;
  CTX.Uint8ClampedArray = Uint8ClampedArray;
  CTX.Float32Array = Float32Array;
  CTX.URLSearchParams = URLSearchParams;
  CTX.location = { search: process.env.DSH_QUERY || '' };
  CTX.document = {
    createElement(tag) { return tag === 'canvas' ? new Canvas(300, 150) : makeEl(tag); },
    getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
    querySelector(sel) { return els[sel] || (els[sel] = makeEl(sel)); },
    addEventListener() { }
  };
  CTX.addEventListener = () => 0;

  for (const f of ['js/util.js', 'js/film.js', 'js/bg.js', 'js/shots.js', 'js/main.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), CTX, { filename: f });
  }
  return { CTX, els, screen: els.screen, REGISTRY, CANVASES_BY_ID, OPTS };
}

/* 渲染某一帧，返回主画布指令流 */
function renderAt(app, t) {
  app.screen.__ops = [];
  app.CTX.__dsh.render(t);
  return app.screen.__ops;
}

/* 收集本帧用到的所有画布（含依赖），顺序：主画布在前 */
function collectCanvases(app, mainOps) {
  const out = [{ id: app.screen.__id, w: app.screen.width, h: app.screen.height, ops: mainOps }];
  const seen = {};
  const walk = ops => {
    for (const o of ops) {
      if (o.t !== 'img' || seen[o.id]) continue;
      seen[o.id] = 1;
      const c = app.CANVASES_BY_ID[o.id];
      const meta = app.REGISTRY.find(r => r.id === o.id);
      if (!c || !meta) continue;
      const list = c.__ops || [];
      out.push({ id: o.id, w: meta.w, h: meta.h, ops: list });
      walk(list);
    }
  };
  walk(mainOps);
  return out;
}

module.exports = { ROOT, boot, renderAt, collectCanvases, glyphWidth, mul, REGISTRY };
