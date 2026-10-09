#!/usr/bin/env python3
"""Refresh plume data from the Carbon Mapper catalogue API.

Pulls every annotated CH4 plume inside each site's bounding box, saves the raw
JSON plus each plume PNG (signed URLs expire within about a day, so download
straight away), and prints a summary.

Writes:
    data/raw/<site>.json
    data/raw/png/<plume_id>.png

Then run tools/invert_plume_png.py to regenerate data/plumes.js.

No API key is needed for the public catalogue at the time of writing.
"""
import json
import pathlib
import urllib.parse
import urllib.request

API = "https://api.carbonmapper.org/api/v1/catalog/plumes/annotated"
SITES = {
    # west, south, east, north
    "silivri": (28.05, 41.15, 28.25, 41.30),  # Silivri landfill
    "sile": (29.30, 41.10, 29.42, 41.19),     # Komurcuoda landfill
}
ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"


def fetch(site, bbox):
    q = [("bbox", str(v)) for v in bbox] + [("limit", "500")]
    url = API + "?" + urllib.parse.urlencode(q)
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def main():
    (RAW / "png").mkdir(parents=True, exist_ok=True)
    for site, bbox in SITES.items():
        d = fetch(site, bbox)
        items = [p for p in d["items"] if p.get("gas") == "CH4"]
        (RAW / f"{site}.json").write_text(json.dumps(items, indent=1))
        print(f"{site}: {len(items)} plumes")
        for p in items:
            dest = RAW / "png" / f"{p['plume_id']}.png"
            if not dest.exists():
                urllib.request.urlretrieve(p["plume_png"], dest)
            rate = "withheld" if p["hide_emission"] or p["emission_auto"] is None else f"{p['emission_auto']/1000:.2f} t/h"
            print(f"  {p['scene_timestamp'][:16]}  {p['platform']:8}  {rate}")


if __name__ == "__main__":
    main()
