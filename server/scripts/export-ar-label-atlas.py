"""Build the AR nameplate font atlas from the iPhone app's Poppins typeface."""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[2]
font_file = root / "frontend/node_modules/@expo-google-fonts/poppins/600SemiBold/Poppins_600SemiBold.ttf"
output = root / "frontend/assets"
font = ImageFont.truetype(str(font_file), 44)
characters = "".join(map(chr, range(32, 127))) + "čćČĆéÉüÜöÖäÄñÑíÍáÁóÓúÚøØßŁł"
cell = 64
columns = 16
baseline = 49
atlas = Image.new("RGBA", (columns * cell, 8 * cell), (255, 255, 255, 0))
draw = ImageDraw.Draw(atlas)
advances = {}
for index, char in enumerate(characters):
    left = index % columns * cell
    top = index // columns * cell
    draw.text((left + 2, top + baseline), char, font=font, fill="white", anchor="ls")
    advances[char] = [index, round(font.getlength(char), 2)]
atlas.save(output / "peek-ar-name-atlas.png", optimize=True)
(output / "peek-ar-name-atlas.json").write_text(
    json.dumps({"cell": cell, "columns": columns, "rows": 8, "baseline": baseline, "advances": advances}) + "\n",
    encoding="utf-8",
)
