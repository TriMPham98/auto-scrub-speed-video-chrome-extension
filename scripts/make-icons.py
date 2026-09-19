#!/usr/bin/env python3
"""Generate toolbar icons for Auto Scrub Speed."""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "icons"
ROOT.mkdir(exist_ok=True)

BG = (18, 21, 28, 255)
TEAL = (62, 224, 196, 255)
AMBER = (255, 176, 32, 255)
INK = (244, 241, 234, 255)


def lerp(a, b, t):
    return int(a + (b - a) * t)


def draw_icon(size: int) -> Image.Image:
    scale = 4
    n = size * scale
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Full-bleed rounded square (Chrome also masks, but this looks good unpacked)
    radius = int(n * 0.22)
    d.rounded_rectangle((0, 0, n - 1, n - 1), radius=radius, fill=BG)

    cx, cy = n / 2, n / 2 + n * 0.04
    # Waveform bars — music
    bars = 5
    span = n * 0.56
    left = cx - span / 2
    heights = [0.28, 0.55, 0.9, 0.48, 0.34]
    bw = n * 0.07
    gap = (span - bars * bw) / (bars - 1)
    for i, h in enumerate(heights):
        x0 = left + i * (bw + gap)
        bh = n * 0.38 * h
        y0 = cy - bh / 2
        color = TEAL if i % 2 == 0 else tuple(lerp(TEAL[j], AMBER[j], 0.55) for j in range(3)) + (255,)
        d.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=bw / 2, fill=color)

    # Play wedge — talking/speed
    p = n * 0.16
    tri = [
        (n * 0.32, n * 0.28),
        (n * 0.32, n * 0.28 + p * 1.35),
        (n * 0.32 + p * 1.15, n * 0.28 + p * 0.67),
    ]
    d.polygon(tri, fill=AMBER)

    return img.resize((size, size), Image.Resampling.LANCZOS)


def draw_small(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=max(3, size // 5), fill=BG)
    # Two bars + play
    m = size / 16
    d.rectangle((m * 9, m * 5, m * 11, m * 11), fill=TEAL)
    d.rectangle((m * 12.2, m * 6.5, m * 14.2, m * 9.5), fill=TEAL)
    d.polygon([(m * 3.2, m * 4.5), (m * 3.2, m * 11.5), (m * 8.2, m * 8)], fill=AMBER)
    return img


def main():
    draw_icon(128).save(ROOT / "icon128.png")
    draw_icon(48).save(ROOT / "icon48.png")
    draw_small(16).save(ROOT / "icon16.png")
    print(f"Wrote icons in {ROOT}")


if __name__ == "__main__":
    main()
