#!/usr/bin/env python3
"""Generate the Ditherlab app icon: a Bayer-dithered sunset, on brand.

Pure stdlib (no PIL): writes a 1024x1024 RGBA PNG by hand.
"""
import math
import struct
import sys
import zlib

SIZE = 1024
CELL = 16  # dither cell size -> 64x64 chunky grid
RADIUS = 210  # rounded-corner radius

BAYER8 = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
]

BG = (11, 11, 16)
SUN = (242, 242, 246)     # off-white dither dots (sky)
WATER = (139, 124, 255)   # violet dither dots (reflection)

SUN_X, SUN_Y, SUN_R = 0.5, 0.46, 0.52
HORIZON = 0.62


def corner_alpha(x, y):
    """255 inside the rounded rect, 0 outside, ~2px soft edge."""
    r = RADIUS
    cx = min(max(x, r), SIZE - 1 - r)
    cy = min(max(y, r), SIZE - 1 - r)
    d = math.hypot(x - cx, y - cy)
    if d <= r - 2:
        return 255
    if d >= r:
        return 0
    return int(255 * (r - d) / 2)


def luminance(x, y):
    """Target brightness 0..1 before dithering (sampled at cell centers)."""
    fx, fy = x / SIZE, y / SIZE
    if fy < HORIZON:
        # radial sun glow
        d = math.hypot(fx - SUN_X, fy - SUN_Y) / SUN_R
        lum = max(0.0, 1.0 - d) ** 1.6
        # solid core
        if d < 0.28:
            lum = 1.0
        return lum
    # water: reflection column fading downward
    spread = math.exp(-((fx - SUN_X) / 0.16) ** 2)
    fade = max(0.0, 1.0 - (fy - HORIZON) / (1.0 - HORIZON) * 1.15)
    return spread * fade * 0.85


def main(path):
    rows = []
    for y in range(SIZE):
        row = bytearray([0])  # filter type 0
        for x in range(SIZE):
            a = corner_alpha(x, y)
            if a == 0:
                row += bytes((0, 0, 0, 0))
                continue
            # sample luminance at the dither-cell center for crisp cells
            cx = (x // CELL) * CELL + CELL // 2
            cy = (y // CELL) * CELL + CELL // 2
            lum = luminance(cx, cy)
            t = (BAYER8[(y // CELL) % 8][(x // CELL) % 8] + 0.5) / 64
            on = lum > t
            color = (SUN if cy < HORIZON * SIZE else WATER) if on else BG
            row += bytes((*color, a))
        rows.append(bytes(row))

    raw = b''.join(rows)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    print(f'wrote {path} ({SIZE}x{SIZE})')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'icon-1024.png')
