"""Generates the Reader launcher icons (cream "R" on Mocha Bean).

Output goes to resources/android/res/mipmap-*/ and is committed, so you only need
to run this if you want to change the icon:  python3 resources/make-icons.py
Requires Pillow (pip install pillow).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

CREAM = (0xF3, 0xE9, 0xD7, 255)
MOCHA = (0x7A, 0x55, 0x3A, 255)

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "C:/Windows/Fonts/georgiab.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
]
font_path = next((p for p in FONT_CANDIDATES if Path(p).exists()), None)
if not font_path:
    raise SystemExit("No bold serif font found; edit FONT_CANDIDATES.")

out = Path(__file__).parent / "android" / "res"

# adaptive-icon foreground is 108dp, legacy launcher icon is 48dp
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}


def letter(size, height_ratio):
    """Transparent canvas with a centered cream 'R' whose cap height is height_ratio * size."""
    big = size * 4  # draw large, then downsample for smooth edges
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(font_path, int(big * height_ratio * 1.38))
    l, t, r, b = d.textbbox((0, 0), "R", font=font)
    d.text(((big - (r - l)) / 2 - l, (big - (b - t)) / 2 - t), "R", font=font, fill=CREAM)
    return img.resize((size, size), Image.LANCZOS)


for name, k in DENSITIES.items():
    folder = out / f"mipmap-{name}"
    folder.mkdir(parents=True, exist_ok=True)

    # adaptive foreground (108dp). Letter stays inside the 66% safe zone.
    fg = round(108 * k)
    letter(fg, 0.36).save(folder / "ic_launcher_foreground.png")

    # legacy square-ish and round icons (48dp)
    s = round(48 * k)
    for filename, radius in (("ic_launcher.png", 0.22), ("ic_launcher_round.png", 0.5)):
        scale = 4
        base = Image.new("RGBA", (s * scale, s * scale), (0, 0, 0, 0))
        ImageDraw.Draw(base).rounded_rectangle(
            [0, 0, s * scale - 1, s * scale - 1], radius=int(s * scale * radius), fill=MOCHA
        )
        base = base.resize((s, s), Image.LANCZOS)
        base.alpha_composite(letter(s, 0.46))
        base.save(folder / filename)

print("Icons written to", out)
