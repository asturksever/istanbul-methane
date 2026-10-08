#!/usr/bin/env python3
"""Pull every Carbon Mapper CH4 plume over the Istanbul area for the last N years.

Usage:
    python3 tools/fetch_istanbul.py                 # last 2 years, whole Istanbul province
    python3 tools/fetch_istanbul.py --years 3 --bbox 27.95 40.75 29.95 41.65 --png

Writes data/istanbul/plumes.json (raw items), plumes.csv (one row per plume),
sources.csv (one row per emitting location: plumes, rated overpasses, mean and
peak t/h, first and last detection) and, with --png, each plume PNG.

Needs network access to api.carbonmapper.org (and the signed PNG host). No API key
is needed for the public catalogue at the time of writing.
"""
import argparse, csv, datetime as dt, json, math, pathlib, sys, time, urllib.parse, urllib.request

API = "https://api.carbonmapper.org/api/v1/catalog/plumes/annotated"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "istanbul"

ap = argparse.ArgumentParser()
ap.add_argument("--years", type=float, default=2.0)
ap.add_argument("--bbox", nargs=4, type=float, default=[27.95, 40.75, 29.95, 41.65], metavar=("W", "S", "E", "N"))
ap.add_argument("--png", action="store_true", help="also download plume PNGs")
ap.add_argument("--cluster-km", type=float, default=1.5, help="group plumes into sources within this distance")
args = ap.parse_args()


def get(url, binary=False):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return r.read() if binary else json.load(r)
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def fetch_all(bbox, since):
    items, offset, limit = [], 0, 500
    while True:
        q = [("bbox", str(v)) for v in bbox] + [("limit", str(limit)), ("offset", str(offset)), ("sort", "desc"), ("datetime", f"{since.isoformat()}Z/..")]
        d = get(API + "?" + urllib.parse.urlencode(q))
        page = d.get("items", [])
        items += page
        if len(page) < limit:
            break
        offset += limit
    return [p for p in items if p.get("gas") == "CH4" and p.get("scene_timestamp", "") >= since.isoformat()]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    since = dt.datetime.utcnow() - dt.timedelta(days=365.25 * args.years)
    items = fetch_all(args.bbox, since)
    (OUT / "plumes.json").write_text(json.dumps(items, indent=1))
    cols = ["plume_id", "scene_timestamp", "platform", "instrument", "sector", "plume_latitude", "plume_longitude", "emission_auto", "emission_uncertainty_auto", "hide_emission", "wind_speed_avg_auto", "wind_direction_avg_auto", "plume_bounds", "plume_png", "con_tif"]
    with (OUT / "plumes.csv").open("w", newline="") as f:
        w = csv.writer(f); w.writerow(cols)
        for p in sorted(items, key=lambda p: p["scene_timestamp"]):
            w.writerow([p.get(c) for c in cols])
    # cluster into sources
    srcs = []
    for p in sorted(items, key=lambda p: p["scene_timestamp"]):
        lat, lon = p["plume_latitude"], p["plume_longitude"]
        for s in srcs:
            d = math.hypot((lon - s["lon"]) * 111.32 * math.cos(math.radians(lat)), (lat - s["lat"]) * 111.32)
            if d <= args.cluster_km:
                s["plumes"].append(p); break
        else:
            srcs.append({"lat": lat, "lon": lon, "plumes": [p]})
    with (OUT / "sources.csv").open("w", newline="") as f:
        w = csv.writer(f); w.writerow(["lat", "lon", "sector", "plumes", "overpasses", "rated", "mean_t_h", "peak_t_h", "peak_date", "first", "last"])
        for s in sorted(srcs, key=lambda s: -len(s["plumes"])):
            ps = s["plumes"]; rated = [p for p in ps if not p.get("hide_emission") and p.get("emission_auto") is not None]
            peak = max(rated, key=lambda p: p["emission_auto"]) if rated else None
            w.writerow([round(sum(p["plume_latitude"] for p in ps) / len(ps), 5), round(sum(p["plume_longitude"] for p in ps) / len(ps), 5), ps[0].get("sector"), len(ps), len({p["scene_timestamp"][:16] for p in ps}), len(rated),
                        round(sum(p["emission_auto"] for p in rated) / len(rated) / 1000, 2) if rated else "", round(peak["emission_auto"] / 1000, 2) if peak else "", peak["scene_timestamp"][:10] if peak else "", ps[0]["scene_timestamp"][:10], ps[-1]["scene_timestamp"][:10]])
    print(f"{len(items)} CH4 plumes since {since:%Y-%m-%d} in bbox {args.bbox}; {len(srcs)} sources -> {OUT}")
    if args.png:
        (OUT / "png").mkdir(exist_ok=True)
        for p in items:
            dest = OUT / "png" / f"{p['plume_id']}.png"
            if not dest.exists() and p.get("plume_png"):
                dest.write_bytes(get(p["plume_png"], binary=True))
        print("PNGs saved")


if __name__ == "__main__":
    main()
