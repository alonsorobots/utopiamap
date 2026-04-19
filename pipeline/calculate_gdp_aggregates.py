#!/usr/bin/env python3
"""
Compute tiered GDP per capita aggregates so the app can show country / state /
district values that update with map zoom (mirroring how Cost-of-Living already
behaves).

Tiers and sources, chosen for scientific defensibility (see chat history):
  - Country (ADM0)  : World Bank NY.GDP.PCAP.PP.KD (constant 2021 PPP $).
                      The canonical, harmonized national figure.
  - State   (ADM1)  : Population-weighted mean of Kummu et al. gridded GDP
                      per capita inside each Natural Earth ADM1 polygon, then
                      RESCALED so each country's pop-weighted ADM1 mean exactly
                      matches the World Bank country value for that year.
                      The rescale guarantees country/state tiers reconcile.
  - District (ADM2) : The local Kummu pixel value (already shipped as the
                      heatmap raster). The ADM2 polygon name comes from the
                      existing geoBoundariesCGAZ_ADM2 vector tiles.

LandScan provides the population weights (matching year, resampled to the
Kummu grid). Years processed match the gdp catalog snapshots so the heatmap,
country tooltip and state tooltip all refer to the same year.

Outputs:
  app/public/gdp_country_scores.json   { year: { country_name: value } }
  app/public/gdp_state_fills.geojson   ADM1 polygons + gdp_pc_<year> properties

Usage:
    python pipeline/calculate_gdp_aggregates.py
"""

from __future__ import annotations

import json
import math
import urllib.request
from pathlib import Path
from typing import Dict

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.warp import reproject

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PUBLIC = ROOT / "app" / "public"

GDP_RASTER = DATA / "GriddedGDP" / "rast_adm2_gdp_perCapita_1990_2024.tif"
LANDSCAN_DIR = DATA / "LandScan"
ADM0_SHP = DATA / "NaturalEarth" / "ne_10m_admin_0_countries_dir" / "ne_10m_admin_0_countries.shp"
ADM1_SHP = DATA / "NaturalEarth" / "states_10m" / "ne_10m_admin_1_states_provinces.shp"

WB_CACHE = DATA / "WorldBank" / "gdp_per_capita_kd_full.json"
WB_INDICATOR = "NY.GDP.PCAP.PP.KD"  # constant 2021 international $

OUT_COUNTRY = PUBLIC / "gdp_country_scores.json"
OUT_STATES = PUBLIC / "gdp_state_fills.geojson"

KUMMU_BASE_YEAR = 1990  # band 1 = 1990
TARGET_YEARS = [2000, 2005, 2010, 2015, 2020, 2024]


# ---------------------------------------------------------------------------
# World Bank: country-tier values
# ---------------------------------------------------------------------------

def fetch_wb_history() -> dict:
    """Download (or load cached) WB GDP per capita PPP, constant 2021$.

    Returns the raw JSON list as the WB API returns it. We cache to disk so
    subsequent runs are offline-friendly.
    """
    if WB_CACHE.exists():
        with open(WB_CACHE, "r", encoding="utf-8") as f:
            return json.load(f)

    print(f"  Downloading WB indicator {WB_INDICATOR} (1990-2024)...")
    url = (
        f"https://api.worldbank.org/v2/country/all/indicator/{WB_INDICATOR}"
        f"?date=1990:2024&format=json&per_page=20000"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "utopia/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    WB_CACHE.parent.mkdir(parents=True, exist_ok=True)
    with open(WB_CACHE, "w", encoding="utf-8") as f:
        json.dump(data, f)
    print(f"  Cached -> {WB_CACHE.relative_to(ROOT)}")
    return data


def parse_wb_by_iso3_year(raw: list) -> Dict[str, Dict[int, float]]:
    """Return {iso3: {year: value}} from a WB API v2 response."""
    if not isinstance(raw, list) or len(raw) < 2:
        return {}

    out: Dict[str, Dict[int, float]] = {}
    for entry in raw[1] or []:
        iso3 = (entry.get("countryiso3code") or "").strip()
        if len(iso3) != 3:  # skip aggregates (EU, World, income groups)
            continue
        if entry.get("value") is None:
            continue
        try:
            yr = int(entry["date"])
            val = float(entry["value"])
        except (TypeError, ValueError):
            continue
        out.setdefault(iso3, {})[yr] = val
    return out


# ---------------------------------------------------------------------------
# Raster zonal aggregation helpers
# ---------------------------------------------------------------------------

def landscan_path_for(year: int) -> Path | None:
    """Pick the closest available LandScan year (raw or processed)."""
    candidates = sorted(LANDSCAN_DIR.glob("landscan-global-*.tif"))
    if not candidates:
        return None
    by_year: dict[int, Path] = {}
    for p in candidates:
        # filenames look like landscan-global-2010.tif or landscan-global-2010-processed.tif
        stem = p.stem
        token = stem.split("-")[2]  # the year
        try:
            y = int(token)
        except ValueError:
            continue
        # Prefer the raw original over processed (both are population counts)
        existing = by_year.get(y)
        if existing is None or "processed" in existing.name:
            by_year[y] = p
    if not by_year:
        return None
    closest = min(by_year.keys(), key=lambda y: abs(y - year))
    return by_year[closest]


def resample_landscan_to_grid(landscan_tif: Path, ref_profile: dict,
                               ref_shape: tuple) -> np.ndarray:
    """Resample a LandScan raster to match the Kummu grid (sum-conserving).

    Population is a count quantity, so we use 'sum' resampling when going to a
    coarser grid. Returns a float64 array of population per Kummu cell.
    """
    h, w = ref_shape
    dst = np.zeros((h, w), dtype=np.float64)

    with rasterio.open(landscan_tif) as src:
        # 'sum' resampling preserves total population when downsampling.
        # Available in GDAL >=3.1 and rasterio's WarpedVRT.
        try:
            method = Resampling.sum
        except AttributeError:  # very old rasterio
            method = Resampling.average

        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=ref_profile["transform"],
            dst_crs=ref_profile["crs"],
            resampling=method,
        )

    # LandScan uses huge negative nodata; clip negatives to 0.
    dst[~np.isfinite(dst)] = 0
    dst[dst < 0] = 0
    return dst


def rasterize_zones(gdf: gpd.GeoDataFrame, shape: tuple, transform) -> np.ndarray:
    """Rasterize polygons to an int32 zone-id grid. -1 means no zone."""
    h, w = shape
    shapes = ((geom, idx) for idx, geom in enumerate(gdf.geometry, start=0)
              if geom is not None and not geom.is_empty)
    raster = rasterize(
        shapes=shapes,
        out_shape=(h, w),
        transform=transform,
        fill=-1,
        dtype="int32",
        all_touched=False,
    )
    return raster


def pop_weighted_means(gdp: np.ndarray, pop: np.ndarray, zones: np.ndarray,
                       n_zones: int) -> tuple[np.ndarray, np.ndarray]:
    """Compute pop-weighted mean and total population per zone.

    Returns (means, pop_totals). Both shape (n_zones,). Cells with NaN gdp are
    excluded from BOTH the numerator and denominator (so a zone made entirely
    of nodata returns NaN mean, 0 pop).
    """
    valid = (zones >= 0) & np.isfinite(gdp) & (pop > 0)
    z = zones[valid].astype(np.int64)
    g = gdp[valid].astype(np.float64)
    p = pop[valid].astype(np.float64)

    pop_sum = np.bincount(z, weights=p, minlength=n_zones)
    gdp_x_pop = np.bincount(z, weights=g * p, minlength=n_zones)

    means = np.full(n_zones, np.nan, dtype=np.float64)
    nz = pop_sum > 0
    means[nz] = gdp_x_pop[nz] / pop_sum[nz]
    return means, pop_sum


# ---------------------------------------------------------------------------
# Country-name harmonization between WB / NaturalEarth / our app GeoJSON
# ---------------------------------------------------------------------------

# NaturalEarth NAME -> ISO3, fallback for cases where ADM0_A3 is bogus.
# Most countries are fine; only list real overrides.
WB_TO_NE_NAME = {
    "United States": "United States of America",
    "Bahamas, The": "The Bahamas",
    "Brunei Darussalam": "Brunei",
    "Congo, Dem. Rep.": "Dem. Rep. Congo",
    "Congo, Rep.": "Republic of the Congo",
    "Cote d'Ivoire": "Ivory Coast",
    "Czechia": "Czechia",
    "Egypt, Arab Rep.": "Egypt",
    "Gambia, The": "The Gambia",
    "Hong Kong SAR, China": "Hong Kong S.A.R.",
    "Iran, Islamic Rep.": "Iran",
    "Korea, Dem. People's Rep.": "North Korea",
    "Korea, Rep.": "South Korea",
    "Kyrgyz Republic": "Kyrgyzstan",
    "Lao PDR": "Laos",
    "Macao SAR, China": "Macao S.A.R",
    "Micronesia, Fed. Sts.": "Federated States of Micronesia",
    "Russian Federation": "Russia",
    "Slovak Republic": "Slovakia",
    "St. Kitts and Nevis": "Saint Kitts and Nevis",
    "St. Lucia": "Saint Lucia",
    "St. Vincent and the Grenadines": "Saint Vincent and the Grenadines",
    "Syrian Arab Republic": "Syria",
    "Tanzania": "United Republic of Tanzania",
    "Turkiye": "Turkey",
    "Venezuela, RB": "Venezuela",
    "Viet Nam": "Vietnam",
    "Yemen, Rep.": "Yemen",
}


def build_iso3_to_ne_name(ne0: gpd.GeoDataFrame) -> Dict[str, str]:
    """Map ISO3 -> NaturalEarth NAME (used by the app's hover layer)."""
    iso3_to_name: Dict[str, str] = {}
    for _, row in ne0.iterrows():
        iso3 = (row.get("ADM0_A3") or "").strip().upper()
        name = (row.get("NAME") or "").strip()
        if not iso3 or not name:
            continue
        # ADM0_A3 has some "junk" values (e.g. 'CYN' for unrecognised); only
        # accept 3-letter codes that look real.
        if len(iso3) == 3 and iso3.isalpha():
            iso3_to_name.setdefault(iso3, name)
    return iso3_to_name


def build_wb_to_ne_name(wb_iso3_to_year_value: Dict[str, Dict[int, float]],
                         iso3_to_ne_name: Dict[str, str],
                         wb_iso3_to_wb_name: Dict[str, str]) -> Dict[str, str]:
    """Map WB country name (as it appears in the JSON) -> NE NAME."""
    out: Dict[str, str] = {}
    for iso3 in wb_iso3_to_year_value.keys():
        wb_name = wb_iso3_to_wb_name.get(iso3, "")
        ne_name = iso3_to_ne_name.get(iso3.upper())
        if not ne_name:
            ne_name = WB_TO_NE_NAME.get(wb_name, wb_name)
        out[iso3] = ne_name
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=== GDP TIERED AGGREGATES ===")

    if not GDP_RASTER.exists():
        raise SystemExit(f"Missing {GDP_RASTER}")
    if not ADM0_SHP.exists():
        raise SystemExit(f"Missing {ADM0_SHP}")
    if not ADM1_SHP.exists():
        raise SystemExit(f"Missing {ADM1_SHP}")

    # --- Load WB country values ---
    print("\n[1/5] World Bank country values")
    raw = fetch_wb_history()
    wb_iso3_year = parse_wb_by_iso3_year(raw)
    wb_iso3_to_name = {
        (e.get("countryiso3code") or "").strip(): (e.get("country") or {}).get("value", "")
        for e in (raw[1] or [])
        if (e.get("countryiso3code") or "").strip()
    }
    print(f"      {len(wb_iso3_year)} countries with WB time series")

    # --- Load polygons ---
    print("\n[2/5] Loading polygons")
    ne0 = gpd.read_file(ADM0_SHP)[["NAME", "ADM0_A3", "geometry"]]
    ne0["ADM0_A3"] = ne0["ADM0_A3"].fillna("").astype(str).str.upper()
    print(f"      ADM0: {len(ne0)} polygons")

    ne1_full = gpd.read_file(ADM1_SHP)
    keep_cols = ["name", "admin", "iso_a2", "iso_3166_2", "adm0_a3", "geometry"]
    ne1 = ne1_full[[c for c in keep_cols if c in ne1_full.columns]].copy()
    if "adm0_a3" in ne1.columns:
        ne1["adm0_a3"] = ne1["adm0_a3"].fillna("").astype(str).str.upper()
    print(f"      ADM1: {len(ne1)} polygons")

    iso3_to_ne_name = build_iso3_to_ne_name(ne0)
    wb_to_ne_name = build_wb_to_ne_name(wb_iso3_year, iso3_to_ne_name, wb_iso3_to_name)

    # --- Open Kummu raster (we'll read each year as a band) ---
    print("\n[3/5] Opening Kummu GDP raster")
    src_gdp = rasterio.open(GDP_RASTER)
    ref_profile = src_gdp.profile.copy()
    ref_shape = (src_gdp.height, src_gdp.width)
    print(f"      grid: {src_gdp.width}x{src_gdp.height}, bands 1..{src_gdp.count}")

    # Rasterize ADM1 zones once (geometry doesn't change with year)
    print("      Rasterizing ADM1 zones onto Kummu grid...")
    adm1_zones = rasterize_zones(ne1, ref_shape, src_gdp.transform)
    print(f"      ADM1 raster: {(adm1_zones >= 0).sum():,} cells assigned to {len(ne1)} zones")

    print("      Rasterizing ADM0 zones onto Kummu grid...")
    adm0_zones = rasterize_zones(ne0, ref_shape, src_gdp.transform)
    print(f"      ADM0 raster: {(adm0_zones >= 0).sum():,} cells assigned to {len(ne0)} zones")

    # NE country index (row position) -> ISO3 lookup, for cross-walking to WB
    ne0_iso3 = ne0["ADM0_A3"].tolist()
    ne0_name = ne0["NAME"].tolist()

    # --- Per-year aggregation ---
    print("\n[4/5] Per-year aggregation")
    state_props_per_year: dict[int, np.ndarray] = {}
    country_scores: dict[int, dict[str, float]] = {}

    for year in TARGET_YEARS:
        print(f"\n      --- {year} ---")
        band_idx = year - KUMMU_BASE_YEAR + 1
        if not (1 <= band_idx <= src_gdp.count):
            print(f"      SKIP {year}: band {band_idx} out of range")
            continue

        gdp_arr = src_gdp.read(band_idx).astype(np.float32)
        gdp_arr[gdp_arr <= 0] = np.nan

        ls_path = landscan_path_for(year)
        if ls_path is None:
            print(f"      ERROR: no LandScan raster found for {year}")
            continue
        print(f"      LandScan: {ls_path.name}")
        pop = resample_landscan_to_grid(ls_path, ref_profile, ref_shape)
        print(f"      total pop on grid: {pop.sum():,.0f}")

        # ADM1 pop-weighted mean
        adm1_means, adm1_pop = pop_weighted_means(gdp_arr, pop, adm1_zones, len(ne1))

        # ADM0 pop-weighted Kummu mean (used to compute the rescale factor)
        adm0_means, adm0_pop = pop_weighted_means(gdp_arr, pop, adm0_zones, len(ne0))

        # Compute per-country rescale factor:  factor = WB / Kummu_country
        rescale_by_country_idx: dict[int, float] = {}
        wb_value_by_ne_name: dict[str, float] = {}

        matched = 0
        for ne_idx, iso3 in enumerate(ne0_iso3):
            wb_val = wb_iso3_year.get(iso3, {}).get(year)
            if wb_val is None or not math.isfinite(wb_val):
                # Fallback: try any WB country whose mapped NE name == this name
                for wbiso3, ne_name in wb_to_ne_name.items():
                    if ne_name == ne0_name[ne_idx]:
                        wb_val = wb_iso3_year.get(wbiso3, {}).get(year)
                        if wb_val is not None and math.isfinite(wb_val):
                            break
            if wb_val is None or not math.isfinite(wb_val):
                continue
            wb_value_by_ne_name[ne0_name[ne_idx]] = float(wb_val)
            kummu_val = adm0_means[ne_idx]
            if math.isfinite(kummu_val) and kummu_val > 0:
                rescale_by_country_idx[ne_idx] = float(wb_val) / float(kummu_val)
                matched += 1

        print(f"      WB matched to {matched}/{len(ne0)} ADM0 polygons")
        country_scores[year] = wb_value_by_ne_name

        # Build a per-ADM1 rescale lookup by joining ADM1 -> ADM0 by ISO3 / ADMIN
        adm1_iso3 = ne1["adm0_a3"].tolist() if "adm0_a3" in ne1.columns else [""] * len(ne1)
        adm1_admin = ne1["admin"].tolist() if "admin" in ne1.columns else [""] * len(ne1)
        ne_iso3_to_idx = {iso3: i for i, iso3 in enumerate(ne0_iso3) if iso3}
        ne_name_to_idx = {n: i for i, n in enumerate(ne0_name)}

        rescaled_state = np.full(len(ne1), np.nan, dtype=np.float64)
        for s_idx in range(len(ne1)):
            kummu_state_val = adm1_means[s_idx]
            if not math.isfinite(kummu_state_val):
                continue
            iso3 = adm1_iso3[s_idx].upper() if adm1_iso3[s_idx] else ""
            country_idx = ne_iso3_to_idx.get(iso3)
            if country_idx is None:
                country_idx = ne_name_to_idx.get(adm1_admin[s_idx])
            factor = rescale_by_country_idx.get(country_idx) if country_idx is not None else None
            if factor is None or not math.isfinite(factor) or factor <= 0:
                # No WB anchor -> trust Kummu pop-weighted mean as-is.
                rescaled_state[s_idx] = kummu_state_val
            else:
                rescaled_state[s_idx] = kummu_state_val * factor

        state_props_per_year[year] = rescaled_state

        finite = np.isfinite(rescaled_state)
        if finite.any():
            print(f"      ADM1 with values: {finite.sum()}/{len(ne1)}, "
                  f"min={np.nanmin(rescaled_state):,.0f}, "
                  f"med={np.nanmedian(rescaled_state):,.0f}, "
                  f"max={np.nanmax(rescaled_state):,.0f}")

    src_gdp.close()

    # --- Write outputs ---
    print("\n[5/5] Writing outputs")

    # 5a. Country scores JSON
    country_payload = {
        str(yr): {name: round(val, 0) for name, val in scores.items()}
        for yr, scores in country_scores.items()
    }
    OUT_COUNTRY.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_COUNTRY, "w", encoding="utf-8") as f:
        json.dump(country_payload, f, separators=(",", ":"))
    print(f"      {OUT_COUNTRY.relative_to(ROOT)}: "
          f"{OUT_COUNTRY.stat().st_size / 1024:.0f} KB, "
          f"{len(country_payload)} years")

    # 5b. State fills GeoJSON
    export_cols = ["name", "admin", "iso_a2", "iso_3166_2", "adm0_a3"]
    export_cols = [c for c in export_cols if c in ne1.columns]
    out_gdf = ne1[export_cols + ["geometry"]].copy()

    # attach gdp_pc_<year>
    keep_mask = np.zeros(len(ne1), dtype=bool)
    for yr, vals in state_props_per_year.items():
        col = f"gdp_pc_{yr}"
        # Round and convert NaN -> None for JSON
        col_vals = [int(round(v)) if math.isfinite(v) else None for v in vals]
        out_gdf[col] = col_vals
        keep_mask |= np.array([v is not None for v in col_vals])

    # Drop ADM1 polygons that have no values in any year (saves ~30%)
    out_gdf = out_gdf.loc[keep_mask].copy()
    print(f"      keeping {len(out_gdf)} ADM1 polygons with at least one year of data")

    # Simplify geometry (same tolerance Cost uses)
    out_gdf["geometry"] = out_gdf.geometry.simplify(0.05, preserve_topology=True)

    if OUT_STATES.exists():
        OUT_STATES.unlink()
    out_gdf.to_file(OUT_STATES, driver="GeoJSON")
    print(f"      {OUT_STATES.relative_to(ROOT)}: "
          f"{OUT_STATES.stat().st_size / 1024 / 1024:.2f} MB")

    print("\nDone.")


if __name__ == "__main__":
    main()
