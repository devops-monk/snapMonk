#!/usr/bin/env python3
"""Annotated Chrome Web Store screenshots for SnapMonk (1280x800, RGB no-alpha).

Frames real app screenshots on a branded purple gradient with a headline,
subtitle, feature chips, and callout labels pointing at key UI.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1280, 800
SANS = "/System/Library/Fonts/HelveticaNeue.ttc"
SRC = "/Users/abhaypratapsingh/Documents/Personal/ScreenshotPlugin/snapmonk_images"
OUT = os.path.dirname(__file__)

TOP = (109, 74, 196)     # violet
BOTTOM = (32, 20, 60)
ACCENT = (185, 158, 255)

IMG = {
    "capture": "Screenshot 2026-08-03 at 00.16.39.png",
    "record": "Screenshot 2026-08-03 at 00.17.02.png",
    "editor": "Screenshot 2026-08-03 at 00.20.18.png",
    "settings": "Screenshot 2026-08-03 at 00.20.43.png",
    "recording": "Screenshot 2026-08-03 at 00.23.37.png",
}


def font(size, bold=False):
    return ImageFont.truetype(SANS, size, index=1 if bold else 0)


def gradient():
    base = Image.new("RGB", (1, H))
    px = base.load()
    for y in range(H):
        t = (y / (H - 1)) ** 1.1
        px[0, y] = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
    img = base.resize((W, H)).convert("RGBA")
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([-200, -400, W + 200, 260], fill=(255, 255, 255, 26))
    return Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(90)))


def rounded(size, r):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=r, fill=255)
    return m


def place_card(canvas, shot, box, crop=None):
    x, y, bw, bh = box
    im = Image.open(os.path.join(SRC, shot)).convert("RGB")
    if crop:
        im = im.crop(crop)
    scale = min(bw / im.width, bh / im.height)
    nw, nh = int(im.width * scale), int(im.height * scale)
    im = im.resize((nw, nh), Image.LANCZOS)
    px, py = x + (bw - nw) // 2, y + (bh - nh) // 2
    rad = 16
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sh.paste((5, 3, 20, 150), (px, py + 10), rounded((nw, nh), rad))
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(22)))
    canvas.paste(im, (px, py), rounded((nw, nh), rad))
    ImageDraw.Draw(canvas).rounded_rectangle(
        [px, py, px + nw - 1, py + nh - 1], radius=rad, outline=(255, 255, 255, 45), width=2)
    return (px, py, nw, nh)


def wrap(draw, text, fnt, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=fnt) <= max_w:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_text_block(draw, x, y, headline, subtitle, max_w):
    hf = font(46, bold=True)
    for line in wrap(draw, headline, hf, max_w):
        draw.text((x, y), line, font=hf, fill=(255, 255, 255))
        y += 54
    y += 10
    sf = font(25)
    for line in wrap(draw, subtitle, sf, max_w):
        draw.text((x, y), line, font=sf, fill=(226, 218, 245))
        y += 34
    return y


def chips(canvas, x, y, items):
    cf = font(20, bold=True)
    d = ImageDraw.Draw(canvas)
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    pos, cx = [], x
    for it in items:
        tw = d.textlength(it, font=cf)
        w = tw + 28
        od.rounded_rectangle([cx, y, cx + w, y + 36], radius=18, fill=(255, 255, 255, 48))
        pos.append((cx + 14, it))
        cx += w + 12
    canvas.alpha_composite(overlay)
    for tx, it in pos:
        d.text((tx, y + 8), it, font=cf, fill=(255, 255, 255))


def callout(canvas, anchor, label_xy, text):
    d = ImageDraw.Draw(canvas)
    cf = font(21, bold=True)
    tw = d.textlength(text, font=cf)
    lx, ly = label_xy
    d.line([label_xy, anchor], fill=(255, 255, 255, 230), width=3)
    d.ellipse([anchor[0] - 6, anchor[1] - 6, anchor[0] + 6, anchor[1] + 6], fill=(255, 255, 255))
    d.ellipse([anchor[0] - 3, anchor[1] - 3, anchor[0] + 3, anchor[1] + 3], fill=ACCENT)
    d.rounded_rectangle([lx, ly - 18, lx + tw + 24, ly + 18], radius=18, fill=(255, 255, 255))
    d.text((lx + 12, ly - 12), text, font=cf, fill=(60, 30, 110))


def base(headline, subtitle, chip_items, text_w=560, chips_y=None):
    c = gradient()
    d = ImageDraw.Draw(c)
    draw_text_block(d, 64, 70, headline, subtitle, text_w)
    chips(c, 64, chips_y if chips_y is not None else H - 72, chip_items)
    return c


def save(c, name):
    c.convert("RGB").save(os.path.join(OUT, name))
    print("wrote", name)


def main():
    # 1 — Editor (hero, wide)
    c = base(
        "A powerful annotation editor",
        "Arrows, shapes, text, blur & redact, step numbers, crop — all in one editor.",
        ["Blur & redact", "Step numbers", "PNG · JPG · PDF"],
        text_w=1140, chips_y=205,
    )
    box = place_card(c, IMG["editor"], (150, 258, 980, 512))
    px, py, nw, nh = box
    callout(c, (px + nw * 0.03, py + nh * 0.4), (26, py + nh * 0.4), "20+ tools")
    callout(c, (px + nw * 0.22, py + nh * 0.985), (px + nw * 0.5, py + nh + 8), "Export PNG / JPG / PDF or copy")
    save(c, "store-1-editor.png")

    # 2 — Capture (portrait popup right)
    c = base(
        "Capture anything, instantly",
        "Visible area, full-page scroll & stitch, drag-to-select region, or pick a single element.",
        ["Full-page stitch", "Region select", "Element picker"],
    )
    box = place_card(c, IMG["capture"], (740, 60, 480, 680))
    px, py, nw, nh = box
    callout(c, (px + nw * 0.5, py + nh * 0.42), (300, 300), "Visible · Full-page · Region")
    callout(c, (px + nw * 0.3, py + nh * 0.68), (330, 440), "Pick any element")
    save(c, "store-2-capture.png")

    # 3 — Record (portrait popup right)
    c = base(
        "Record your screen",
        "Tab, desktop, or window — up to 1080p, with webcam overlay, microphone and system sound.",
        ["Webcam overlay", "Mic + audio", "Up to 1080p"],
    )
    box = place_card(c, IMG["record"], (760, 40, 460, 720))
    px, py, nw, nh = box
    callout(c, (px + nw * 0.5, py + nh * 0.66), (300, 320), "Webcam + mic overlay")
    callout(c, (px + nw * 0.5, py + nh * 0.87), (330, 470), "One click to record")
    save(c, "store-3-record.png")

    # 4 — Recording in action (wide)
    c = base(
        "Control recordings on the fly",
        "Floating controls stay out of your way — pause, resume, and Stop & Save in one click.",
        ["Pause / resume", "Live timer", "WebM export"],
        text_w=1140, chips_y=205,
    )
    box = place_card(c, IMG["recording"], (150, 258, 980, 512), crop=(0, 0, 4100, 1500))
    px, py, nw, nh = box
    callout(c, (px + nw * 0.5, py + nh * 0.08), (px + nw * 0.5 - 90, py - 8), "Live recording controls")
    save(c, "store-4-recording.png")

    # 5 — Privacy / settings (square-ish right)
    c = base(
        "100% local. Private by design.",
        "SnapMonk never sends your screenshots to any server — capture, annotation and export all happen in your browser.",
        ["No servers", "No tracking", "No account"],
    )
    box = place_card(c, IMG["settings"], (730, 70, 500, 660))
    px, py, nw, nh = box
    callout(c, (px + nw * 0.5, py + nh * 0.92), (300, 360), "All processing on-device")
    save(c, "store-5-privacy.png")


if __name__ == "__main__":
    main()
