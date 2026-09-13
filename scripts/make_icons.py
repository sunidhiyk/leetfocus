"""Generate the extension icons (tomato + checkmark). Run: python scripts/make_icons.py"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
OUT = Path(__file__).resolve().parent.parent / "icons"


def draw() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=230, fill=(28, 28, 33, 255))

    cx, cy, r = SIZE // 2, int(SIZE * 0.57), int(SIZE * 0.32)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(229, 83, 61, 255))

    top = cy - r
    leaf = [
        (cx, top - 70), (cx + 45, top + 5), (cx + 170, top - 20), (cx + 80, top + 55),
        (cx + 125, top + 135), (cx, top + 80), (cx - 125, top + 135), (cx - 80, top + 55),
        (cx - 170, top - 20), (cx - 45, top + 5),
    ]
    d.polygon(leaf, fill=(69, 192, 107, 255))

    width = int(SIZE * 0.075)
    points = [(cx - 150, cy + 20), (cx - 45, cy + 125), (cx + 160, cy - 90)]
    d.line(points, fill=(255, 255, 255, 255), width=width, joint="curve")
    for x, y in (points[0], points[-1]):
        d.ellipse([x - width // 2, y - width // 2, x + width // 2, y + width // 2], fill=(255, 255, 255, 255))
    return img


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    master = draw()
    for size in (16, 32, 48, 128):
        master.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
    master.resize((512, 512), Image.LANCZOS).save(OUT / "store-icon-512.png")
    print(f"Icons written to {OUT}")
