"""Divetrope build: turn a folder of nested layer images into a static site.

  python build.py <dive>              build the site into <dive>/site/
  python build.py <dive> --out DIR    build into DIR
  python build.py check <dive>        score how well each layer sits inside the one around it
  python build.py new <dive>          start a dive from templates/dive.json

<dive>/dive.json lists the layers outermost first. Layer i shows layer i+1 in
its centre at 1/scale of its width and height, and the last layer shows the
first. The format is described in docs/dive-json.md. Needs Pillow and numpy.
"""
import hashlib
import html
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / "divetrope.js"
TEMPLATES = ROOT / "templates"
PAGES = {"page.html": "index.html", "embed.html": "embed.html", "demo.html": "demo.html"}
LAYER_KEYS = ("eyebrow", "headline", "body", "sub", "chips", "hold", "video")
SITE_KEYS = ("brand", "page", "theme", "score")
ALPHA_EDGE = 0.06   # an inner layer's alpha ramps 0 -> 1 over this band (fraction of the frame)
SEAM_OK, SEAM_WARN = 9, 15


def load(dive):
    path = dive / "dive.json"
    if not path.exists():
        sys.exit(f"{path}: not found (python build.py new {dive} starts one)")
    cfg = json.loads(path.read_text(encoding="utf-8"))
    layers = cfg.get("layers") or []
    if len(layers) < 2:
        sys.exit(f"{path}: a dive needs at least two layers")
    for i, L in enumerate(layers):
        if "id" not in L or "image" not in L:
            sys.exit(f"{path}: layer {i} needs an id and an image")
        if not (dive / L["image"]).exists():
            sys.exit(f"{path}: layer {i} ({L['id']}): {L['image']} not found")
    if "width" not in cfg or "height" not in cfg:
        with Image.open(dive / layers[0]["image"]) as im:
            cfg.setdefault("width", im.width)
            cfg.setdefault("height", im.height)
    cfg.setdefault("scale", 4)
    return cfg


def read(path, w, h):
    """The image as RGB at w x h, centre-cropped first if its shape differs."""
    im = Image.open(path).convert("RGB")
    if abs(im.width / im.height - w / h) > 0.01:
        if im.width / im.height > w / h:
            cw = round(im.height * w / h)
            im = im.crop(((im.width - cw) // 2, 0, (im.width - cw) // 2 + cw, im.height))
        else:
            ch = round(im.width * h / w)
            im = im.crop((0, (im.height - ch) // 2, im.width, (im.height - ch) // 2 + ch))
    return im if im.size == (w, h) else im.resize((w, h), Image.LANCZOS)


def smoothstep(a, b, v):
    t = np.clip((v - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def edge_distance(w, h):
    """Distance to the nearest frame edge, as a fraction of the frame: 0 at the edge, 0.5 in the middle."""
    x = np.linspace(0, 1, w, dtype=np.float32)
    y = np.linspace(0, 1, h, dtype=np.float32)
    return np.minimum(np.minimum(x, 1 - x)[None, :], np.minimum(y, 1 - y)[:, None])


def export(dive, cfg, site):
    """Feathered-alpha WebP layers in every size, plus manifest.json."""
    W, H = cfg["width"], cfg["height"]
    sizes = [s for s in cfg.get("export_sizes", [3200, 2400, 1600]) if s <= W] or [W]
    (site / "layers").mkdir(parents=True, exist_ok=True)
    manifest = {"scale": cfg["scale"], "width": W, "height": H, "layers": []}
    for i, L in enumerate(cfg["layers"]):
        img = read(dive / L["image"], W, H)
        entry = {"id": L["id"], "label": L.get("label", L["id"]), "src": {}}
        entry.update({k: L[k] for k in LAYER_KEYS if k in L})
        for size in sizes:
            h = size * H // W
            alpha = Image.fromarray((smoothstep(0, ALPHA_EDGE, edge_distance(size, h)) * 255).astype(np.uint8))
            rgba = img.resize((size, h), Image.LANCZOS)
            rgba.putalpha(alpha)
            name = f"{i:02d}_{L['id']}_{size}.webp"
            rgba.save(site / "layers" / name, "WEBP", quality=82, method=4)
            entry["src"][str(size)] = f"layers/{name}"
        manifest["layers"].append(entry)
        print(f"  {i:02d} {L['id']}")
    manifest.update({k: cfg[k] for k in SITE_KEYS if k in cfg})
    (site / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")


def build(dive, site):
    cfg = load(dive)
    site.mkdir(parents=True, exist_ok=True)
    export(dive, cfg, site)
    shutil.copy2(ENGINE, site / "divetrope.js")
    if (dive / "assets").is_dir():
        shutil.copytree(dive / "assets", site, dirs_exist_ok=True)
    page, theme, brand = cfg.get("page", {}), cfg.get("theme", {}), cfg.get("brand", {})
    stamp = hashlib.sha1(ENGINE.read_bytes() + (site / "manifest.json").read_bytes()).hexdigest()[:8]
    esc = lambda s: html.escape(str(s), quote=True)
    css = lambda s: "".join(c for c in str(s) if c not in "<>{};")   # values inside <style>
    values = {
        "title": esc(page.get("title") or brand.get("name") or dive.name),
        "description": esc(page.get("description", "")),
        "lang": esc(page.get("lang", "en")),
        "ink": esc(theme.get("ink", "#0b1020")),
        "primary": esc(theme.get("primary", "#4c6fff")),
        "font_display": css(theme.get("fontDisplay", "system-ui, sans-serif")),
        "font_text": css(theme.get("fontText", "system-ui, sans-serif")),
        "brand_name": esc(brand.get("name", "")),
        "brand_url": esc(brand.get("url", "")),
        "version": stamp,
        "favicon": f'<link rel="icon" href="{esc(brand["logo"])}">' if brand.get("logo") else "",
        "fonts": (f'<link rel="preconnect" href="https://fonts.googleapis.com">\n  '
                  f'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n  '
                  f'<link href="{esc(theme["fontsHref"])}" rel="stylesheet">') if theme.get("fontsHref") else "",
    }
    for src, dst in PAGES.items():
        text = (TEMPLATES / src).read_text(encoding="utf-8")
        for key, val in values.items():
            text = text.replace("{{" + key + "}}", val)
        if "{{" in text:
            sys.exit(f"{src}: unfilled placeholder near {text[text.index('{{'):][:40]!r}")
        (site / dst).write_text(text, encoding="utf-8")
    # Netlify and Cloudflare Pages read _headers: let other sites embed the
    # player by fetching the manifest and layers cross-origin.
    (site / "_headers").write_text("/*\n  Access-Control-Allow-Origin: *\n", encoding="utf-8")
    print(f"built {site} (v={stamp}): " + ", ".join(PAGES.values()))


def check(dive):
    """For each layer, compare the soft shapes of its border band with the
    centre of the layer around it. Low numbers mean an invisible seam."""
    cfg = load(dive)
    layers, S = cfg["layers"], cfg["scale"]
    w, h = cfg["width"] // S, cfg["height"] // S
    band = edge_distance(w, h) < ALPHA_EDGE * 2
    blur = ImageFilter.GaussianBlur(max(1.0, 3.5 * w / 960))
    worst = 0.0
    for i, L in enumerate(layers):
        outer = layers[i - 1]
        big = read(dive / outer["image"], cfg["width"], cfg["height"])
        x0, y0 = (cfg["width"] - w) // 2, (cfg["height"] - h) // 2
        a = np.asarray(big.crop((x0, y0, x0 + w, y0 + h)).filter(blur), np.float32)
        b = np.asarray(read(dive / L["image"], w, h).filter(blur), np.float32)
        err = float(np.abs(a - b)[band].mean())
        worst = max(worst, err)
        verdict = "ok" if err <= SEAM_OK else "visible up close" if err <= SEAM_WARN else "SEAM"
        print(f"  {i:02d} {L['id']:<16} inside {outer['id']:<16} {err:5.1f}  {verdict}")
    print(f"worst {worst:.1f} (ok <= {SEAM_OK}, seam > {SEAM_WARN})")
    return 0 if worst <= SEAM_WARN else 1


def new(dive):
    if (dive / "dive.json").exists():
        sys.exit(f"{dive / 'dive.json'} already exists")
    (dive / "images").mkdir(parents=True, exist_ok=True)
    shutil.copy2(TEMPLATES / "dive.json", dive / "dive.json")
    print(f"{dive / 'dive.json'}: list your layers, put the images in {dive / 'images'}, then python build.py {dive}")


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        sys.exit(__doc__)
    if argv[0] in ("check", "new"):
        if len(argv) != 2:
            sys.exit(__doc__)
        return (check if argv[0] == "check" else new)(Path(argv[1]))
    dive = Path(argv[0])
    site = dive / "site"
    if "--out" in argv:
        if argv.index("--out") + 1 >= len(argv):
            sys.exit(__doc__)
        site = Path(argv[argv.index("--out") + 1])
    build(dive, site)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
