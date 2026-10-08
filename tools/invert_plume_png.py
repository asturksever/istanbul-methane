#!/usr/bin/env python3
"""Rebuild data/plumes.js from data/raw (output of fetch_plumes.py).

Carbon Mapper's plume PNGs are colour-mapped with a blue-to-red ramp very close
to Google's Turbo. Each opaque pixel is matched to the nearest Turbo colour to
recover a 0..1 enhancement value, block-averaged down to at most 90 px, then
quantised to 16 levels (one hex char per cell) and run-length encoded:
    '.'     one transparent cell
    '~N;'   N transparent cells
    0-f     enhancement level

Output format (consumed by src/template.html):
    PLUMES = [[plume_id, site, "YYYY-MM-DDTHH:MM", platform, lon, lat,
               emission_kg_h|null, uncertainty_kg_h|null, wind_m_s,
               wind_dir_deg, [w, s, e, n], image_index], ...]
    IMGS   = [[width, height, rle_string], ...]

Note: the original data/plumes.js was produced by the same algorithm running in
the browser, so a rebuild should match closely but not byte for byte.

Requires: pip install pillow numpy
"""
import json
import math
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
MAX_DIM = 90


def turbo(t):
    r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))))
    g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))))
    b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))))
    return np.clip(np.array([r, g, b]) * 255, 0, 255)


LUT = np.stack([turbo(i / 255) for i in range(256)])  # (256, 3)


def invert(path):
    a = np.asarray(Image.open(path).convert("RGBA")).astype(float)
    h, w = a.shape[:2]
    rgb, alpha = a[..., :3].reshape(-1, 3), a[..., 3].reshape(-1)
    d = ((rgb[:, None, :] - LUT[None]) ** 2).sum(-1)
    val = d.argmin(1) / 255.0
    val[alpha < 10] = -1
    grid = val.reshape(h, w)
    f = max(1, math.ceil(max(w, h) / MAX_DIM))
    W, H = math.ceil(w / f), math.ceil(h / f)
    out, run = [], 0
    for y in range(H):
        for x in range(W):
            blk = grid[y * f:(y + 1) * f, x * f:(x + 1) * f]
            ok = blk[blk >= 0]
            if ok.size * 2 < blk.size:
                run += 1
                continue
            if run:
                out.append("." * run if run < 3 else f"~{run};")
                run = 0
            out.append("0123456789abcdef"[min(15, int(ok.mean() * 16))])
    return [W, H, "".join(out)]


def main():
    plumes, imgs = [], []
    for site in ("silivri", "sile"):
        for p in json.loads((RAW / f"{site}.json").read_text()):
            lon, lat = p["geometry_json"]["coordinates"]
            hidden = p["hide_emission"] or p["emission_auto"] is None
            imgs.append(invert(RAW / "png" / f"{p['plume_id']}.png"))
            plumes.append([
                p["plume_id"], site, p["scene_timestamp"][:16], p["platform"],
                round(lon, 5), round(lat, 5),
                None if hidden else round(p["emission_auto"]),
                None if hidden else round(p["emission_uncertainty_auto"]),
                round(p["wind_speed_avg_auto"] or 0, 1), round(p["wind_direction_avg_auto"] or 0),
                [round(v, 5) for v in p["plume_bounds"]], len(imgs) - 1,
            ])
    js = "const PLUMES=" + json.dumps(plumes, separators=(",", ":")) + ";\nconst IMGS=" + json.dumps(imgs, separators=(",", ":")) + ";\n"
    (ROOT / "data" / "plumes.js").write_text(js)
    print(f"wrote data/plumes.js: {len(plumes)} plumes")


if __name__ == "__main__":
    main()
