# -*- coding: utf-8 -*-
"""生成 PWA 图标 PNG（纯标准库，无第三方依赖）

图形沿用 index.html 顶栏的品牌 logo：24 单位坐标系里的 8 条描边线段
（顶面菱形 4 条 + 两条 V 形折线各 2 条），配色取 style.css 的 :root 变量：
    --accent    #6B5B45  → 背景（咖啡棕）
    --bg-card   #FAF6EE  → 线条（米白）

用法：python tools/make-icons.py
产出：icons/icon-192.png、icons/icon-512.png、icons/icon-maskable-512.png
"""
import os
import struct
import zlib

BG = (0x6B, 0x5B, 0x45)   # --accent
FG = (0xFA, 0xF6, 0xEE)   # --bg-card
STROKE = 1.9              # 描边宽度（24 单位制，原 SVG 为 1.6，图标上略加粗更清晰）
UNITS = 24.0

# 8 条线段（闭合菱形 4 条 + V1 两条 + V2 两条）
SEGMENTS = [
    ((4, 7.5), (12, 3.5)), ((12, 3.5), (20, 7.5)),
    ((20, 7.5), (12, 11.5)), ((12, 11.5), (4, 7.5)),
    ((4, 12.5), (12, 16.5)), ((12, 16.5), (20, 12.5)),
    ((4, 16.5), (12, 20.5)), ((12, 20.5), (20, 16.5)),
]


def write_png(path, size, rows):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
    raw = b''.join(rows)
    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8bit · RGBA
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) +
           chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def render(size, frac, path):
    """把图形按 frac（占画布比例）居中绘制；用 3x3 超采样做抗锯齿覆盖率"""
    scale = size * frac / UNITS
    offset = (size - UNITS * scale) / 2.0
    half_w = STROKE * scale / 2.0
    cover = [0.0] * (size * size)
    ss = 3
    unit = 1.0 / ss
    hits_total = float(ss * ss)

    for (x1, y1), (x2, y2) in SEGMENTS:
        ax, ay = x1 * scale + offset, y1 * scale + offset
        bx, by = x2 * scale + offset, y2 * scale + offset
        dx, dy = bx - ax, by - ay
        seg_len2 = dx * dx + dy * dy
        inv = (1.0 / seg_len2) if seg_len2 else 0.0
        # 只遍历这条线的包围盒，避免整画布扫描
        minx = max(0, int(min(ax, bx) - half_w - 1))
        maxx = min(size - 1, int(max(ax, bx) + half_w + 1))
        miny = max(0, int(min(ay, by) - half_w - 1))
        maxy = min(size - 1, int(max(ay, by) + half_w + 1))
        for py in range(miny, maxy + 1):
            base = py * size
            for pxx in range(minx, maxx + 1):
                hit = 0
                for sy in range(ss):
                    cy = py + (sy + 0.5) * unit - ay
                    for sx in range(ss):
                        cx = pxx + (sx + 0.5) * unit - ax
                        t = (cx * dx + cy * dy) * inv
                        if t < 0.0:
                            t = 0.0
                        elif t > 1.0:
                            t = 1.0
                        qx = cx - t * dx
                        qy = cy - t * dy
                        if qx * qx + qy * qy <= half_w * half_w:
                            hit += 1
                if hit:
                    cover[base + pxx] += hit / hits_total

    # 合成：背景 → 按覆盖率混合前景
    rows = []
    for y in range(size):
        row = bytearray([0])  # filter type 0
        base = y * size
        for x in range(size):
            c = cover[base + x]
            if c > 1.0:
                c = 1.0
            for ch in range(3):
                row.append(int(BG[ch] + (FG[ch] - BG[ch]) * c))
            row.append(255)
        rows.append(bytes(row))

    write_png(path, size, rows)
    print('生成', path, '（%dx%d）' % (size, size))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(os.path.dirname(here), 'icons')
    os.makedirs(out_dir, exist_ok=True)
    render(192, 0.72, os.path.join(out_dir, 'icon-192.png'))
    render(512, 0.72, os.path.join(out_dir, 'icon-512.png'))
    # maskable：安卓会把图标裁进多种遮罩，图形必须缩进到中心 ~56%，四周留安全边
    render(512, 0.56, os.path.join(out_dir, 'icon-maskable-512.png'))


if __name__ == '__main__':
    main()
