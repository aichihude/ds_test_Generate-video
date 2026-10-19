#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tools/contact.py — 把 preview/*.png 拼成一张分镜总览图（含时间码标注）"""
import os, glob, json
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
prev = os.path.join(ROOT, 'preview')
shots = os.path.join(ROOT, 'shots')
files = sorted(glob.glob(os.path.join(prev, 'f_*.png')))
COLS = 4
TW, TH = 480, 270
PAD, GAP = 14, 10
try:
    f = ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", 15)
except Exception:
    f = ImageFont.load_default()

rows = (len(files) + COLS - 1) // COLS
W = PAD * 2 + COLS * TW + (COLS - 1) * GAP
H = PAD * 2 + rows * (TH + 24) + (rows - 1) * GAP
sheet = Image.new('RGB', (W, H), (5, 8, 15))
d = ImageDraw.Draw(sheet)
for i, fp in enumerate(files):
    r, c = divmod(i, COLS)
    x = PAD + c * (TW + GAP)
    y = PAD + r * (TH + 24 + GAP)
    im = Image.open(fp).convert('RGB').resize((TW, TH), Image.LANCZOS)
    sheet.paste(im, (x, y))
    d.rectangle([x, y, x + TW - 1, y + TH - 1], outline=(30, 44, 68))
    name = os.path.splitext(os.path.basename(fp))[0]
    jf = os.path.join(shots, name + '.json')
    t = json.load(open(jf, encoding='utf-8'))['t'] if os.path.exists(jf) else 0
    d.text((x + 2, y + TH + 4), '%s   t=%5.1fs' % (name, t), font=f, fill=(140, 170, 210))
out = os.path.join(prev, '_contact_sheet.png')
sheet.save(out)
print('contact sheet ->', out, sheet.size)
