#!/usr/bin/env python3
"""Build depv_lookup.json so the Deprivation axis can show a per-region
HDI breakdown on hover (Health / Education / Income).

Inputs:
  data/SHDI/SHDI-SGDI-Total-8.0.csv     -- CSV from PRIO mirror of Global
                                            Data Lab v8.x (1990-2022).
  data/SHDI/shapefile/gdl.shp           -- GDL admin polygons keyed by
                                            GDLCODE.

Output:
  app/public/depv_lookup.json           -- {regions: {id: {country, region,
                                            shdi, health, education, income,
                                            lifexp, esch_yrs, gnic}},
                                            grid: {res, w, h, ids: [int...]}}

We pick the *latest* year available per region (typically 2022) and rasterize
GDLCODE membership at LOOKUP_RES (0.25 deg ~ 25 km, plenty for admin units).
The regions table maps a small int id to all the indicator values, so the
client-side hover lookup is just (lat, lng) -> grid index -> int id ->
regions table.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
from rasterio.features import rasterize as rio_rasterize
from rasterio.transform import from_bounds

ROOT = Path(__file__).resolve().parent.parent
SHDI_DIR = ROOT / "data" / "SHDI"
CSV_PATH = SHDI_DIR / "SHDI-SGDI-Total-8.0.csv"
SHP_PATH = SHDI_DIR / "shapefile" / "gdl.shp"
OUT_PATH = ROOT / "app" / "public" / "depv_lookup.json"

LOOKUP_RES = 0.25                    # degrees, ~25 km at equator
LOOKUP_W = int(360 / LOOKUP_RES)     # 1440
LOOKUP_H = int(180 / LOOKUP_RES)     # 720


def _f(s: str) -> float | None:
    s = (s or "").strip()
    if not s or s == ".":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def load_shdi_latest() -> dict[str, dict]:
    """{GDLCODE -> {country, region, year, shdi, health, education, income,
                    lifexp, esch_yrs, gnic}} using each region's latest year."""
    by_code: dict[str, dict] = {}
    with open(CSV_PATH) as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("level") != "Subnat":
                continue
            code = row.get("GDLCODE")
            if not code:
                continue
            try:
                year = int(row.get("year", "0"))
            except ValueError:
                continue
            shdi = _f(row.get("shdi"))
            if shdi is None:
                continue
            existing = by_code.get(code)
            if existing and existing["year"] >= year:
                continue
            by_code[code] = {
                "country": row.get("country", ""),
                "region": row.get("region", ""),
                "year": year,
                "shdi":      shdi,
                "health":    _f(row.get("healthindex")),
                "education": _f(row.get("edindex")),
                "income":    _f(row.get("incindex")),
                "lifexp":    _f(row.get("lifexp")),
                "esch_yrs":  _f(row.get("esch")),
                "gnic":      _f(row.get("gnic")),
            }
    return by_code


def main() -> None:
    print(f"Loading SHDI CSV ...")
    shdi = load_shdi_latest()
    print(f"  {len(shdi)} subnat regions with shdi values")

    print(f"Loading GDL shapefile ...")
    gdf = gpd.read_file(SHP_PATH)
    print(f"  {len(gdf)} polygons")

    print(f"Joining and assigning compact integer ids ...")
    regions: dict[int, dict] = {}
    shapes: list[tuple] = []
    next_id = 1
    code_to_id: dict[str, int] = {}
    skipped = 0
    for _, row in gdf.iterrows():
        code = str(row["gdlcode"]).strip()
        rec = shdi.get(code)
        if not rec:
            skipped += 1
            continue
        rid = code_to_id.get(code)
        if rid is None:
            rid = next_id
            next_id += 1
            code_to_id[code] = rid
            regions[rid] = {
                "country":   rec["country"],
                "region":    rec["region"],
                "year":      rec["year"],
                "shdi":      rec["shdi"],
                "health":    rec["health"],
                "education": rec["education"],
                "income":    rec["income"],
                "lifexp":    rec["lifexp"],
                "esch_yrs":  rec["esch_yrs"],
                "gnic":      rec["gnic"],
            }
        shapes.append((row.geometry, rid))
    print(f"  {len(regions)} matched regions, {skipped} polygons without SHDI")

    print(f"Rasterizing {len(shapes)} polygons at {LOOKUP_W}x{LOOKUP_H} ...")
    transform = from_bounds(-180, -90, 180, 90, LOOKUP_W, LOOKUP_H)
    grid = rio_rasterize(
        shapes,
        out_shape=(LOOKUP_H, LOOKUP_W),
        transform=transform,
        fill=0,
        dtype=np.int32,
        all_touched=True,   # also fill cells whose edges are clipped by the
                            # polygon boundary, so coastal cities (SF, NYC,
                            # Tokyo, etc.) don't fall in the gap
    )
    print(f"  non-zero cells: {(grid > 0).sum()} / {grid.size} ({100*(grid>0).mean():.1f}%)")

    out = {
        "v": 1,
        "regions": {str(rid): r for rid, r in regions.items()},
        "grid": {
            "res": LOOKUP_RES,
            "w":   LOOKUP_W,
            "h":   LOOKUP_H,
            "ids": grid.flatten().tolist(),
        },
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f)
    sz = OUT_PATH.stat().st_size / 1024
    print(f"Wrote {OUT_PATH.relative_to(ROOT)} ({sz:.1f} KB)")


if __name__ == "__main__":
    main()
