#!/usr/bin/env python3
"""
Re-emit the eagerly-loaded hit-test GeoJSONs at much smaller sizes so that
first paint downloads <2 MB of vector data instead of ~22 MB.

These files are only used as invisible polygons for hover hit-testing in
[app/src/App.tsx](app/src/App.tsx) ('country-fills', 'state-borders',
'gdp-state-fills-layer'). Geometric precision finer than ~5 km is therefore
wasted bandwidth.

This script also splits the per-year GDP values out of
`gdp_state_fills.geojson` into a small JSON lookup that is fetched lazily
only when the GDP axis is selected.

Usage:
    /opt/anaconda3/envs/utopia/bin/python pipeline/simplify_geojson.py
    # or, with the conda env active:
    python pipeline/simplify_geojson.py

Inputs (read from):
    data/NaturalEarth/ne_10m_admin_0_countries_dir/ne_10m_admin_0_countries.shp
    data/NaturalEarth/states_10m/ne_10m_admin_1_states_provinces.shp
    app/public/gdp_state_fills.geojson  (uses existing values; geometry resimplified)

Outputs (overwrites):
    app/public/countries.geojson
    app/public/states.geojson
    app/public/gdp_state_fills.geojson
    app/public/gdp_state_scores.json   (NEW: per-state, per-year lookup)
"""

import json
from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PUBLIC = ROOT / "app" / "public"

# Tolerance is in degrees (EPSG:4326). 0.1 deg ~= 10 km at the equator.
# At our max zoom of 10 a single tile is ~40 km wide, so 10 km wiggle on
# borders that are rendered as 1px lines is invisible.
COUNTRY_TOL = 0.1
STATE_TOL = 0.1
GDP_STATE_TOL = 0.1

# Round coordinates to N decimal places when emitting JSON. 4 dp = ~11 m
# at the equator -- far finer than any of our border lines or hit-tests.
COORD_DECIMALS = 4


def _human_size(n_bytes: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n_bytes < 1024:
            return f"{n_bytes:.1f} {unit}"
        n_bytes /= 1024
    return f"{n_bytes:.1f} TB"


def _quantize(coords, dp: int = COORD_DECIMALS):
    """Recursively round floats inside any nested coordinate list."""
    if isinstance(coords, (list, tuple)):
        return [_quantize(c, dp) for c in coords]
    if isinstance(coords, float):
        return round(coords, dp)
    return coords


def _write_geojson(gdf: gpd.GeoDataFrame, out: Path):
    """Emit GeoJSON with rounded coordinates and no whitespace.
    Drops `type=Feature/FeatureCollection` boilerplate? No -- maplibre needs
    a FeatureCollection, but we strip whitespace and quantize coords."""
    if out.exists():
        out.unlink()
    payload = json.loads(gdf.to_json())
    for feat in payload.get("features", []):
        geom = feat.get("geometry")
        if geom and "coordinates" in geom:
            geom["coordinates"] = _quantize(geom["coordinates"])
    with out.open("w") as f:
        json.dump(payload, f, separators=(",", ":"))


def simplify_countries():
    src = DATA / "NaturalEarth" / "ne_10m_admin_0_countries_dir" / "ne_10m_admin_0_countries.shp"
    out = PUBLIC / "countries.geojson"
    print(f"countries: reading {src.name}")
    g = gpd.read_file(src)
    g = g[["NAME", "ISO_A2", "geometry"]].copy()
    g.geometry = g.geometry.simplify(COUNTRY_TOL, preserve_topology=True)
    _write_geojson(g, out)
    print(f"  -> {out}  ({_human_size(out.stat().st_size)}, {len(g)} features)")


def simplify_states():
    # Use the 50m source instead of 10m: it ships ~20x less geometry detail
    # for the same number of features, which is plenty for state-border
    # rendering at our zoom levels.
    src = DATA / "NaturalEarth" / "states_polygons" / "ne_50m_admin_1_states_provinces.shp"
    out = PUBLIC / "states.geojson"
    print(f"states: reading {src.name}")
    g = gpd.read_file(src)
    # No properties needed -- this layer is rendered as borders only.
    g = g[["geometry"]].copy()
    g.geometry = g.geometry.simplify(STATE_TOL, preserve_topology=True)
    _write_geojson(g, out)
    print(f"  -> {out}  ({_human_size(out.stat().st_size)}, {len(g)} features)")


def simplify_gdp_state_fills():
    """Split values out so the geometry can be aggressively simplified
    independently and the per-year numbers can be cached separately.

    Idempotent: if gdp_state_fills.geojson already had its value columns
    stripped on a previous run, we skip score regeneration and just
    re-simplify the geometry. Re-run pipeline/calculate_gdp_aggregates.py
    upstream if the underlying numbers ever need to change.
    """
    src = PUBLIC / "gdp_state_fills.geojson"
    out_geo = PUBLIC / "gdp_state_fills.geojson"
    out_scores = PUBLIC / "gdp_state_scores.json"
    print(f"gdp_state_fills: reading {src.name}")
    g = gpd.read_file(src)

    year_cols = [c for c in g.columns if c.startswith("gdp_pc_")]
    if not year_cols:
        if out_scores.exists():
            print(f"  no gdp_pc_<year> columns in geojson; reusing existing {out_scores.name}")
            keep_cols = [c for c in ("name", "admin", "iso_3166_2") if c in g.columns]
            g_geo = g[keep_cols + ["geometry"]].copy()
            g_geo.geometry = g_geo.geometry.simplify(GDP_STATE_TOL, preserve_topology=True)
            _write_geojson(g_geo, out_geo)
            print(f"  -> {out_geo}  ({_human_size(out_geo.stat().st_size)}, {len(g_geo)} features)")
            return
        raise RuntimeError(
            f"No gdp_pc_<year> columns in {src} and no {out_scores.name} to reuse. "
            "Run pipeline/calculate_gdp_aggregates.py first to regenerate the source."
        )
    print(f"  found year columns: {year_cols}")

    # Build the lookup: { "<iso_3166_2 or fallback>": { "2000": 14181, ... } }
    scores: dict[str, dict[str, float]] = {}
    seen_keys: set[str] = set()
    dup_count = 0
    missing_key_count = 0
    for _, row in g.iterrows():
        key = row.get("iso_3166_2")
        if not key or (isinstance(key, float) and key != key):  # NaN check
            # Fallback synthetic key: ADM0_A3 + name. Avoids collisions while
            # still being deterministic across rebuilds.
            adm0 = row.get("adm0_a3") or row.get("admin") or "??"
            name = row.get("name") or "?"
            key = f"{adm0}::{name}"
            missing_key_count += 1
        if key in seen_keys:
            # Duplicate key -- append a counter so we don't lose data
            i = 2
            while f"{key}#{i}" in seen_keys:
                i += 1
            key = f"{key}#{i}"
            dup_count += 1
        seen_keys.add(key)
        entry: dict[str, float] = {}
        for col in year_cols:
            val = row[col]
            if val is None or (isinstance(val, float) and val != val):
                continue
            yr = col.removeprefix("gdp_pc_")
            entry[yr] = round(float(val), 1)
        if entry:
            scores[key] = entry

    if missing_key_count:
        print(f"  WARN: {missing_key_count} features had no iso_3166_2; used synthetic key")
    if dup_count:
        print(f"  WARN: {dup_count} duplicate iso_3166_2 keys disambiguated with #N suffix")

    with out_scores.open("w") as f:
        json.dump(scores, f, separators=(",", ":"))
    print(f"  -> {out_scores}  ({_human_size(out_scores.stat().st_size)}, {len(scores)} entries)")

    # Now simplify the geometry and keep only the keys needed for hover lookup.
    # `name` and `admin` are still shown in the tooltip; `iso_3166_2` is the
    # join key into the scores file. Drop the bulky per-year columns.
    keep_cols = [c for c in ("name", "admin", "iso_3166_2") if c in g.columns]
    g_geo = g[keep_cols + ["geometry"]].copy()
    g_geo.geometry = g_geo.geometry.simplify(GDP_STATE_TOL, preserve_topology=True)
    _write_geojson(g_geo, out_geo)
    print(f"  -> {out_geo}  ({_human_size(out_geo.stat().st_size)}, {len(g_geo)} features)")


def main():
    PUBLIC.mkdir(parents=True, exist_ok=True)
    simplify_countries()
    simplify_states()
    simplify_gdp_state_fills()
    print("\nDone.")


if __name__ == "__main__":
    main()
