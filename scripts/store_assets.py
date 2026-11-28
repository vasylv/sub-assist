#!/usr/bin/env python3
"""Builds the Chrome Web Store listing images into dist/store/.

  icons/icon{16,32,48,128}.png      extension icons (shipped in the zip)
  dist/store/store-icon-128.png     store icon: 96px artwork + 16px clear padding
  dist/store/promo-small-440x280.png
  dist/store/promo-marquee-1400x560.png
  dist/store/screenshot-N-1280x800.png   real captures framed per the design

The tiles and screenshots are laid out in HTML and captured with headless
Chrome, then flattened to 24-bit RGB PNG (the store rejects alpha).
"""
import html
import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
OUT = DIST / "store"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

VIOLET, VIOLET_2 = "#6950e8", "#7b63f0"
MINT, INK, LAVENDER, CREAM, BAR = "#c7f2a2", "#242136", "#ede8ff", "#faf8f0", "#f7f4eb"
MUTED = "#6f6a82"
FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif'

# Captures in dist/ (matched by the time in the macOS screenshot name, which
# holds a narrow no-break space before PM), in listing order, with their copy.
# An optional fourth item lists the boxes (x0, y0, x1, y1, corner radius) to keep
# sharp; everything else in that capture is blurred beyond recognition, so a
# real person in the video is not shown in the listing.
SHOTS = [
    ("11.02.26",
     "Understand what they mean.",
     "Pause the video and get clear explanations of the lines you just heard."),
    ("11.10.11",
     "Make sense of expressions.",
     "Slang, idioms and jokes, explained in the context they were said.",
     [(20, 83, 1010, 1061, 28),      # explanation card
      (931, 1087, 1454, 1160, 0)]),  # on-screen subtitle
    ("11.33.05",
     "Follow the whole sentence.",
     "See how each part of a line adds to its meaning."),
    ("11.37.00",
     "Learn from real conversations.",
     "Works on YouTube videos with English subtitles, using your own OpenAI or Gemini key."),
]


# ---------------------------------------------------------------- icons

def draw_mark(size, pad=0):
    """The logo: violet rounded square, a long light bar over a short mint bar."""
    S = size * 8  # supersample, then downscale for clean edges
    P = pad * 8
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    a = S - 2 * P  # artwork side
    d.rounded_rectangle((P, P, P + a - 1, P + a - 1), radius=round(a * 0.22), fill=VIOLET)
    h = a * 0.13
    x0 = P + a * 0.14
    d.rounded_rectangle((x0, P + a * 0.34, x0 + a * 0.52, P + a * 0.34 + h), radius=h / 2, fill=BAR)
    d.rounded_rectangle((x0, P + a * 0.56, x0 + a * 0.36, P + a * 0.56 + h), radius=h / 2, fill=MINT)
    return img.resize((size, size), Image.Resampling.LANCZOS)


def build_icons():
    for s in (16, 32, 48, 128):
        draw_mark(s).save(ROOT / "icons" / f"icon{s}.png")
    # Store guideline: 128x128 canvas, 96x96 artwork, transparent padding.
    draw_mark(128, pad=16).save(OUT / "store-icon-128.png")


# ---------------------------------------------------------------- html pages

BASE_CSS = f"""
* {{ margin:0; padding:0; box-sizing:border-box; }}
html, body {{ overflow:hidden; font-family:{FONT}; -webkit-font-smoothing:antialiased; }}
.bar {{ position:absolute; border-radius:999px; }}
.deco {{ position:absolute; background:{VIOLET_2}; }}
"""


def tile_small():
    return f"""<style>{BASE_CSS}
body {{ width:440px; height:280px; background:{VIOLET}; position:relative; color:{CREAM}; }}
</style><body>
<div class="deco" style="left:321px; top:-60px; width:180px; height:187px; border-radius:0 0 0 64px"></div>
<div class="deco" style="left:-40px; top:220px; width:176px; height:120px; border-radius:0 64px 0 0"></div>
<div class="bar" style="left:50px; top:53px; width:120px; height:23px; background:{BAR}"></div>
<div class="bar" style="left:50px; top:90px; width:81px; height:23px; background:{MINT}"></div>
<div style="position:absolute; left:49px; top:138px; font-size:46px; font-weight:500; letter-spacing:-.5px">Sub Assist</div>
<div style="position:absolute; left:50px; top:203px; font-size:18px">English, made clearer.</div>
</body>"""


def tile_marquee():
    return f"""<style>{BASE_CSS}
body {{ width:1400px; height:560px; background:{VIOLET}; position:relative; color:{CREAM}; }}
</style><body>
<div class="deco" style="left:1094px; top:-80px; width:400px; height:400px; border-radius:0 0 0 72px"></div>
<div class="deco" style="left:-60px; top:441px; width:470px; height:200px; border-radius:0 120px 0 0"></div>
<div class="bar" style="left:1033px; top:172px; width:251px; height:48px; background:{BAR}"></div>
<div class="bar" style="left:1033px; top:249px; width:168px; height:48px; background:{MINT}"></div>
<div style="position:absolute; left:80px; top:82px; font-size:30px; font-weight:500">Sub Assist</div>
<div style="position:absolute; left:78px; top:166px; font-size:76px; font-weight:500; line-height:1.18; letter-spacing:-1px">
  Watch in English.<br>Understand more.</div>
<div style="position:absolute; left:81px; top:383px; font-size:25px">Natural English explanations for subtitles.</div>
</body>"""


def screenshot_page(capture, n, headline, sub):
    src = "file://" + str(capture).replace(" ", "%20")
    return f"""<style>{BASE_CSS}
body {{ width:1280px; height:800px; background:{CREAM}; position:relative; color:{INK}; }}
.brand {{ position:absolute; left:64px; top:64px; display:flex; align-items:center; gap:12px;
          font-size:20px; font-weight:600; }}
.text {{ position:absolute; left:64px; top:0; bottom:0; width:356px;
         display:flex; flex-direction:column; justify-content:center; }}
.chip {{ align-self:flex-start; background:{LAVENDER}; color:{VIOLET}; font-size:13px; font-weight:700;
         letter-spacing:1.2px; padding:6px 12px; border-radius:999px; margin-bottom:22px; }}
h1 {{ font-size:46px; line-height:1.12; font-weight:600; letter-spacing:-.8px; }}
p {{ margin-top:20px; font-size:21px; line-height:1.45; color:{MUTED}; }}
.bars {{ position:absolute; left:64px; bottom:64px; }}
.frame {{ position:absolute; right:56px; top:50%; transform:translateY(-50%);
          width:772px; height:700px; display:flex; align-items:center; justify-content:center; }}
.frame img {{ max-width:100%; max-height:100%; border-radius:18px; display:block;
              box-shadow:0 24px 60px rgba(36,33,54,.22), 0 0 0 1px rgba(36,33,54,.08); }}
</style><body>
<div class="brand"><img src="file://{ROOT}/icons/icon128.png" width="34" height="34">Sub Assist</div>
<div class="text">
  <div class="chip">IN NATURAL ENGLISH &nbsp;·&nbsp; 0{n}</div>
  <h1>{html.escape(headline)}</h1>
  <p>{html.escape(sub)}</p>
</div>
<div class="bars">
  <div style="width:84px;height:14px;border-radius:7px;background:{VIOLET}"></div>
  <div style="width:56px;height:14px;border-radius:7px;background:{MINT};margin-top:9px"></div>
</div>
<div class="frame"><img src="{src}"></div>
</body>"""


def render(page_html, width, height, dest):
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "page.html"
        page.write_text("<!DOCTYPE html><meta charset=utf-8>" + page_html)
        raw = Path(tmp) / "raw.png"
        subprocess.run([
            CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--force-device-scale-factor=1", "--allow-file-access-from-files",
            f"--window-size={width},{height}", f"--screenshot={raw}",
            "--virtual-time-budget=3000", page.as_uri(),
        ], check=True, capture_output=True)
        img = Image.open(raw)
        if img.size != (width, height):
            img = img.crop((0, 0, width, height))
        # Store wants 24-bit PNG with no alpha.
        img.convert("RGB").save(dest, optimize=True)


def blur_outside(capture, keep, dest):
    """Blurs the capture except the given boxes, which stay sharp."""
    img = Image.open(capture).convert("RGB")
    blurred = img.filter(ImageFilter.GaussianBlur(48))
    mask = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(mask)
    for x0, y0, x1, y1, r in keep:
        d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=255)
    Image.composite(img, blurred, mask).save(dest)
    return dest


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    build_icons()
    render(tile_small(), 440, 280, OUT / "promo-small-440x280.png")
    render(tile_marquee(), 1400, 560, OUT / "promo-marquee-1400x560.png")
    tmp = Path(tempfile.mkdtemp())
    for n, (name, headline, sub, *keep) in enumerate(SHOTS, 1):
        found = sorted(DIST.glob(f"Screenshot*{name}*.png"))
        if not found:
            raise SystemExit(f"missing capture in dist/: *{name}*")
        capture = found[0]
        if keep:
            capture = blur_outside(capture, keep[0], tmp / f"capture-{n}.png")
        render(screenshot_page(capture, n, headline, sub), 1280, 800,
               OUT / f"screenshot-{n}-1280x800.png")
    for f in sorted(OUT.iterdir()):
        im = Image.open(f)
        print(f"{f.relative_to(ROOT)}  {im.size[0]}x{im.size[1]}  {im.mode}")


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
