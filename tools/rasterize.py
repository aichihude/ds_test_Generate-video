#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/rasterize.py — 回放 record.js 录制的 Canvas2D 指令流，用 Pillow 光栅化成 PNG。
支持：仿射变换、矩形/多边形填充与描边、线性/径向渐变、逐字文本、图像绘制、
像素块、裁剪、阴影模糊、globalAlpha 与 lighter/screen/multiply/overlay 混合。
用途：在无浏览器环境下逐帧校验构图、配色与排版。
"""
import sys, os, json, math, glob
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------- 字体
FONT_CACHE = {}
CN_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\Deng.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]
MONO_CANDIDATES = [
    r"C:\Windows\Fonts\consola.ttf", r"C:\Windows\Fonts\consolab.ttf",
    r"C:\Windows\Fonts\CascadiaMono.ttf", r"C:\Windows\Fonts\lucon.ttf",
]

def pick(cands):
    for c in cands:
        if os.path.exists(c):
            return c
    return None

CN_PATH = pick(CN_CANDIDATES)
MONO_PATH = pick(MONO_CANDIDATES)

def get_font(spec, size):
    """spec 为 canvas font 字符串"""
    size = max(6, int(round(size)))
    is_mono = ("mono" in spec.lower() or "consol" in spec.lower()
               or "cascadia" in spec.lower() or "courier" in spec.lower())
    bold = any(k in spec for k in ("600", "700", "800", "900", "bold"))
    key = (is_mono, bold, size)
    if key in FONT_CACHE:
        return FONT_CACHE[key]
    path = MONO_PATH if is_mono else CN_PATH
    if is_mono and bold:
        p2 = pick([r"C:\Windows\Fonts\consolab.ttf", r"C:\Windows\Fonts\CascadiaMono.ttf"])
        path = p2 or path
    try:
        f = ImageFont.truetype(path, size)
    except Exception:
        f = ImageFont.load_default()
    FONT_CACHE[key] = f
    return f

# ---------------------------------------------------------------- 颜色
def parse_color(s):
    if s is None:
        return (0, 0, 0, 0)
    s = str(s).strip()
    if s.startswith('#'):
        h = s[1:]
        if len(h) == 3:
            h = ''.join(c * 2 for c in h)
        if len(h) == 6:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
        if len(h) == 8:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16))
        return (0, 0, 0, 255)
    if s.startswith('rgba') or s.startswith('rgb'):
        nums = s[s.index('(') + 1:s.rindex(')')].replace('/', ',').split(',')
        v = []
        for i, n in enumerate(nums):
            n = n.strip()
            if n.endswith('%'):
                v.append(float(n[:-1]) / 100.0 * 255)
            else:
                v.append(float(n))
        while len(v) < 4:
            v.append(255)
        a = v[3]
        # 第 4 个分量是 0..1 的小数 → 换算到 0..255
        if len(nums) > 3 and ('.' in nums[3]):
            a = v[3] * 255.0
        return (int(v[0]), int(v[1]), int(v[2]), int(max(0, min(255, a))))
    named = {'black': (0, 0, 0, 255), 'white': (255, 255, 255, 255),
             'red': (255, 0, 0, 255), 'transparent': (0, 0, 0, 0)}
    return named.get(s.lower(), (255, 0, 255, 255))

def stops_to_array(stops, n=256):
    """把色标转成 (n,4) uint8 查找表（RGB 与 alpha 分别插值）"""
    if not stops:
        return np.zeros((n, 4), np.uint8)
    st = sorted([(float(p), parse_color(c)) for p, c in stops], key=lambda z: z[0])
    if st[0][0] > 0:
        st.insert(0, (0.0, st[0][1]))
    if st[-1][0] < 1:
        st.append((1.0, st[-1][1]))
    arr = np.zeros((n, 4), np.float32)
    xs = np.linspace(0, 1, n)
    ps = np.array([s[0] for s in st], np.float32)
    cs = np.array([s[1] for s in st], np.float32)
    if len(ps) == 1:
        arr[:, :] = cs[0]
        return arr.astype(np.uint8)
    for ch in range(4):
        arr[:, ch] = np.interp(xs, ps, cs[:, ch])
    return arr.astype(np.uint8)

# ---------------------------------------------------------------- 画布
class Raster:
    def __init__(self, w, h, scale=0.6, bg=(5, 8, 15)):
        self.W, self.H = w, h
        self.scale = scale
        self.img = Image.new('RGBA', (w, h), bg + (255,))
        self.clipmask = Image.new('L', (w, h), 255)
        self.font_spec = "12px sans-serif"
        self.text_align = 'left'
        self.text_baseline = 'alphabetic'
        self.shadow_color = (0, 0, 0, 0)
        self.shadow_blur = 0
        self.stack = []
        self._lut_cache = {}

    # --- 变换：把设计坐标映射到画布像素 ---
    def view(self, m):
        s = self.scale
        return (m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s, m[5] * s)

    def tp(self, v):
        return (v[0] * self.scale, v[1] * self.scale)

    def apply(self, m):
        s = self.scale
        return (m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s, m[5] * s)

    def mul(self, a, b):
        return (a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
                a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
                a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5])

    def pt(self, m, x, y):
        return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])

    # --- 绘制辅助 ---
    def _mask(self, polys, m):
        mk = Image.new('L', (self.W, self.H), 0)
        d = ImageDraw.Draw(mk)
        for pts, closed in polys:
            if len(pts) < 2:
                continue
            mp = [self.pt(m, p[0], p[1]) for p in pts]
            if closed and len(mp) >= 3:
                # 闭合子路径（圆角矩形等）→ 填充
                d.polygon(mp, fill=255)
            else:
                # 开放子路径（线、折线）→ 逐段描边；PIL 的 line(多点是) 会填凸包，必须拆开
                for i in range(len(mp) - 1):
                    d.line([mp[i], mp[i + 1]], fill=255, width=1)
                if closed and len(mp) == 2:
                    d.line([mp[-1], mp[0]], fill=255, width=1)
        return mk

    def _layer_bbox(self, mask):
        bb = mask.getbbox()
        if not bb:
            return None
        x0, y0, x1, y1 = bb
        return (max(0, x0 - 2), max(0, y0 - 2), min(self.W, x1 + 2), min(self.H, y1 + 2))

    def composite(self, img, mask, alpha, mode, clip=None, origin=None):
        """mask 始终是全画布尺寸；img 可以是同尺寸图层，也可以是一块 bbox 大小的色块
        （此时 origin 给出它的落点）。"""
        if alpha <= 0.002:
            return
        if mask.size != (self.W, self.H):
            full = Image.new('L', (self.W, self.H), 0)
            full.paste(mask, origin or (0, 0))
            mask = full
        if clip is not None:
            m = np.asarray(mask, np.uint16)
            c = np.asarray(clip, np.uint16)
            mask = Image.fromarray((m * c // 255).astype(np.uint8), 'L')
        if alpha < 0.999:
            mask = mask.point(lambda v: int(v * alpha))
        bb = mask.getbbox()
        if not bb:
            return
        x0, y0, x1, y1 = bb
        # 阴影
        if self.shadow_blur > 0 and self.shadow_color[3] > 0:
            r = max(1, int(self.shadow_blur * self.scale))
            sh = mask.filter(ImageFilter.GaussianBlur(r))
            sh_bb = sh.getbbox()
            if sh_bb:
                if os.environ.get('DSH_DEBUG'):
                    print('[shadow] blur=%s color=%s bb=%s layer=%s mask_max=%s' % (
                        r, self.shadow_color, sh_bb, img.size, int(np.asarray(sh).max())))
                self.img.paste(self._apply_alpha(Image.new('RGBA', (sh_bb[2] - sh_bb[0], sh_bb[3] - sh_bb[1]),
                                                           self.shadow_color),
                                                 sh.crop(sh_bb), mode, (sh_bb[0], sh_bb[1])),
                               (sh_bb[0], sh_bb[1]))
        if img.size == (self.W, self.H):
            part = img.crop(bb)
        else:
            ox, oy = origin or (0, 0)
            part = img.crop((x0 - ox, y0 - oy, x1 - ox, y1 - oy))
        piece = self._apply_alpha(part, mask.crop(bb), mode, (x0, y0))
        if os.environ.get('DSH_DEBUG'):
            print('[cmp] layer=%s mask=%s bb=%s -> piece=%s px=%s' % (
                img.size, mask.size, bb, piece.size,
                piece.getpixel((min(2, piece.size[0] - 1), min(2, piece.size[1] - 1)))))
        self.img.paste(piece, (x0, y0))

    def _apply_alpha(self, layer, mask, mode='source-over', origin=(0, 0)):
        x0, y0 = origin
        base = np.asarray(self.img.crop((x0, y0, x0 + layer.size[0], y0 + layer.size[1])), np.float32)
        fore = np.asarray(layer.convert('RGBA'), np.float32)
        a = (np.asarray(mask, np.float32) / 255.0)[:, :, None]
        fore = fore * a
        if mode in ('lighter', 'screen', 'overlay', 'multiply'):
            top = fore[:, :, :3]
            bot = base[:, :, :3]
            if mode == 'lighter':
                out = bot + top
            elif mode == 'screen':
                out = 255.0 - (255.0 - bot) * (255.0 - top) / 255.0
            elif mode == 'multiply':
                out = bot * top / 255.0
            else:
                out = np.where(bot < 128, 2 * bot * top / 255.0, 255.0 - 2 * (255.0 - bot) * (255.0 - top) / 255.0)
            w = a
            rgb = bot * (1 - w) + out * w
            al = np.maximum(base[:, :, 3:4], fore[:, :, 3:4])
            res = np.concatenate([rgb, al], axis=2)
        else:
            fa = fore[:, :, 3:4] / 255.0
            ba = base[:, :, 3:4] / 255.0
            oa = fa + ba * (1 - fa)
            safe = np.maximum(oa, 1e-6)
            rgb = (fore[:, :, :3] * fa + base[:, :, :3] * ba * (1 - fa)) / safe
            res = np.concatenate([rgb, oa * 255.0], axis=2)
        return Image.fromarray(np.clip(res, 0, 255).astype(np.uint8), 'RGBA')

    def _grad_image(self, g, m, bb):
        x0, y0, x1, y1 = bb
        w, h = x1 - x0, y1 - y0
        kind = g['kind']
        a = g['a']
        lut = self._lut(g['stops'])
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        if kind == 'linear':
            p0 = self.pt(m, a[0], a[1])
            p1 = self.pt(m, a[2], a[3])
            dx, dy = p1[0] - p0[0], p1[1] - p0[1]
            L2 = dx * dx + dy * dy
            if L2 < 1e-6:
                t = np.zeros((h, w), np.float32)
            else:
                t = ((xx - p0[0]) * dx + (yy - p0[1]) * dy) / L2
        else:
            c1 = self.pt(m, a[3], a[4])
            r0 = a[2] * self.scale
            r1 = a[5] * self.scale
            dist = np.sqrt((xx - c1[0]) ** 2 + (yy - c1[1]) ** 2)
            t = (dist - r0) / max(1e-6, (r1 - r0))
        idx = np.clip((np.clip(t, 0, 1) * 255).astype(np.int32), 0, 255)
        return Image.fromarray(lut[idx], 'RGBA')

    def _lut(self, stops):
        key = json.dumps(stops, sort_keys=True)
        if key in self._lut_cache:
            return self._lut_cache[key]
        v = stops_to_array(stops)
        self._lut_cache[key] = v
        return v

    # --- 主回放 ---
    def run(self, ops, registry, images=None):
        self.images = images if images is not None else {}
        self.font_spec = "12px sans-serif"
        self.text_align = 'left'
        self.text_baseline = 'alphabetic'
        self.stack = []
        for o in ops:
            t = o['t']
            if t == 'save':
                self.stack.append((self.clipmask, self.font_spec, self.text_align,
                                   self.text_baseline, self.shadow_color, self.shadow_blur))
                continue
            if t == 'restore':
                if self.stack:
                    (self.clipmask, self.font_spec, self.text_align,
                     self.text_baseline, self.shadow_color, self.shadow_blur) = self.stack.pop()
                continue
            if t == 'setTransform':
                continue
            if t in ('align', 'baseline'):
                if t == 'align':
                    self.text_align = o['v']
                else:
                    self.text_baseline = o['v']
                continue
            if t == 'font':
                self.font_spec = o['v']; continue
            m = self.apply(tuple(o['m']))
            alpha = o.get('a', 1.0)
            mode = o.get('c', 'source-over')
            clip = self.clipmask if o.get('clip') else None
            self.shadow_blur = o.get('sb', 0)
            self.shadow_color = parse_color(o.get('sc', 'rgba(0,0,0,0)'))

            if t == 'fill' or t == 'stroke':
                polys = [(s['pts'], s['closed']) for s in o['path']]
                if not polys:
                    continue
                mk = self._mask(polys, m)
                if t == 'stroke':
                    lw = max(0.6, o.get('lw', 1) * self.scale)
                    mk = mk.filter(ImageFilter.MaxFilter(3)) if lw > 1.6 else mk
                    mk = mk.point(lambda v: int(v * 0.85))
                st = o['style']
                bb = mk.getbbox()
                if not bb:
                    continue
                if 'g' in st:
                    layer = self._grad_image(st['g'], m, bb)
                elif 'p' in st:
                    layer = self.tile_pattern(st['p'], registry, self.images, m)
                    if layer is None:
                        continue
                else:
                    layer = Image.new('RGBA', (bb[2] - bb[0], bb[3] - bb[1]), parse_color(st['s']))
                self.composite(layer, mk, alpha, mode, clip, bb[:2])
                continue
            if t == 'text':
                self.draw_text(o, m, alpha, mode, clip)
                continue
            if t == 'img':
                src = self.images.get(o['id'])
                if src is None:
                    continue
                p0 = self.pt(m, o['dx'], o['dy'])
                p1 = self.pt(m, o['dx'] + o['dw'], o['dy'] + o['dh'])
                x0, y0 = int(math.floor(p0[0])), int(math.floor(p0[1]))
                x1, y1 = int(math.ceil(p1[0])), int(math.ceil(p1[1]))
                dw, dh = max(1, x1 - x0), max(1, y1 - y0)
                tile = src.resize((dw, dh), Image.BILINEAR)
                layer = Image.new('RGBA', (self.W, self.H), (0, 0, 0, 0))
                layer.paste(tile, (x0, y0))
                mk = Image.new('L', (self.W, self.H), 0)
                mk.paste(255, (x0, y0, x0 + dw, y0 + dh))
                self.composite(layer, mk, alpha, mode, clip)
                continue
            if t == 'pixels':
                w, h = o['w'], o['h']
                arr = np.array(o['data'], np.uint8).reshape(h, w, 4)
                src = Image.fromarray(arr, 'RGBA')
                self.images.setdefault('pix_%d_%d' % (w, h), src)
                continue
        return self.img

    def tile_pattern(self, p, reg, images, m):
        src = images.get(p['img'])
        if src is None:
            return None
        pm = tuple(p['m'])
        # 每个 tile 由图案矩阵定位：把 tile 的 (0,0)-(w,h) 映射过去
        full = self.mul(m, pm)
        p0 = self.pt(full, 0, 0)
        p1 = self.pt(full, src.width, src.height)
        tw = max(1, int(round(p1[0] - p0[0]))); th = max(1, int(round(p1[1] - p0[1])))
        tile = src.resize((tw, th), Image.NEAREST)
        layer = Image.new('RGBA', (self.W, self.H), (0, 0, 0, 0))
        ox = int(math.floor(p0[0])) % tw
        oy = int(math.floor(p0[1])) % th
        for x in range(ox - tw, self.W + tw, tw):
            for y in range(oy - th, self.H + th, th):
                layer.paste(tile, (x, y))
        return layer

    def draw_text(self, o, m, alpha, mode, clip):
        spec = o.get('f') or self.font_spec
        size = 12
        for tok in spec.split():
            if tok.endswith('px'):
                try:
                    size = float(tok[:-2])
                except Exception:
                    pass
        f = get_font(spec, size * self.scale)
        s = o['s']
        if not s:
            return
        # 计算尺寸（用于对齐）
        try:
            l, tp_, r, bt = f.getbbox(s, anchor='ls')
            w = r - l
        except Exception:
            w = len(s) * size * self.scale * .55
        p = self.pt(m, o['x'], o['y'])
        align = self.text_align
        base = self.text_baseline
        if align == 'center':
            anchor = 'ms'
        elif align == 'right':
            anchor = 'rs'
        else:
            anchor = 'ls'
        if base == 'middle':
            anchor = anchor[0] + 'm'
        elif base == 'top':
            anchor = anchor[0] + 'a'
        layer = Image.new('RGBA', (self.W, self.H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        st = o['style']
        col = parse_color(st['s']) if 's' in st else (255, 255, 255, 255)
        d.text(p, s, font=f, fill=col, anchor=anchor)
        mk = layer.split()[3]
        if 'g' in st:
            bb = mk.getbbox()
            if not bb:
                return
            layer = self._grad_image(st['g'], m, bb)
            self.composite(layer, mk, alpha, mode, clip, bb[:2])
            return
        self.composite(layer, mk, alpha, mode, clip)


def render_frame(data, scale, overlay=True):
    """先渲染所有离屏画布（依赖优先，原生分辨率），再合成到主画布（按 scale 光栅化）。"""
    images = {}
    # canvases[0] 是主画布；其余按依赖收集顺序的逆序渲染（被依赖者先画）
    offs = [c for c in data['canvases'] if c['id'] != 1]
    for c in reversed(offs):
        r = Raster(int(c['w']), int(c['h']), scale=1.0, bg=(0, 0, 0))
        images[c['id']] = r.run(c['ops'], data['registry'], images)
    main = next(c for c in data['canvases'] if c['id'] == 1)
    W = int(data['w'] * scale); H = int(data['h'] * scale)
    r = Raster(W, H, scale=scale, bg=(5, 8, 15))
    img = r.run(main['ops'], data['registry'], images)
    return img, r


def apply_overlay(img, r, grain=0.05, vignette=0.42):
    """近似 DOM 层的胶片颗粒与暗角（overlay 混合的对称噪声）"""
    if grain > 0:
        w, h = img.size
        n = np.random.default_rng(7).normal(128, 34, (h, w, 1)).astype(np.float32)
        a = np.asarray(img.convert('RGB'), np.float32)
        ov = np.where(a < 128, 2 * a * n / 255.0, 255.0 - 2 * (255.0 - a) * (255.0 - n) / 255.0)
        a = a * (1 - grain) + ov * grain
        img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')
    if vignette > 0:
        w, h = img.size
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        dx = (xx - w / 2) / (w / 2); dy = (yy - h / 2) / (h / 2)
        d = np.sqrt(dx * dx * .92 + dy * dy)
        m = np.clip((d - .55) / .62, 0, 1) ** 1.4 * vignette
        a = np.asarray(img.convert('RGB'), np.float32) * (1 - m[:, :, None])
        img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGB')
    return img


def debug_probe(data, scale, px=(640, 270), step=200):
    """逐段回放，找出是哪些指令改变了某像素（调试用）"""
    images = {}
    for c in data['canvases']:
        if c['id'] == 1:
            continue
        r = Raster(int(c['w']), int(c['h']), scale=1.0, bg=(0, 0, 0))
        images[c['id']] = r.run(c['ops'], data['registry'], images)
    main = next(c for c in data['canvases'] if c['id'] == 1)
    r = Raster(int(data['w'] * scale), int(data['h'] * scale), scale=scale, bg=(5, 8, 15))
    ops = main['ops']
    last = None
    for k in range(1, len(ops) + 1):
        r.run(ops[k - 1:k], data['registry'], images)
        cur = tuple(np.asarray(r.img.convert('RGB')).astype(int)[px[1], px[0]])
        if cur != last:
            print('op %4d %-8s %s -> %s' % (k - 1, ops[k - 1]['t'], str(ops[k - 1].get('style', ''))[:70], cur))
            last = cur
    return r.img


def main():
    scale = float(os.environ.get('DSH_SCALE', '0.667'))
    files = sys.argv[1:]
    if not files:
        files = sorted(glob.glob(os.path.join(ROOT, 'shots', 'f_*.json')))
    outdir = os.path.join(ROOT, 'preview')
    os.makedirs(outdir, exist_ok=True)
    for fp in files:
        with open(fp, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
        img, r = render_frame(data, scale)
        img = apply_overlay(img, r)
        name = os.path.splitext(os.path.basename(fp))[0]
        out = os.path.join(outdir, name + '.png')
        img.convert('RGB').save(out)
        print('%-14s t=%5.1fs  ops=%5d  panels=%d -> %s' % (
            name, data['t'], len(data['canvases'][0]['ops']), len(data['canvases']) - 1, out))


if __name__ == '__main__':
    main()
