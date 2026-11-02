#!/usr/bin/env python3
"""Re-colour the empty-state line art for each colour theme.

The four illustrations in public/brand (door, lantern, scroll, token mirror) are drawn in Moonlit's violet, with a cyan flame or
glow. A pixel's brightness says how far along the glow it is (dim halo ... bright core), so each coloured pixel is moved to the same
place on the theme's own ramp: violet pixels run from the theme's --accent-lo to --accent-hi, cyan pixels from --accent-2-lo to
--accent-2-hi. In the light themes those two are the other way round (light halo, dark core), which is what keeps the lines visible
on paper. Greys and the white of the flame are left alone, and so is the alpha.

Reads the colours from src/styles/tokens.css and themes.css, so a new theme only needs its block there:
    python scripts/build-themed-art.py            (needs Pillow)
Writes public/brand/themed/empty-<art>.<theme>.png. Moonlit keeps the originals.
"""
import colorsys
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ART = ['door', 'lantern', 'scroll', 'token']


def hex_rgb(value):
    value = value.strip().lstrip('#')
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def theme_blocks():
    css = (ROOT / 'src/styles/themes.css').read_text(encoding='utf-8')
    blocks = {}
    for match in re.finditer(r":root\[data-theme='([a-z]+)'\]\s*\{(.*?)\n\}", css, re.S):
        blocks[match.group(1)] = dict(re.findall(r'(--[a-z0-9-]+):\s*([^;]+);', match.group(2)))
    return blocks


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def recolor(image, violet, cyan, gamma=1.0):
    pixels = list(image.getdata())
    groups = {'violet': [], 'cyan': []}
    kinds = []
    for r, g, b, a in pixels:
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        hue = h * 360
        kind = None
        if a > 0 and s >= 0.18 and v >= 0.2:
            kind = 'violet' if 215 <= hue <= 300 else 'cyan' if 150 <= hue < 215 else None
        kinds.append(kind)
        if kind:
            groups[kind].append(v)
    spans = {}
    for kind, values in groups.items():
        values.sort()
        spans[kind] = (values[int(len(values) * 0.02)], values[int(len(values) * 0.98)]) if values else (0, 1)
    out = []
    for (r, g, b, a), kind in zip(pixels, kinds):
        if not kind:
            out.append((r, g, b, a))
            continue
        low, high = spans[kind]
        v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[2]
        t = 0 if high <= low else max(0.0, min(1.0, (v - low) / (high - low)))
        t = t ** gamma
        ramp = violet if kind == 'violet' else cyan
        out.append((*lerp(ramp[0], ramp[1], t), a))
    result = Image.new('RGBA', image.size)
    result.putdata(out)
    return result


def main():
    target = ROOT / 'public/brand/themed'
    target.mkdir(parents=True, exist_ok=True)
    for theme, tokens in theme_blocks().items():
        violet = (hex_rgb(tokens['--accent-lo']), hex_rgb(tokens['--accent-hi']))
        cyan = (hex_rgb(tokens['--accent-2-lo']), hex_rgb(tokens['--accent-2-hi']))
        gamma = 1.0
        if tokens.get('--scheme', '').strip() == 'light':
            # on paper the line itself has to be the dark end: start the halo part-way to the accent and let most of the line reach it
            violet = (lerp(violet[0], hex_rgb(tokens['--accent']), 0.6), violet[1])
            cyan = (lerp(cyan[0], hex_rgb(tokens['--accent-2']), 0.6), cyan[1])
            gamma = 0.4
        for name in ART:
            source = Image.open(ROOT / f'public/brand/empty-{name}.png').convert('RGBA')
            recolor(source, violet, cyan, gamma).save(target / f'empty-{name}.{theme}.png', optimize=True)
        print('wrote', theme, [f'empty-{name}.{theme}.png' for name in ART])


if __name__ == '__main__':
    main()
