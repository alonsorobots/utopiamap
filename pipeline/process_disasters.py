#!/usr/bin/env python3
"""
Disaster mortality pipeline.

Builds 8 individual hazard mortality rasters (deaths per million per year)
plus a composite, plus a low-res risk_lookup.json with per-pixel breakdown
for hover display.

Method: For each hazard h:
  - country_baseline R_hc = average annual deaths from EM-DAT (1980-2020) /
                            country population × 1e6   (deaths/M/yr)
  - per-pixel intensity H_hp from the hazard raster (e.g. PGA, depth, wind)
  - per-pixel rate r_hp = R_hc × H_hp / mean(H_hc)
                            with cap at 5 × R_hc to avoid blowups

Composite mortality = sum across hazards.

Inputs (under data/Hazard/):
  - gem/v2023_1_pga_475_rock_3min.tif       earthquake intensity (~5km)
  - jrc_flood/floodMapGL_rp100y.tif         flood depth 100yr (~1km)
  - storm_constant_100yr.tif                cyclone wind 100yr (~10km)
  - globalPTHA.txt                          tsunami runup at coastal points
  - gvp_holocene_volcanoes.csv              volcano list (locations)
  - spei/spei_12_eh.nc + spei_12_wh.nc      drought (0.5 degree)
  - ../ETOPO/ETOPO_2022_v1_60s_*.tif        elevation (for slope, landslide)
  - decadal_deaths_by_type.csv              EM-DAT/OWID country×decade×hazard deaths
  - population_2020.csv                     country population
"""

from __future__ import annotations

import csv
import json
import math
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HAZARD = DATA / "Hazard"
TILES = DATA / "tiles"

TARGET_RES = 0.05               # ~5 km grid for all hazard rasters
TARGET_W = int(360 / TARGET_RES) # 7200
TARGET_H = int(180 / TARGET_RES) # 3600

LOOKUP_RES = 0.5                # 0.5 deg lookup grid for hover (~720 x 360)
LOOKUP_W = int(360 / LOOKUP_RES)
LOOKUP_H = int(180 / LOOKUP_RES)

# Cap mortality rate per pixel to avoid pathological hot-spots
CAP_MULTIPLIER = 5.0
# Composite is clipped to display max
COMPOSITE_DISPLAY_MAX = 200.0   # deaths/M/yr; anything beyond capped for color

# OWID column -> our hazard key (subset we care about)
OWID_HAZARD_COL = {
    "earthquake": "Earthquakes",
    "flood":      "Floods",
    "cyclone":    "Storms",
    "drought":    "Droughts",
    "wildfire":   "Wildfires",
    "volcano":    "Volcanoes",
    "landslide":  "Mass movement (wet)",  # plus Mass movements (dry)
    # tsunami has no separate column in OWID/EM-DAT (lumped into Earthquakes)
    # we reserve a small fixed budget for it (see TSUNAMI_GLOBAL_DEATHS below)
}

# Globally averaged annual tsunami fatalities (excluding 2004 outlier).
# Background ~1500/yr including 2011 Tohoku. Distribute spatially via PTHA.
TSUNAMI_GLOBAL_DEATHS_PER_YEAR = 1500.0

HAZARDS = [
    "earthquake",
    "flood",
    "cyclone",
    "tsunami",
    "volcano",
    "drought",
    "wildfire",
    "landslide",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ensure(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def warp_to_target(src: Path, dst: Path, resampling: str = "bilinear", nodata: float | None = None):
    cmd = [
        "gdalwarp", "-t_srs", "EPSG:4326",
        "-te", "-180", "-90", "180", "90",
        "-ts", str(TARGET_W), str(TARGET_H),
        "-r", resampling, "-overwrite",
    ]
    if nodata is not None:
        cmd.extend(["-srcnodata", str(nodata)])
    cmd.extend([str(src), str(dst)])
    subprocess.run(cmd, check=True, capture_output=True)


def write_raster(arr: np.ndarray, dst: Path, nodata: float = -9999.0):
    transform = from_bounds(-180, -90, 180, 90, TARGET_W, TARGET_H)
    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "width": TARGET_W,
        "height": TARGET_H,
        "count": 1,
        "crs": "EPSG:4326",
        "transform": transform,
        "nodata": nodata,
        "compress": "deflate",
        "tiled": True,
    }
    with rasterio.open(dst, "w", **profile) as ds:
        ds.write(arr.astype(np.float32), 1)


# ---------------------------------------------------------------------------
# EM-DAT / population calibration
# ---------------------------------------------------------------------------

def load_emdat_country_rates() -> dict[str, dict[str, float]]:
    """Returns {hazard_key: {ISO3: deaths_per_million_per_year}}.

    Computes 1980-2020 average annual deaths from OWID decadal table,
    divides by 2020 population, multiplies by 1e6.
    """
    deaths_csv = HAZARD / "decadal_deaths_by_type.csv"
    pop_csv = HAZARD / "population_2020.csv"

    populations: dict[str, float] = {}
    with open(pop_csv) as f:
        for row in csv.DictReader(f):
            try:
                year = int(row["year"])
                if year != 2020:
                    continue
                code = row.get("code", "").strip()
                if not code or code.startswith("OWID_"):
                    continue
                populations[code] = float(row["population_historical"])
            except (ValueError, KeyError):
                continue

    # Read decadal deaths and sum 1980-2020 (5 decades)
    raw_decades: dict[str, dict[str, dict[str, float]]] = {}  # iso3 -> hazard_owid -> decade_year -> deaths
    with open(deaths_csv) as f:
        reader = csv.DictReader(f)
        for row in reader:
            code = row.get("Code", "").strip()
            entity = row.get("Entity", "").strip()
            try:
                year = int(row["Year"])
            except (ValueError, KeyError):
                continue
            if not code or year < 1980 or year > 2020:
                continue
            for owid_col in set(OWID_HAZARD_COL.values()) | {"Mass movements (dry)"}:
                v = row.get(owid_col)
                try:
                    deaths = float(v) if v not in (None, "") else 0.0
                except ValueError:
                    deaths = 0.0
                raw_decades.setdefault(code, {}).setdefault(owid_col, {})[year] = deaths

    rates: dict[str, dict[str, float]] = {h: {} for h in HAZARDS if h != "tsunami"}
    n_decades_used = 5  # 1980,1990,2000,2010,2020 -> covers ~50 yrs
    YEARS_SPAN = 50.0

    for iso3, by_haz in raw_decades.items():
        pop = populations.get(iso3)
        if not pop or pop < 1000:
            continue
        for our_haz, owid_col in OWID_HAZARD_COL.items():
            deaths_total = sum(by_haz.get(owid_col, {}).values())
            if our_haz == "landslide":
                deaths_total += sum(by_haz.get("Mass movements (dry)", {}).values())
            avg_per_year = deaths_total / YEARS_SPAN
            rate = avg_per_year / pop * 1e6
            if rate > 0:
                rates[our_haz][iso3] = rate
    return rates, populations


# ---------------------------------------------------------------------------
# Country mask (ISO3 raster at TARGET_RES)
# ---------------------------------------------------------------------------

def build_iso3_mask() -> tuple[np.ndarray, dict[int, str]]:
    """Returns (mask_array_uint16, code_lookup).

    mask_array[y,x] = integer id; 0 = no country.
    code_lookup[id] = ISO3 string.
    """
    import geopandas as gpd
    from rasterio.features import rasterize as rio_rasterize

    shp = DATA / "NaturalEarth" / "ne_10m_admin_0_countries_dir" / "ne_10m_admin_0_countries.shp"
    if not shp.exists():
        shp = DATA / "NaturalEarth" / "ne_110m_admin_0_countries.shp"
    world = gpd.read_file(shp)

    transform = from_bounds(-180, -90, 180, 90, TARGET_W, TARGET_H)
    code_lookup: dict[int, str] = {}
    shapes = []
    next_id = 1
    iso_col = "ISO_A3" if "ISO_A3" in world.columns else "iso_a3"
    for _, row in world.iterrows():
        iso3 = str(row.get(iso_col, "")).strip()
        if not iso3 or iso3 == "-99":
            # Try ADM0_A3 fallback
            iso3 = str(row.get("ADM0_A3", "")).strip()
        if not iso3 or iso3 == "-99":
            continue
        if iso3 in code_lookup.values():
            # Use existing id for same ISO3 (multipart islands etc.)
            iid = next(k for k, v in code_lookup.items() if v == iso3)
        else:
            iid = next_id
            code_lookup[iid] = iso3
            next_id += 1
        shapes.append((row.geometry, iid))

    mask = rio_rasterize(
        shapes,
        out_shape=(TARGET_H, TARGET_W),
        transform=transform,
        fill=0,
        dtype=np.uint16,
    )
    return mask, code_lookup


# ---------------------------------------------------------------------------
# Hazard intensity rasters
# ---------------------------------------------------------------------------

def hazard_earthquake() -> np.ndarray:
    """GEM PGA (g) at TARGET_RES."""
    src = HAZARD / "gem" / "v2023_1_pga_475_rock_3min.tif"
    if not src.exists():
        raise FileNotFoundError(src)
    aligned = HAZARD / "_tmp_eq.tif"
    warp_to_target(src, aligned, "bilinear")
    with rasterio.open(aligned) as ds:
        raw = ds.read(1)
        nd = ds.nodata
    a = raw.astype(np.float64)
    if nd is not None:
        a[raw == nd] = 0
    a = a.astype(np.float32)
    a[~np.isfinite(a)] = 0
    aligned.unlink(missing_ok=True)
    return np.maximum(a, 0)


def hazard_flood() -> np.ndarray:
    """JRC RP100 inundation depth (m) at TARGET_RES."""
    src = HAZARD / "jrc_flood" / "floodMapGL_rp100y.tif"
    aligned = HAZARD / "_tmp_flood.tif"
    warp_to_target(src, aligned, "max")
    with rasterio.open(aligned) as ds:
        a = ds.read(1).astype(np.float32)
        nd = ds.nodata
    if nd is not None:
        a[a == nd] = 0
    a[~np.isfinite(a)] = 0
    a[a < 0] = 0
    aligned.unlink(missing_ok=True)
    return a


def hazard_cyclone() -> np.ndarray:
    """STORM 100yr return-period max wind (m/s) at TARGET_RES."""
    src = HAZARD / "storm_constant_100yr.tif"
    aligned = HAZARD / "_tmp_cyc.tif"
    warp_to_target(src, aligned, "max")
    with rasterio.open(aligned) as ds:
        a = ds.read(1).astype(np.float32)
        nd = ds.nodata
    if nd is not None:
        a[a == nd] = 0
    a[~np.isfinite(a)] = 0
    a[a < 0] = 0
    aligned.unlink(missing_ok=True)
    return a


def hazard_tsunami() -> np.ndarray:
    """Rasterize PTHA point dataset by ari500 runup, then expand inland with kernel.

    Each PTHA point has lon/lat and ari500 (1/500-yr runup, m). We rasterize to
    nearest TARGET grid pixel as max, then propagate inland up to ~30 km along
    coastal zones using a simple nearest-coastline buffer.
    """
    src = HAZARD / "globalPTHA.txt"
    arr = np.zeros((TARGET_H, TARGET_W), dtype=np.float32)
    with open(src) as f:
        reader = csv.DictReader(f, delimiter=";")
        for row in reader:
            try:
                lon = float(row["POINT_X"])
                lat = float(row["POINT_Y"])
                runup = float(row["ari500"])
            except (ValueError, KeyError):
                continue
            if lon > 180:
                lon -= 360
            x = int((lon + 180) / TARGET_RES)
            y = int((90 - lat) / TARGET_RES)
            if 0 <= x < TARGET_W and 0 <= y < TARGET_H:
                if runup > arr[y, x]:
                    arr[y, x] = runup

    # Propagate inland: dilate by ~30 km (6 px at 5km grid) with quick max filter
    from scipy.ndimage import maximum_filter
    arr = maximum_filter(arr, size=13)  # ~65 km neighborhood
    return arr


def hazard_volcano() -> np.ndarray:
    """Kernel density of GVP holocene volcanoes weighted by recent activity.

    Recent eruption (Last_Eruption_Year > 1900) gets weight 3, else 1.
    Gaussian kernel with sigma ~25 km.
    """
    src = HAZARD / "gvp_holocene_volcanoes.csv"
    arr = np.zeros((TARGET_H, TARGET_W), dtype=np.float32)
    with open(src) as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                lat = float(row["Latitude"])
                lon = float(row["Longitude"])
            except (ValueError, KeyError):
                continue
            try:
                last = int(float(row.get("Last_Eruption_Year", "") or 0))
            except ValueError:
                last = 0
            weight = 3.0 if last > 1900 else (1.0 if last > 0 else 0.3)
            x = int((lon + 180) / TARGET_RES)
            y = int((90 - lat) / TARGET_RES)
            if 0 <= x < TARGET_W and 0 <= y < TARGET_H:
                arr[y, x] += weight

    from scipy.ndimage import gaussian_filter
    sigma_px = 5.0  # ~25 km
    arr = gaussian_filter(arr, sigma=sigma_px)
    return arr


def hazard_drought() -> np.ndarray:
    """Frequency of severe drought (SPEI-12 < -1.5) over historical record at TARGET_RES."""
    import netCDF4 as nc
    arrs = []
    for hemi in ("eh", "wh"):
        path = HAZARD / "spei" / f"spei_12_{hemi}.nc"
        if not path.exists():
            continue
        ds = nc.Dataset(path)
        spei = ds.variables["spei"]
        # Variables: time, lat, lon. Only consider 1980-2006 to align with EM-DAT.
        time = ds.variables["time"][:]
        # Time is months since 1900-01 typically; filter recent
        # Use last 27*12 months as proxy for 1980-2006 (or take all available)
        n_take = min(spei.shape[0], 27 * 12)
        data = spei[-n_take:, :, :]  # (T, lat, lon)
        data = np.array(data)
        sev = (data < -1.5) & np.isfinite(data)
        freq = sev.sum(axis=0) / float(n_take)  # fraction of months in severe drought
        lats = ds.variables["latitude"][:]
        lons = ds.variables["longitude"][:]
        ds.close()

        # Resample to TARGET grid
        # Determine pixel mapping
        from scipy.interpolate import RegularGridInterpolator
        # ensure lats descending
        if lats[0] < lats[-1]:
            lats = lats[::-1]
            freq = freq[::-1, :]
        # Interpolator expects ascending coords
        lons_asc = lons.copy()
        sort_idx = np.argsort(lons_asc)
        lons_asc = lons_asc[sort_idx]
        freq_asc = freq[:, sort_idx]
        lat_asc = lats[::-1]
        freq_lat_asc = freq_asc[::-1, :]
        interp = RegularGridInterpolator(
            (lat_asc, lons_asc), freq_lat_asc,
            bounds_error=False, fill_value=0.0
        )
        # Build target grid
        ys = np.linspace(90 - TARGET_RES/2, -90 + TARGET_RES/2, TARGET_H)
        xs = np.linspace(-180 + TARGET_RES/2, 180 - TARGET_RES/2, TARGET_W)
        gy, gx = np.meshgrid(ys, xs, indexing='ij')
        pts = np.column_stack([gy.ravel(), gx.ravel()])
        out = interp(pts).reshape(TARGET_H, TARGET_W)
        arrs.append(out.astype(np.float32))
    if not arrs:
        return np.zeros((TARGET_H, TARGET_W), dtype=np.float32)
    # Combine hemispheres: take max where both have values (they shouldn't overlap)
    res = arrs[0]
    for a in arrs[1:]:
        res = np.where(a > 0, np.maximum(res, a), res)
    res[~np.isfinite(res)] = 0
    return res


def hazard_wildfire(drought_freq: np.ndarray) -> np.ndarray:
    """Fire-prone climate proxy: severe-drought frequency masked by land/vegetation.

    Without a true global burned-area raster, we use drought frequency as a proxy
    and reduce in extremely arid (no fuel) regions by capping at 0.5 of severe-arid.
    The country EM-DAT calibration corrects the absolute level.
    """
    arr = drought_freq.copy()
    # Reduce in very high drought freq (assumes desert with no fuel)
    arr = np.minimum(arr, 0.4)
    return arr


def hazard_landslide(elev_aligned: np.ndarray) -> np.ndarray:
    """Slope from ETOPO at TARGET grid, m/m."""
    dy = np.gradient(elev_aligned, axis=0)
    dx = np.gradient(elev_aligned, axis=1)
    slope = np.sqrt(dx**2 + dy**2)
    return slope.astype(np.float32)


def load_etopo_aligned() -> np.ndarray:
    etopo = None
    for f in (DATA / "ETOPO").glob("*.tif"):
        etopo = f
        break
    if not etopo:
        return np.zeros((TARGET_H, TARGET_W), dtype=np.float32)
    aligned = HAZARD / "_tmp_etopo.tif"
    warp_to_target(etopo, aligned, "bilinear")
    with rasterio.open(aligned) as ds:
        a = ds.read(1).astype(np.float32)
    aligned.unlink(missing_ok=True)
    return a


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------

def apply_calibration(intensity: np.ndarray,
                      iso_mask: np.ndarray,
                      code_lookup: dict[int, str],
                      country_rates: dict[str, float],
                      blend_intensity_weight: float = 0.5) -> np.ndarray:
    """Calibrate hazard intensity to deaths/M/yr per pixel.

    Two independent estimates are computed and blended:

      r_country  -- "given the country's actual mortality history (EM-DAT) and
                    where the hazard concentrates within the country, what's
                    the per-pixel rate?"  Captures real-world building codes,
                    early warning, evacuation -- so it correctly says e.g.
                    Japan/USA earthquake deaths are far rarer per capita than
                    Haiti/Iran. Within a country: r_p = R_hc * I_p / mean(I_c).

      r_intensity -- "given global average mortality per unit hazard, what
                    would this pixel's intensity imply?"  Independent of
                    country, so a physically dangerous pixel always shows
                    meaningful risk even in well-prepared countries.
                    r_p = R_global * I_p / mean(I_world)

    The final per-pixel rate is a weighted blend so neither signal dominates:
    well-prepared but high-hazard regions (SF Bay, Tokyo) still show up, and
    poorly-prepared low-hazard regions are not over-penalized.
    """
    intensity = np.asarray(intensity, dtype=np.float32)
    out = np.zeros_like(intensity, dtype=np.float32)

    finite_pos = np.isfinite(intensity) & (intensity > 0)
    global_mean_I = float(np.nanmean(intensity[finite_pos])) if finite_pos.any() else 0.0

    total_dr = 0.0  # sum of country_rate * country_pop for global mean
    total_pop = 0.0
    for iid, iso3 in code_lookup.items():
        rate = country_rates.get(iso3, 0.0)
        if rate <= 0:
            continue
        n = int((iso_mask == iid).sum())
        if n == 0:
            continue
        # weight by country pixel count as a population proxy
        total_dr += rate * n
        total_pop += n
    global_rate = (total_dr / total_pop) if total_pop > 0 else 0.0

    # Pure-intensity baseline (global), available everywhere on land
    if global_mean_I > 0 and global_rate > 0:
        r_intensity_global = (global_rate * intensity / global_mean_I).astype(np.float32)
    else:
        r_intensity_global = np.zeros_like(intensity, dtype=np.float32)

    for iid, iso3 in code_lookup.items():
        rate = country_rates.get(iso3, 0.0)
        sel = (iso_mask == iid)
        if not np.any(sel):
            continue

        I_country = intensity[sel]
        m = np.nanmean(I_country)

        if rate > 0 and np.isfinite(m) and m > 0:
            r_country = (rate * I_country / m).astype(np.float32)
            r_country = np.minimum(r_country, rate * CAP_MULTIPLIER)
        elif rate > 0:
            r_country = np.full_like(I_country, rate, dtype=np.float32)
        else:
            r_country = np.zeros_like(I_country, dtype=np.float32)

        r_int = r_intensity_global[sel]

        # Blend: country baseline (history-aware) + intensity baseline (physics-aware)
        w = blend_intensity_weight
        r_blend = (1.0 - w) * r_country + w * r_int

        # Make sure highly-prepared countries still show non-trivial rate where
        # the physical hazard is high. Floor at 0.25 * physical baseline.
        r_blend = np.maximum(r_blend, 0.25 * r_int)

        out[sel] = r_blend
    return out


def apply_global_distribution(intensity: np.ndarray, total_deaths_per_year: float) -> np.ndarray:
    """Distribute a fixed global death budget across pixels by intensity weight.
    Used for tsunami where EM-DAT doesn't separate it from earthquakes.

    For person-weighting we'd need population; instead we assume uniform
    population density in tsunami-exposed zones (rough, but tsunami exposure is
    heavily concentrated in coastlines anyway). Result is deaths/M/yr where the
    M is a global-average proxy.
    """
    total_intensity = float(np.sum(intensity))
    if total_intensity <= 0:
        return np.zeros_like(intensity, dtype=np.float32)
    # Assume average population density 50 people/km^2 over land (~5e9/total area)
    # Each TARGET pixel ~5km × 5km = 25km^2. Pop per pixel ~1250.
    pop_per_pixel = 1250.0
    # rate = (intensity weight × total_deaths) / pop_per_pixel × 1e6
    weight = intensity / total_intensity
    rate = weight * total_deaths_per_year / pop_per_pixel * 1e6
    return rate.astype(np.float32)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_lookup_grid(hazard_rasters: dict[str, np.ndarray]) -> dict:
    """Downsample each hazard raster to LOOKUP_RES and store as a flat list."""
    lookup = {
        "res": LOOKUP_RES,
        "w": LOOKUP_W,
        "h": LOOKUP_H,
        "hazards": [],   # list of {"id":..., "values":[...]}
        "composite": [],
    }
    sy = TARGET_H // LOOKUP_H
    sx = TARGET_W // LOOKUP_W
    composite = np.zeros((LOOKUP_H, LOOKUP_W), dtype=np.float32)
    for hid in HAZARDS:
        arr = hazard_rasters[hid]
        # block-mean downsample
        h2 = arr[: LOOKUP_H * sy, : LOOKUP_W * sx]
        h2 = h2.reshape(LOOKUP_H, sy, LOOKUP_W, sx).mean(axis=(1, 3))
        composite += h2
        # store as int (0.1 deaths/M/yr resolution -> int = value*10)
        ints = np.clip(np.round(h2 * 10).astype(np.int32), 0, 65000)
        lookup["hazards"].append({"id": hid, "values": ints.flatten().tolist()})
    composite_int = np.clip(np.round(composite * 10).astype(np.int32), 0, 65000)
    lookup["composite"] = composite_int.flatten().tolist()
    return lookup


def main():
    print("=" * 60)
    print("DISASTER MORTALITY PIPELINE")
    print("=" * 60)
    ensure(TILES)

    print("\n[1/6] Loading EM-DAT calibration ...")
    rates, populations = load_emdat_country_rates()
    for h in rates:
        print(f"  {h}: {len(rates[h])} countries, "
              f"top: {sorted(rates[h].items(), key=lambda x: -x[1])[:3]}")

    print("\n[2/6] Building country ISO3 mask at target grid ...")
    iso_mask, code_lookup = build_iso3_mask()
    print(f"  {len(code_lookup)} countries rasterized at {TARGET_W}x{TARGET_H}")

    print("\n[3/6] Building hazard intensity rasters ...")
    hazards: dict[str, np.ndarray] = {}

    print("  earthquake (GEM PGA)")
    hazards["earthquake"] = hazard_earthquake()
    print("  flood (JRC RP100)")
    hazards["flood"] = hazard_flood()
    print("  cyclone (STORM 100yr)")
    hazards["cyclone"] = hazard_cyclone()
    print("  tsunami (PTHA points)")
    hazards["tsunami"] = hazard_tsunami()
    print("  volcano (GVP kernel)")
    hazards["volcano"] = hazard_volcano()
    print("  drought (SPEI-12 freq)")
    hazards["drought"] = hazard_drought()
    print("  loading ETOPO for slope")
    elev = load_etopo_aligned()
    print("  landslide (slope)")
    hazards["landslide"] = hazard_landslide(elev)
    print("  wildfire (drought-proxy)")
    hazards["wildfire"] = hazard_wildfire(hazards["drought"])

    print("\n[4/6] Calibrating to deaths/M/yr per pixel ...")
    mortality: dict[str, np.ndarray] = {}
    for h in HAZARDS:
        if h == "tsunami":
            mortality[h] = apply_global_distribution(
                hazards[h], TSUNAMI_GLOBAL_DEATHS_PER_YEAR)
        else:
            mortality[h] = apply_calibration(
                hazards[h], iso_mask, code_lookup, rates.get(h, {}))
        m = mortality[h]
        nz = m[m > 0]
        if nz.size:
            print(f"  {h:10s} median {np.median(nz):.2f}, "
                  f"99th {np.percentile(nz, 99):.2f}, "
                  f"max {np.max(m):.2f}, "
                  f"global mean {np.mean(m):.3f} deaths/M/yr")
        else:
            print(f"  {h:10s} (zero everywhere)")

    composite = np.zeros_like(mortality[HAZARDS[0]])
    for h in HAZARDS:
        composite += mortality[h]
    print(f"  composite median {np.median(composite[composite>0]):.2f}, "
          f"max {np.max(composite):.2f}, mean {np.mean(composite):.3f}")

    print("\n[5/6] Writing rasters and lookup ...")
    out_dir = ensure(HAZARD / "_out")
    for h in HAZARDS:
        write_raster(mortality[h], out_dir / f"{h}_mortality.tif")
    write_raster(composite, out_dir / "risk_mortality.tif")

    lookup = build_lookup_grid(mortality)
    lookup_path = ROOT / "app" / "public" / "risk_lookup.json"
    ensure(lookup_path.parent)
    with open(lookup_path, "w") as f:
        json.dump(lookup, f)
    sz = lookup_path.stat().st_size / 1024
    print(f"  wrote {lookup_path.name} ({sz:.1f} KB)")

    print("\n[6/6] Done. Rasters in _out/, lookup in app/public/")
    print("Run build_tiles.py risk eq flood cyclone tsunami volcano drought wildfire landslide")


if __name__ == "__main__":
    main()
