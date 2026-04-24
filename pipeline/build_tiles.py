#!/usr/bin/env python3
"""
Utopia Data Pipeline: Convert raw geospatial data to PMTiles for the web app.

Usage:
    python pipeline/build_tiles.py [axis ...]
    python pipeline/build_tiles.py elev          # single axis
    python pipeline/build_tiles.py elev pop      # multiple axes
    python pipeline/build_tiles.py --all         # everything

Requires: GDAL, rasterio, numpy, pandas, rio-pmtiles
Install:  mamba install -c conda-forge gdal rasterio numpy pandas
          pip install rio-pmtiles
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.enums import Resampling

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TILES = DATA / "tiles"
CATALOG_PATH = DATA / "tiles" / "catalog.json"
PYTHON = sys.executable

MAX_ZOOM = 6


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ensure_dir(p: Path):
    p.mkdir(parents=True, exist_ok=True)


def run(cmd: list[str], **kw):
    print(f"  $ {' '.join(str(c) for c in cmd)}")
    subprocess.check_call(cmd, **kw)


def normalize_to_uint8(
    src_path: Path,
    dst_path: Path,
    data_min: float | None = None,
    data_max: float | None = None,
    log_transform: bool = False,
    invert: bool = False,
    nodata_val: float | None = None,
    band: int = 1,
):
    """Read a single-band raster, normalize values to 0-255 uint8, write GeoTIFF."""
    with rasterio.open(src_path) as src:
        arr = src.read(band).astype(np.float64)
        profile = src.profile.copy()
        nd = nodata_val if nodata_val is not None else src.nodata

        mask = np.ones(arr.shape, dtype=bool)
        if nd is not None:
            if np.isnan(nd):
                mask = ~np.isnan(arr)
            else:
                mask = ~np.isclose(arr, nd, atol=0.1)

        valid = arr[mask]
        if valid.size == 0:
            out = np.zeros(arr.shape, dtype=np.uint8)
        else:
            if log_transform:
                arr = np.where(mask & (arr > 0), np.log1p(arr), 0)
                valid = arr[mask & (arr > 0)] if np.any(mask & (arr > 0)) else arr[mask]
                if data_min is not None and data_min >= 0:
                    data_min = np.log1p(data_min)
                if data_max is not None and data_max > 0:
                    data_max = np.log1p(data_max)

            lo = data_min if data_min is not None else float(np.nanpercentile(valid, 1))
            hi = data_max if data_max is not None else float(np.nanpercentile(valid, 99))
            if hi <= lo:
                hi = lo + 1.0

            scaled = (arr - lo) / (hi - lo)
            scaled = np.clip(scaled, 0.0, 1.0)

            if invert:
                scaled = 1.0 - scaled

            scaled[~mask] = 0.0
            out = np.zeros(arr.shape, dtype=np.uint8)
            out[mask] = np.clip(scaled[mask] * 254 + 1, 1, 255).astype(np.uint8)

        profile.update(dtype="uint8", count=1, nodata=0, compress="deflate")
        with rasterio.open(dst_path, "w", **profile) as dst:
            dst.write(out, 1)

    print(f"  Normalized -> {dst_path.name} ({out.shape[1]}x{out.shape[0]})")


def apply_ocean_mask(src_tif: Path, dst_tif: Path, nodata_val=np.nan) -> Path:
    """Mask out ocean pixels using ETOPO elevation data (elevation <= 0 = ocean).
    Returns dst_tif path, or src_tif if ETOPO not available.
    """
    elev_src = DATA / "ETOPO" / "ETOPO_2022_v1_60s_N90W180_surface.tif"
    if not elev_src.exists():
        print("  WARNING: No ETOPO elevation data for ocean mask")
        return src_tif

    print("  Applying ocean mask from ETOPO elevation...")
    from rasterio.warp import reproject, Resampling as WarpResampling
    from rasterio.transform import from_bounds as fb

    with rasterio.open(src_tif) as src_ds:
        data = src_ds.read(1)
        profile = src_ds.profile.copy()
        bounds = src_ds.bounds
        shape = data.shape

    with rasterio.open(elev_src) as elev_ds:
        elev_resampled = np.empty(shape, dtype=np.float32)
        reproject(
            source=rasterio.band(elev_ds, 1),
            destination=elev_resampled,
            dst_transform=fb(bounds.left, bounds.bottom,
                             bounds.right, bounds.top,
                             shape[1], shape[0]),
            dst_crs=profile["crs"],
            resampling=WarpResampling.bilinear,
        )

    ocean_mask = elev_resampled <= 0
    if isinstance(nodata_val, float) and np.isnan(nodata_val):
        data = data.astype(np.float32)
        data[ocean_mask] = np.nan
    else:
        data[ocean_mask] = nodata_val
    ocean_pct = 100 * ocean_mask.sum() / ocean_mask.size
    print(f"    Masked {ocean_pct:.1f}% ocean pixels")

    profile.update(nodata=float(nodata_val) if not (isinstance(nodata_val, float) and np.isnan(nodata_val)) else float("nan"))
    ensure_dir(dst_tif.parent)
    with rasterio.open(dst_tif, "w", **profile) as dst:
        dst.write(data, 1)

    return dst_tif


def make_rgb_for_pmtiles(gray_path: Path, rgb_path: Path):
    """Convert single-band uint8 GeoTIFF to 3-band RGB (required by rio-pmtiles)."""
    with rasterio.open(gray_path) as src:
        band = src.read(1)
        profile = src.profile.copy()
        profile.update(count=3)
        with rasterio.open(rgb_path, "w", **profile) as dst:
            dst.write(band, 1)
            dst.write(band, 2)
            dst.write(band, 3)
    print(f"  RGB -> {rgb_path.name}")


def geotiff_to_pmtiles(src_tif: Path, dst_pmtiles: Path, max_zoom: int = MAX_ZOOM, resampling: str = "bilinear"):
    """Convert a 3-band RGB GeoTIFF to PMTiles using rio pmtiles CLI."""
    ensure_dir(dst_pmtiles.parent)
    rio = str(Path(PYTHON).parent / "rio")
    run([
        rio, "pmtiles",
        str(src_tif),
        str(dst_pmtiles),
        "--format", "PNG",
        "--resampling", resampling,
        "--zoom-levels", f"0..{max_zoom}",
    ])
    size_mb = dst_pmtiles.stat().st_size / 1024 / 1024
    print(f"  PMTiles -> {dst_pmtiles.name} ({size_mb:.1f} MB)")


def full_pipeline(
    raw_path: Path,
    axis_id: str,
    year: str | None = None,
    data_min: float | None = None,
    data_max: float | None = None,
    log_transform: bool = False,
    invert: bool = False,
    nodata_val: float | None = None,
    band: int = 1,
    max_zoom: int = MAX_ZOOM,
    resampling: str = "bilinear",
):
    """Complete pipeline: raw GeoTIFF -> normalized uint8 -> RGB -> PMTiles."""
    suffix = f"_{year}" if year else ""
    axis_dir = TILES / axis_id
    ensure_dir(axis_dir)

    gray_path = axis_dir / f"{axis_id}{suffix}_gray.tif"
    rgb_path = axis_dir / f"{axis_id}{suffix}_rgb.tif"
    out_path = axis_dir / f"{axis_id}{suffix}.pmtiles"

    if out_path.exists():
        print(f"  Skipping {out_path.name} (already exists)")
        return out_path

    print(f"  Step 1: Normalize {raw_path.name}")
    normalize_to_uint8(raw_path, gray_path, data_min, data_max, log_transform, invert, nodata_val, band)

    print(f"  Step 2: Convert to RGB")
    make_rgb_for_pmtiles(gray_path, rgb_path)

    print(f"  Step 3: Generate PMTiles")
    geotiff_to_pmtiles(rgb_path, out_path, max_zoom, resampling=resampling)

    gray_path.unlink(missing_ok=True)
    rgb_path.unlink(missing_ok=True)

    return out_path


# ---------------------------------------------------------------------------
# Per-axis processors
# ---------------------------------------------------------------------------

def process_elev():
    """ETOPO 2022 elevation -> elev.pmtiles"""
    print("\n=== ELEVATION (ETOPO 2022) ===")
    src = DATA / "ETOPO" / "ETOPO_2022_v1_60s_N90W180_surface.tif"
    if not src.exists():
        print(f"  ERROR: {src} not found")
        return None
    return full_pipeline(src, "elev", data_min=0, data_max=6000, nodata_val=-32768)


POP_YEARS_TO_BUILD = {"2000", "2005", "2010", "2015"}


def process_pop():
    """LandScan population -> pop_YYYY.pmtiles

    Only emits the four evenly-spaced snapshots in POP_YEARS_TO_BUILD --
    the time slider snaps to the nearest available year, so 4 snapshots
    feel just as smooth at integer-year stepping as 16 did, while
    cutting hosted pop tiles from ~1.9 GB to ~480 MB.
    """
    print("\n=== POPULATION (LandScan) ===")
    print(f"  Emitting only years: {sorted(POP_YEARS_TO_BUILD)}")
    ls_dir = DATA / "LandScan"
    results = []

    # Process already extracted tif files
    for tif_path in sorted(ls_dir.glob("landscan-global-[0-9][0-9][0-9][0-9].tif")):
        year = tif_path.stem.split("-")[2]
        if year not in POP_YEARS_TO_BUILD:
            print(f"  Skipping {year} (not in POP_YEARS_TO_BUILD)")
            continue
        print(f"\n--- Population {year} ---")

        # Convert NoData to 0 on land, keep Ocean as NoData
        processed_tif = ls_dir / f"landscan-global-{year}-processed.tif"
        if not processed_tif.exists():
            print("  Converting NoData to 0 on land...")
            import rasterio
            import numpy as np
            with rasterio.open(tif_path) as src:
                arr = src.read(1)
                profile = src.profile.copy()
                nd = src.nodata
                
                print("    Replacing nodata with 0...")
                if nd is not None:
                    if np.isnan(nd):
                        arr[np.isnan(arr)] = 0
                    else:
                        arr[arr == nd] = 0
                
                # We need an output profile with a defined nodata to use with ocean mask
                profile.update(nodata=-2147483647)
                
                temp_tif = ls_dir / f"temp_pop_{year}.tif"
                with rasterio.open(temp_tif, "w", **profile) as dst:
                    dst.write(arr, 1)
                
            print("  Applying ocean mask...")
            apply_ocean_mask(temp_tif, processed_tif, nodata_val=-2147483647)
            temp_tif.unlink(missing_ok=True)

        out = full_pipeline(processed_tif, "pop", year=year, data_max=10000, log_transform=True, nodata_val=-2147483647)
        results.append((year, out))
    return results


def process_depv():
    """SEDAC GRDI deprivation index -> depv.pmtiles"""
    print("\n=== DEPRIVATION (SEDAC GRDI) ===")
    zf = DATA / "SEDAC" / "povmap-grdi-v1-grdiv1-geotiff.zip"
    tif = DATA / "SEDAC" / "povmap-grdi-v1.tif"

    if not tif.exists() and zf.exists():
        print(f"  Extracting from {zf.name}")
        with zipfile.ZipFile(zf) as z:
            for member in z.namelist():
                if member.endswith(".tif"):
                    z.extract(member, DATA / "SEDAC")

    if not tif.exists():
        print(f"  ERROR: {tif} not found")
        return None

    return full_pipeline(tif, "depv", data_min=0, data_max=100, invert=True, nodata_val=-9999)


def process_hcare():
    """MAP motorized travel time to healthcare -> hcare.pmtiles"""
    print("\n=== HEALTHCARE ACCESS (MAP) ===")
    zf = DATA / "MAP" / "motorized_travel_time_healthcare_2020.zip"
    tif = DATA / "MAP" / "2020_motorized_travel_time_to_healthcare.geotiff"

    if not tif.exists() and zf.exists():
        print(f"  Extracting from {zf.name}")
        with zipfile.ZipFile(zf) as z:
            z.extractall(DATA / "MAP")

    if not tif.exists():
        print(f"  ERROR: {tif} not found")
        return None

    masked_path = TILES / "hcare" / "hcare_masked.tif"
    ensure_dir(masked_path.parent)
    final_tif = apply_ocean_mask(tif, masked_path, nodata_val=-1)

    out = full_pipeline(final_tif, "hcare", data_min=0, data_max=180, invert=True, nodata_val=-1)
    if final_tif != tif:
        masked_path.unlink(missing_ok=True)
    return out


def process_temp():
    """TerraClimate tmax/tmin -> temp_YYYY.pmtiles"""
    print("\n=== TEMPERATURE (TerraClimate) ===")
    tc_dir = DATA / "TerraClimate"

    try:
        import netCDF4
    except ImportError:
        print("  ERROR: netCDF4 required. Install: mamba install -c conda-forge netcdf4")
        return None

    years = set()
    for f in sorted(tc_dir.glob("TerraClimate_tmax_*.nc")):
        year = f.stem.split("_")[-1]
        tmin_f = tc_dir / f"TerraClimate_tmin_{year}.nc"
        if tmin_f.exists():
            years.add(year)

    if not years:
        print("  ERROR: No matched tmax/tmin year pairs found")
        return None

    results = []
    for year in sorted(years):
        print(f"\n--- Temperature {year} ---")
        out_path = TILES / "temp" / f"temp_{year}.pmtiles"
        if out_path.exists():
            print(f"  Skipping {out_path.name} (already exists)")
            results.append((year, out_path))
            continue

        tmax_file = tc_dir / f"TerraClimate_tmax_{year}.nc"
        tmin_file = tc_dir / f"TerraClimate_tmin_{year}.nc"

        print(f"  Computing annual mean from tmax/tmin...")
        with netCDF4.Dataset(tmax_file) as ds_max:
            tmax = ds_max.variables['tmax'][:]
        with netCDF4.Dataset(tmin_file) as ds_min:
            tmin = ds_min.variables['tmin'][:]

        fill_val = -32768 * 0.01
        mask = (tmax > fill_val + 1) & (tmin > fill_val + 1)

        tmean_monthly = (tmax + tmin) / 2.0
        with np.errstate(invalid='ignore'):
            month_count = mask.sum(axis=0)
            tmean_monthly[~mask] = 0
            annual_mean = tmean_monthly.sum(axis=0) / np.maximum(month_count, 1)
            annual_mean[month_count == 0] = np.nan

        tif_path = TILES / "temp" / f"temp_{year}_raw.tif"
        ensure_dir(tif_path.parent)

        height, width = annual_mean.shape
        transform = from_bounds(-180, -90, 180, 90, width, height)
        profile = {
            "driver": "GTiff",
            "dtype": "float32",
            "width": width,
            "height": height,
            "count": 1,
            "crs": "EPSG:4326",
            "transform": transform,
            "nodata": np.nan,
            "compress": "deflate",
        }
        with rasterio.open(tif_path, "w", **profile) as dst:
            dst.write(annual_mean.astype(np.float32), 1)

        out = full_pipeline(tif_path, "temp", year=year, data_min=-30, data_max=45, nodata_val=np.nan)
        tif_path.unlink(missing_ok=True)
        results.append((year, out))

    return results


def process_tvar():
    """TerraClimate tmax/tmin -> tvar_YYYY.pmtiles (Temp Volatility)"""
    print("\n=== TEMPERATURE VOLATILITY (TerraClimate) ===")
    tc_dir = DATA / "TerraClimate"

    try:
        import netCDF4
    except ImportError:
        print("  ERROR: netCDF4 required. Install: mamba install -c conda-forge netcdf4")
        return None

    years = set()
    for f in sorted(tc_dir.glob("TerraClimate_tmax_*.nc")):
        year = f.stem.split("_")[-1]
        tmin_f = tc_dir / f"TerraClimate_tmin_{year}.nc"
        if tmin_f.exists():
            years.add(year)

    if not years:
        print("  ERROR: No matched tmax/tmin year pairs found")
        return None

    results = []
    for year in sorted(years):
        print(f"\n--- Temperature Volatility {year} ---")
        out_path = TILES / "tvar" / f"tvar_{year}.pmtiles"
        if out_path.exists():
            print(f"  Skipping {out_path.name} (already exists)")
            results.append((year, out_path))
            continue

        tmax_file = tc_dir / f"TerraClimate_tmax_{year}.nc"
        tmin_file = tc_dir / f"TerraClimate_tmin_{year}.nc"

        print(f"  Computing standard deviation of monthly means from tmax/tmin...")
        with netCDF4.Dataset(tmax_file) as ds_max:
            tmax = ds_max.variables['tmax'][:]
        with netCDF4.Dataset(tmin_file) as ds_min:
            tmin = ds_min.variables['tmin'][:]

        fill_val = -32768 * 0.01
        mask = (tmax > fill_val + 1) & (tmin > fill_val + 1)

        tmean_monthly = (tmax + tmin) / 2.0
        with np.errstate(invalid='ignore'):
            tmean_monthly[~mask] = np.nan
            # standard deviation across the 12 months (axis=0)
            annual_std = np.nanstd(tmean_monthly, axis=0)

        # Mask out major lakes (Great Lakes, etc.) using Natural Earth shapefile
        lakes_shp = DATA / "NaturalEarth" / "ne_10m_lakes" / "ne_10m_lakes.shp"
        if lakes_shp.exists():
            import geopandas as gpd
            from rasterio.features import rasterize
            print("  Masking major lakes...")
            h, w = annual_std.shape
            lake_transform = from_bounds(-180, -90, 180, 90, w, h)
            gdf = gpd.read_file(lakes_shp)
            lake_shapes = [(geom, 1) for geom in gdf.geometry if geom is not None]
            if lake_shapes:
                lake_raster = rasterize(
                    lake_shapes, out_shape=(h, w),
                    transform=lake_transform, fill=0, dtype=np.uint8
                )
                annual_std[lake_raster == 1] = np.nan
                print(f"  Masked {int(np.sum(lake_raster == 1))} lake pixels")
        else:
            print("  WARNING: Lakes shapefile not found, skipping lake mask")

        tif_path = TILES / "tvar" / f"tvar_{year}_raw.tif"
        ensure_dir(tif_path.parent)

        height, width = annual_std.shape
        transform = from_bounds(-180, -90, 180, 90, width, height)
        profile = {
            "driver": "GTiff",
            "dtype": "float32",
            "width": width,
            "height": height,
            "count": 1,
            "crs": "EPSG:4326",
            "transform": transform,
            "nodata": np.nan,
            "compress": "deflate",
        }
        with rasterio.open(tif_path, "w", **profile) as dst:
            dst.write(annual_std.astype(np.float32), 1)

        out = full_pipeline(tif_path, "tvar", year=year, data_min=0, data_max=15, nodata_val=np.nan)
        tif_path.unlink(missing_ok=True)
        results.append((year, out))

    return results


def process_water():
    """TerraClimate ppt -> water_YYYY.pmtiles"""
    print("\n=== WATER AVAILABILITY (TerraClimate ppt) ===")
    tc_dir = DATA / "TerraClimate"

    try:
        import netCDF4
    except ImportError:
        print("  ERROR: netCDF4 required. Install: mamba install -c conda-forge netcdf4")
        return None

    years = set()
    for f in sorted(tc_dir.glob("TerraClimate_ppt_*.nc")):
        year = f.stem.split("_")[-1]
        years.add(year)

    if not years:
        print("  ERROR: No ppt NetCDF files found in TerraClimate dir")
        return None

    results = []
    for year in sorted(years):
        print(f"\n--- Water {year} ---")
        out_path = TILES / "water" / f"water_{year}.pmtiles"
        if out_path.exists():
            print(f"  Skipping {out_path.name} (already exists)")
            results.append((year, out_path))
            continue

        ppt_file = tc_dir / f"TerraClimate_ppt_{year}.nc"

        print(f"  Computing annual total precipitation...")
        with netCDF4.Dataset(ppt_file) as ds:
            ppt = ds.variables['ppt'][:]

        # Fill values might be represented as large negative numbers
        mask = (ppt > -30000)

        with np.errstate(invalid='ignore'):
            ppt_monthly = np.where(mask, ppt, np.nan)
            annual_sum = np.nansum(ppt_monthly, axis=0)

        tif_path = TILES / "water" / f"water_{year}_raw.tif"
        ensure_dir(tif_path.parent)

        height, width = annual_sum.shape
        transform = from_bounds(-180, -90, 180, 90, width, height)
        profile = {
            "driver": "GTiff",
            "dtype": "float32",
            "width": width,
            "height": height,
            "count": 1,
            "crs": "EPSG:4326",
            "transform": transform,
            "nodata": np.nan,
            "compress": "deflate",
        }
        with rasterio.open(tif_path, "w", **profile) as dst:
            dst.write(annual_sum.astype(np.float32), 1)

        out = full_pipeline(tif_path, "water", year=year, data_min=0, data_max=3000, nodata_val=np.nan)
        tif_path.unlink(missing_ok=True)
        results.append((year, out))

    return results


def map_country_names(scores: dict[str, float], name_column: str = "NAME") -> dict[str, str]:
    """Return a mapping from original country name to GeoJSON name."""
    import geopandas as gpd
    import re
    
    shp_10m = DATA / "NaturalEarth" / "ne_10m_admin_0_countries_dir" / "ne_10m_admin_0_countries.shp"
    shp_110m = DATA / "NaturalEarth" / "ne_110m_admin_0_countries.shp"
    shp = shp_10m if shp_10m.exists() else shp_110m
    
    if not shp.exists():
        return {}

    world = gpd.read_file(shp)
    # geojson_name -> original_name
    name_map = {}
    
    for _, row in world.iterrows():
        country_name = row[name_column]
        if not country_name: continue
        for key in scores.keys():
            if key.lower() == country_name.lower():
                name_map[country_name] = key
                break
            elif re.search(r'\b' + re.escape(key.lower()) + r'\b', country_name.lower()):
                name_map[country_name] = key
                break

    common_aliases = {
        "United States of America": ["United States", "US", "USA"],
        "Russian Federation": ["Russia"],
        "Korea, Republic of": ["South Korea"],
        "Korea, Dem. People's Rep.": ["North Korea"],
        "Congo, Democratic Republic of the": ["DR Congo", "Dem. Rep. Congo", "Congo (Kinshasa)"],
        "Congo": ["Congo (Brazzaville)", "Republic of the Congo"],
        "CÃ´te d'Ivoire": ["Ivory Coast", "Cote d'Ivoire"],
        "Côte d'Ivoire": ["Ivory Coast", "Cote d'Ivoire"],
        "Bosnia and Herz.": ["Bosnia And Herzegovina", "Bosnia and Herzegovina"],
        "Czechia": ["Czech Republic"],
        "Dominican Rep.": ["Dominican Republic"],
        "Hong Kong": ["Hong Kong (China)"],
        "Macao": ["Macao (China)"],
        "Macedonia": ["North Macedonia"],
        "Swaziland": ["Eswatini"],
        "Eswatini": ["Swaziland"],
        "Iran, Islamic Rep.": ["Iran"],
        "Lao PDR": ["Laos"],
        "Syrian Arab Republic": ["Syria"],
        "Venezuela, RB": ["Venezuela"],
        "Yemen, Rep.": ["Yemen"],
        "Turkiye": ["Turkey"],
        "Kosovo": ["Kosovo (Disputed Territory)"],
        "United States Virgin Islands": ["Us Virgin Islands"]
    }

    for _, row in world.iterrows():
        country_name = row[name_column]
        if not country_name or country_name in name_map:
            continue
        for alias_key, aliases in common_aliases.items():
            if country_name == alias_key:
                for a in aliases:
                    if a in scores:
                        name_map[country_name] = a
                        break
            for a in aliases:
                if country_name == a:
                    if alias_key in scores:
                        name_map[country_name] = alias_key
                        break

    return name_map


def rasterize_country_data(
    scores: dict[str, float],
    name_column: str = "NAME",
    resolution: float = 0.1,
    nodata: float = 0.0,
    return_map: bool = False,
):
    """Rasterize country-level scores onto a global grid using Natural Earth boundaries.
    Returns (array, rasterio_profile).
    """
    import geopandas as gpd

    shp_10m = DATA / "NaturalEarth" / "ne_10m_admin_0_countries_dir" / "ne_10m_admin_0_countries.shp"
    shp_110m = DATA / "NaturalEarth" / "ne_110m_admin_0_countries.shp"
    shp = shp_10m if shp_10m.exists() else shp_110m
    
    if not shp.exists():
        raise FileNotFoundError(f"Natural Earth shapefile not found. Looked for 10m and 110m.")

    world = gpd.read_file(shp)

    width = int(360 / resolution)
    height = int(180 / resolution)
    transform = from_bounds(-180, -90, 180, 90, width, height)

    grid = np.full((height, width), nodata, dtype=np.float32)

    name_map = {}
    import re
    for _, row in world.iterrows():
        country_name = row[name_column]
        for key, val in scores.items():
            if key.lower() == country_name.lower():
                name_map[country_name] = val
                break
            # Use word boundaries to prevent 'Mali' from matching 'Somalia' or 'Niger' from matching 'Nigeria'
            elif re.search(r'\b' + re.escape(key.lower()) + r'\b', country_name.lower()):
                name_map[country_name] = val
                break

    common_aliases = {
        "United States of America": ["United States", "US", "USA"],
        "Russian Federation": ["Russia"],
        "Korea, Republic of": ["South Korea"],
        "Korea, Dem. People's Rep.": ["North Korea"],
        "Congo, Democratic Republic of the": ["DR Congo", "Dem. Rep. Congo", "Congo (Kinshasa)"],
        "Congo": ["Congo (Brazzaville)", "Republic of the Congo"],
        "CÃ´te d'Ivoire": ["Ivory Coast", "Cote d'Ivoire"],
        "Côte d'Ivoire": ["Ivory Coast", "Cote d'Ivoire"],
        "Bosnia and Herz.": ["Bosnia And Herzegovina", "Bosnia and Herzegovina"],
        "Czechia": ["Czech Republic"],
        "Dominican Rep.": ["Dominican Republic"],
        "Hong Kong": ["Hong Kong (China)"],
        "Macao": ["Macao (China)"],
        "Macedonia": ["North Macedonia"],
        "Swaziland": ["Eswatini"],
        "Eswatini": ["Swaziland"],
        "Iran, Islamic Rep.": ["Iran"],
        "Lao PDR": ["Laos"],
        "Syrian Arab Republic": ["Syria"],
        "Venezuela, RB": ["Venezuela"],
        "Yemen, Rep.": ["Yemen"],
        "Turkiye": ["Turkey"],
        "Kosovo": ["Kosovo (Disputed Territory)"],
        "United States Virgin Islands": ["Us Virgin Islands"]
    }

    for _, row in world.iterrows():
        country_name = row[name_column]
        if country_name in name_map:
            continue
        for alias_key, aliases in common_aliases.items():
            if country_name == alias_key:
                for a in aliases:
                    if a in scores:
                        name_map[country_name] = scores[a]
                        break
            for a in aliases:
                if country_name == a:
                    if alias_key in scores:
                        name_map[country_name] = scores[alias_key]
                        break

    from rasterio.features import rasterize as rio_rasterize

    shapes = []
    for _, row in world.iterrows():
        country_name = row[name_column]
        if country_name in name_map:
            shapes.append((row.geometry, name_map[country_name]))

    if shapes:
        grid = rio_rasterize(
            shapes,
            out_shape=(height, width),
            transform=transform,
            fill=nodata,
            dtype=np.float32,
        )

    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "width": width,
        "height": height,
        "count": 1,
        "crs": "EPSG:4326",
        "transform": transform,
        "nodata": nodata,
        "compress": "deflate",
    }

    matched = len(name_map)
    total = len(scores)
    print(f"  Matched {matched}/{total} scores to {len(world)} country polygons")
    if return_map:
        return grid, profile, name_map
    return grid, profile


def process_gdp():
    """Kummu et al. gridded GDP per capita (admin-2, 1990-2024) -> gdp_YYYY.pmtiles

    Uses the Zenodo dataset: 35-band GeoTIFF where band N = year 1990+(N-1).
    Resolution: ~10 km (5 arc-min). Covers 1990-2024.
    Falls back to World Bank country-level XML if gridded data is missing.
    """
    print("\n=== GDP PER CAPITA ===")

    gridded_path = DATA / "GriddedGDP" / "rast_adm2_gdp_perCapita_1990_2024.tif"

    if gridded_path.exists():
        print("  Using Kummu et al. gridded GDP (admin-2, ~10 km)")
        # Process select years for the time slider (every 5 years + latest)
        target_years = [2000, 2005, 2010, 2015, 2020, 2024]
        base_year = 1990
        results = []

        with rasterio.open(gridded_path) as src:
            total_bands = src.count
            print(f"  Source: {src.width}x{src.height}, {total_bands} bands (1990-2024)")

            for year in target_years:
                band_idx = year - base_year + 1
                if band_idx < 1 or band_idx > total_bands:
                    print(f"  WARNING: Band for {year} out of range, skipping")
                    continue

                print(f"\n--- GDP {year} (band {band_idx}) ---")
                out_path = TILES / "gdp" / f"gdp_{year}.pmtiles"
                if out_path.exists():
                    print(f"  Skipping {out_path.name} (already exists)")
                    results.append((str(year), out_path))
                    continue

                arr = src.read(band_idx).astype(np.float32)
                arr[np.isnan(arr)] = -9999
                arr[arr <= 0] = -9999

                tif_path = TILES / "gdp" / f"gdp_{year}_raw.tif"
                ensure_dir(tif_path.parent)
                profile = src.profile.copy()
                profile.update(count=1, dtype="float32", nodata=-9999, compress="deflate")
                with rasterio.open(tif_path, "w", **profile) as dst:
                    dst.write(arr, 1)

                out = full_pipeline(tif_path, "gdp", year=str(year),
                                    data_min=0, data_max=80000,
                                    log_transform=True, nodata_val=-9999)
                tif_path.unlink(missing_ok=True)
                results.append((str(year), out))

        return results

    # Fallback: World Bank country-level
    print("  Gridded GDP not found, falling back to World Bank country-level")
    xml_path = DATA / "WorldBank" / "gdp_per_capita.xml"
    if not xml_path.exists():
        print(f"  ERROR: {xml_path} not found")
        return None

    import xml.etree.ElementTree as ET
    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
        ns = {'wb': 'http://www.worldbank.org'}
        scores = {}
        for data in root.findall('wb:data', ns):
            country_elem = data.find('wb:country', ns)
            val_elem = data.find('wb:value', ns)
            if country_elem is not None and country_elem.text and val_elem is not None and val_elem.text:
                try:
                    scores[country_elem.text] = float(val_elem.text)
                except ValueError:
                    pass
    except Exception as e:
        print(f"  ERROR parsing XML: {e}")
        return None

    if not scores:
        print("  ERROR: No valid GDP scores found in XML")
        return None

    grid, profile = rasterize_country_data(scores, nodata=-9999)
    tif_path = TILES / "gdp" / "gdp_raw.tif"
    ensure_dir(tif_path.parent)
    with rasterio.open(tif_path, "w", **profile) as dst:
        dst.write(grid, 1)
    out = full_pipeline(tif_path, "gdp", log_transform=True, data_min=0, data_max=80000, nodata_val=-9999)
    tif_path.unlink(missing_ok=True)
    return out


def process_risk():
    """Multi-hazard composite risk -> risk.pmtiles

    Combines pixel-level data:
      1. GEM seismic PGA (v2023.1, ~5 km) -- earthquake risk
      2. JRC river flood inundation depth (100yr return, ~1 km) -- flood risk
      3. Low-elevation coastal zone (from ETOPO) -- sea-level-rise risk
      4. Steep slopes (from ETOPO) -- landslide risk
    Each component is normalized 0-1, then combined as max(components).
    Final output: 0 = lowest risk, 100 = highest risk.

    Falls back to INFORM country-level if GEM data not found.
    """
    print("\n=== HAZARD RISK (Multi-hazard composite) ===")

    gem_path = DATA / "Hazard" / "v2023_1_pga_475_rock_3min.tif"
    flood_path = DATA / "Hazard" / "floodMapGL_rp100y.tif"
    etopo_path = None
    for f in (DATA / "ETOPO").glob("*.tif"):
        etopo_path = f
        break

    if gem_path.exists():
        print("  Using GEM seismic + JRC flood + ETOPO composite")
        import subprocess

        work_dir = TILES / "risk"
        ensure_dir(work_dir)

        # Target grid: 0.05 degree (~5 km)
        target_res = 0.05
        target_w = int(360 / target_res)
        target_h = int(180 / target_res)
        print(f"  Target grid: {target_w}x{target_h} ({target_res} deg)")

        # --- Component 1: Seismic PGA ---
        print("  Component 1: Seismic PGA")
        seismic_aligned = work_dir / "seismic_aligned.tif"
        subprocess.run([
            "gdalwarp", "-t_srs", "EPSG:4326",
            "-te", "-180", "-90", "180", "90",
            "-ts", str(target_w), str(target_h),
            "-r", "bilinear", "-overwrite",
            str(gem_path), str(seismic_aligned)
        ], check=True, capture_output=True)

        with rasterio.open(seismic_aligned) as src:
            pga = src.read(1).astype(np.float32)
            target_profile = src.profile.copy()
        pga = np.clip(pga, 0, 4) / 4.0
        print(f"    PGA stats: mean={np.nanmean(pga):.3f}, max={np.nanmax(pga):.3f}")

        # --- Component 2: JRC River Flood ---
        flood_risk = np.zeros_like(pga)
        if flood_path.exists():
            print("  Component 2: JRC river flood inundation (100yr)")
            flood_aligned = work_dir / "flood_aligned.tif"
            subprocess.run([
                "gdalwarp", "-t_srs", "EPSG:4326",
                "-te", "-180", "-90", "180", "90",
                "-ts", str(target_w), str(target_h),
                "-r", "max", "-overwrite",
                str(flood_path), str(flood_aligned)
            ], check=True, capture_output=True)

            with rasterio.open(flood_aligned) as src:
                flood_depth = src.read(1).astype(np.float32)
            # Depth in meters; >0 = flood-prone. Cap at 5m for normalization.
            flood_depth[flood_depth < 0] = 0
            flood_risk = np.clip(flood_depth / 5.0, 0, 1)
            flood_aligned.unlink(missing_ok=True)
            print(f"    Flood risk: {np.sum(flood_risk > 0.1)} px flood-prone, "
                  f"{np.sum(flood_risk > 0.5)} px high risk (>2.5m)")
        else:
            print("  Component 2: JRC flood data not found, skipping")

        # --- Components 3-4: Elevation-derived ---
        coastal_risk = np.zeros_like(pga)
        slope_risk = np.zeros_like(pga)
        if etopo_path:
            print("  Components 3-4: Coastal sea-level-rise + steep slope from ETOPO")
            etopo_aligned = work_dir / "etopo_aligned.tif"
            subprocess.run([
                "gdalwarp", "-t_srs", "EPSG:4326",
                "-te", "-180", "-90", "180", "90",
                "-ts", str(target_w), str(target_h),
                "-r", "bilinear", "-overwrite",
                str(etopo_path), str(etopo_aligned)
            ], check=True, capture_output=True)

            with rasterio.open(etopo_aligned) as src:
                elev = src.read(1).astype(np.float32)

            land = elev > 0
            coastal_risk[land] = np.exp(-elev[land] / 5.0)
            print(f"    Coastal risk: {np.sum(coastal_risk > 0.5)} px at high risk (<3.5m)")

            dy = np.gradient(elev, axis=0)
            dx = np.gradient(elev, axis=1)
            slope = np.sqrt(dx**2 + dy**2)
            slope_risk = np.clip(slope / 500.0, 0, 1)
            print(f"    Slope risk: {np.sum(slope_risk > 0.5)} px at high risk")
            etopo_aligned.unlink(missing_ok=True)
        else:
            print("  WARNING: ETOPO not found, elevation-derived risks skipped")

        # --- Combine: use max across all components ---
        composite = np.maximum(pga, np.maximum(flood_risk,
                     np.maximum(coastal_risk, slope_risk)))
        composite = (composite * 100).astype(np.float32)

        tif_path = work_dir / "risk_composite_raw.tif"
        target_profile.update(count=1, dtype="float32", nodata=-9999, compress="deflate")
        with rasterio.open(tif_path, "w", **target_profile) as dst:
            dst.write(composite, 1)

        out = full_pipeline(tif_path, "risk", data_min=0, data_max=100,
                            invert=True, nodata_val=-9999)

        # Cleanup intermediates
        seismic_aligned.unlink(missing_ok=True)
        if etopo_path:
            (work_dir / "etopo_aligned.tif").unlink(missing_ok=True)
        tif_path.unlink(missing_ok=True)

        return out

    # Fallback: INFORM country-level
    print("  GEM seismic data not found, falling back to INFORM country-level")
    try:
        import pandas as pd
    except ImportError:
        print("  ERROR: pandas required")
        return None

    risk_file = None
    for f in (DATA / "INFORM").glob("*.xlsx"):
        risk_file = f
        break

    if not risk_file:
        print("  ERROR: INFORM Risk Excel file not found in data/INFORM/")
        return None

    xls = pd.ExcelFile(risk_file)
    sheet_name = None
    for s in xls.sheet_names:
        if "INFORM Risk" in s and "(a-z)" in s:
            sheet_name = s
            break

    if not sheet_name:
        print("  ERROR: Could not find correct sheet in INFORM Excel file")
        return None

    df = pd.read_excel(risk_file, sheet_name=sheet_name, skiprows=1)
    scores = {}
    for _, row in df.iterrows():
        try:
            country = str(row["COUNTRY"]).strip()
            score = row["INFORM RISK"]
            if country != "(a-z)" and pd.notna(score):
                scores[country] = float(score)
        except (ValueError, KeyError, TypeError):
            continue

    if not scores:
        print("  ERROR: No valid risk scores parsed")
        return None

    print(f"  Parsed {len(scores)} risk scores")
    grid, profile = rasterize_country_data(scores, nodata=-9999)
    tif_path = TILES / "risk" / "risk_raw.tif"
    ensure_dir(tif_path.parent)
    with rasterio.open(tif_path, "w", **profile) as dst:
        dst.write(grid, 1)
    out = full_pipeline(tif_path, "risk", data_min=0, data_max=10, invert=True, nodata_val=-9999)
    tif_path.unlink(missing_ok=True)
    return out


def _parse_fiw_historical() -> dict[int, dict[str, float]]:
    """Parse FreedomHouse FIW_Country_Ratings_1973-2022.xlsx.
    Returns {review_year: {country_name: freedom_score_0_100}}.
    PR+CL range 2 (most free) to 14 (least free), mapped to 0-100 where 100=most free.
    """
    import re
    import pandas as pd

    path = DATA / "FreedomHouse" / "FIW_Country_Ratings_1973-2022.xlsx"
    if not path.exists():
        return {}

    df = pd.read_excel(path, sheet_name="Country Ratings, Statuses ", header=None)

    # Row 0 has survey edition labels (e.g. "Jan.-Feb. 1973", "2022")
    # Each year occupies 3 columns: PR, CL, Status
    # Survey edition year reviews the prior year (survey 2022 -> reviews 2021)
    year_cols = {}
    for col_idx, val in enumerate(df.iloc[0]):
        if col_idx == 0 or pd.isna(val):
            continue
        nums = re.findall(r"(\d{4})", str(val))
        if nums:
            review_year = int(nums[-1]) - 1
            year_cols[col_idx] = review_year

    result = {}
    for row_idx in range(2, len(df)):
        country = df.iloc[row_idx, 0]
        if pd.isna(country):
            continue
        country = str(country).strip()
        if not country:
            continue
        for col_idx, year in year_cols.items():
            pr = df.iloc[row_idx, col_idx]
            cl = df.iloc[row_idx, col_idx + 1]
            if pd.notna(pr) and pr != "-" and pd.notna(cl) and cl != "-":
                try:
                    score = 100.0 - ((float(pr) + float(cl) - 2) / 12 * 100.0)
                    result.setdefault(year, {})[country] = round(score, 1)
                except (ValueError, TypeError):
                    pass
    return result


def _parse_cpi_historical() -> dict[int, dict[str, float]]:
    """Parse CPI/global-cpi-all.csv. Returns {year: {country_name: score_0_100}}."""
    import csv

    path = DATA / "CPI" / "global-cpi-all.csv"
    if not path.exists():
        return {}

    result = {}
    with open(path, "r", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                year = int(row["year"])
                country = row["country"].strip()
                score = float(row["score"])
                result.setdefault(year, {})[country] = score
            except (ValueError, KeyError):
                continue
    return result


def process_free():
    """FIW (1972-2021) + CPI (2012-2025) -> free_YYYY.pmtiles + free_scores.json"""
    print("\n=== POLITICAL FREEDOM (temporal) ===")

    try:
        import pandas as pd
    except ImportError:
        print("  ERROR: pandas required")
        return None

    fiw_by_year = _parse_fiw_historical()
    cpi_by_year = _parse_cpi_historical()

    if not fiw_by_year and not cpi_by_year:
        print("  ERROR: No FIW or CPI data found")
        return None

    print(f"  FIW: {min(fiw_by_year) if fiw_by_year else 'N/A'}-"
          f"{max(fiw_by_year) if fiw_by_year else 'N/A'} "
          f"({len(fiw_by_year)} years)")
    print(f"  CPI: {min(cpi_by_year) if cpi_by_year else 'N/A'}-"
          f"{max(cpi_by_year) if cpi_by_year else 'N/A'} "
          f"({len(cpi_by_year)} years)")

    target_years = range(2000, 2026)
    results = []
    scores_by_year: dict[str, dict[str, dict]] = {}

    for year in target_years:
        print(f"\n--- Freedom {year} ---")
        out_path = TILES / "free" / f"free_{year}.pmtiles"

        fiw = fiw_by_year.get(year, {})
        cpi = cpi_by_year.get(year, {})

        composite = {}
        year_scores: dict[str, dict] = {}
        all_countries = set(fiw.keys()) | set(cpi.keys())
        for country in all_countries:
            fiw_val = fiw.get(country)
            cpi_val = cpi.get(country)
            if fiw_val is not None and cpi_val is not None:
                comp = fiw_val * 0.5 + cpi_val * 0.5
            elif fiw_val is not None:
                comp = fiw_val
            elif cpi_val is not None:
                comp = cpi_val
            else:
                continue
            composite[country] = comp
            entry: dict = {"composite": round(comp, 1)}
            if fiw_val is not None:
                entry["fiw"] = round(fiw_val, 1)
            if cpi_val is not None:
                entry["cpi"] = round(cpi_val, 1)
            year_scores[country] = entry

        scores_by_year[str(year)] = year_scores

        if not composite:
            print(f"  WARNING: No data for {year}, skipping")
            continue

        print(f"  Composite: {len(composite)} countries "
              f"(FIW={len(fiw)}, CPI={len(cpi)})")

        if out_path.exists():
            print(f"  Skipping {out_path.name} (already exists)")
            results.append((str(year), out_path))
            continue

        grid, profile = rasterize_country_data(composite)

        tif_path = TILES / "free" / f"free_{year}_raw.tif"
        ensure_dir(tif_path.parent)
        with rasterio.open(tif_path, "w", **profile) as dst:
            dst.write(grid, 1)

        out = full_pipeline(tif_path, "free", year=str(year),
                            data_min=0, data_max=100, nodata_val=0)
        tif_path.unlink(missing_ok=True)
        results.append((str(year), out))

    # Normalize country names to match the GeoJSON used for tooltip hit-testing
    import json
    try:
        import geopandas as gpd
        shp_path = DATA / "NaturalEarth" / "ne_110m_admin_0_countries.shp"
        if shp_path.exists():
            gdf = gpd.read_file(shp_path)
            geo_names = set(gdf["NAME"].dropna().tolist())
        else:
            geo_names = set()
    except Exception:
        geo_names = set()

    if geo_names:
        # Build alias -> GeoJSON name map (same logic as rasterize_country_data)
        alias_to_geo: dict[str, str] = {}
        for gn in geo_names:
            alias_to_geo[gn] = gn
            alias_to_geo[gn.lower()] = gn

        # Common alternate spellings
        _name_aliases = {
            "United States": "United States of America",
            "USA": "United States of America",
            "US": "United States of America",
            "Congo (Brazzaville)": "Congo",
            "Republic of the Congo": "Congo",
            "Congo (Kinshasa)": "Dem. Rep. Congo",
            "Democratic Republic of the Congo": "Dem. Rep. Congo",
            "DR Congo": "Dem. Rep. Congo",
            "DRC": "Dem. Rep. Congo",
            "Czech Republic": "Czechia",
            "Czechia": "Czechia",
            "Cote d'Ivoire": "C\u00f4te d'Ivoire",
            "Ivory Coast": "C\u00f4te d'Ivoire",
            "Bosnia and Herzegovina": "Bosnia and Herz.",
            "Dominican Republic": "Dominican Rep.",
            "Central African Republic": "Central African Rep.",
            "Equatorial Guinea": "Eq. Guinea",
            "South Sudan": "S. Sudan",
            "Solomon Islands": "Solomon Is.",
            "Eswatini": "eSwatini",
            "The Gambia": "Gambia",
            "Timor-Leste": "Timor-Leste",
            "Brunei Darussalam": "Brunei",
            "North Korea": "North Korea",
            "South Korea": "South Korea",
            "Korea, South": "South Korea",
            "Korea, North": "North Korea",
            "Korea, Republic of": "South Korea",
            "Korea (South)": "South Korea",
            "Korea (North)": "North Korea",
        }
        for alias, canonical in _name_aliases.items():
            if canonical in geo_names:
                alias_to_geo[alias] = canonical
                alias_to_geo[alias.lower()] = canonical

        normalized: dict[str, dict[str, dict]] = {}
        for yr, countries in scores_by_year.items():
            merged: dict[str, dict] = {}
            for name, vals in countries.items():
                geo_name = alias_to_geo.get(name) or alias_to_geo.get(name.lower())
                key = geo_name if geo_name else name
                if key in merged:
                    # Merge: prefer entry that has more sub-scores
                    existing = merged[key]
                    for k, v in vals.items():
                        if k not in existing:
                            existing[k] = v
                else:
                    merged[key] = dict(vals)
            normalized[yr] = merged
        scores_by_year = normalized

    scores_path = TILES / "free" / "free_scores.json"
    ensure_dir(scores_path.parent)
    with open(scores_path, "w") as f:
        json.dump(scores_by_year, f, separators=(",", ":"))
    print(f"\n  Sub-scores JSON -> {scores_path.name} "
          f"({scores_path.stat().st_size / 1024:.0f} KB, "
          f"{len(scores_by_year)} years)")

    return results


def process_inet():
    """Ookla Speedtest -> inet.pmtiles"""
    print("\n=== CONNECTIVITY (Ookla) ===")
    pq = DATA / "Ookla" / "2024-Q4-fixed.parquet"
    if not pq.exists():
        print(f"  ERROR: {pq} not found")
        return None

    try:
        import pandas as pd
    except ImportError:
        print("  ERROR: pandas required for Ookla processing")
        return None

    print("  Reading Parquet...")
    df = pd.read_parquet(pq)
    print(f"  {len(df)} tiles loaded")

    if "tile" in df.columns and "avg_d_kbps" in df.columns:
        geom_col = "tile"
    elif "quadkey" in df.columns and "avg_d_kbps" in df.columns:
        geom_col = "quadkey"
    else:
        print(f"  ERROR: Unexpected columns: {list(df.columns)[:10]}")
        return None

    from shapely import wkt
    print("  Parsing geometries and computing centroids...")
    geoms = df[geom_col].apply(wkt.loads) if geom_col == "tile" else None

    if geoms is not None:
        lons = geoms.apply(lambda g: g.centroid.x).values
        lats = geoms.apply(lambda g: g.centroid.y).values
    else:
        print("  ERROR: Cannot parse quadkey geometries without shapely WKT column")
        return None

    speeds = df["avg_d_kbps"].values.astype(np.float64)

    res = 0.05
    x_bins = np.arange(-180, 180 + res, res)
    y_bins = np.arange(-90, 90 + res, res)

    print(f"  Rasterizing {len(speeds)} points to {len(x_bins)-1}x{len(y_bins)-1} grid...")
    xi = np.digitize(lons, x_bins) - 1
    yi = np.digitize(lats, y_bins) - 1

    grid_sum = np.zeros((len(y_bins) - 1, len(x_bins) - 1), dtype=np.float64)
    grid_count = np.zeros_like(grid_sum)

    valid = (xi >= 0) & (xi < grid_sum.shape[1]) & (yi >= 0) & (yi < grid_sum.shape[0])
    for i in range(len(speeds)):
        if valid[i]:
            grid_sum[yi[i], xi[i]] += speeds[i]
            grid_count[yi[i], xi[i]] += 1

    mask = grid_count > 0
    grid = np.zeros_like(grid_sum)
    grid[mask] = grid_sum[mask] / grid_count[mask]
    grid = np.flipud(grid)

    tif_path = TILES / "inet" / "inet_raw.tif"
    ensure_dir(tif_path.parent)
    transform = from_bounds(-180, -90, 180, 90, grid.shape[1], grid.shape[0])

    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "width": grid.shape[1],
        "height": grid.shape[0],
        "count": 1,
        "crs": "EPSG:4326",
        "transform": transform,
        "nodata": 0,
        "compress": "deflate",
    }
    with rasterio.open(tif_path, "w", **profile) as dst:
        dst.write(grid.astype(np.float32), 1)

    # 1000 Mbps = 1,000,000 kbps
    out = full_pipeline(tif_path, "inet", data_min=0, data_max=1000000, log_transform=True, nodata_val=0)
    tif_path.unlink(missing_ok=True)
    return out


# ---------------------------------------------------------------------------
# Catalog generation
# ---------------------------------------------------------------------------

_HASH_RE = re.compile(r"^([a-z0-9_]+?)\.([0-9a-f]{6,16})\.pmtiles$")


def _content_hash(path: Path, n: int = 10) -> str:
    """First N hex chars of SHA-256 over the file. Reads in 1 MB chunks
    so 100+ MB pmtiles don't blow up memory."""
    import hashlib
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:n]


def _rehash_static_archive(axis_dir: Path, axis_id: str) -> Path | None:
    """For a static axis directory, ensure the single archive lives under a
    content-hashed filename like `axis.<hash>.pmtiles`. Returns the resolved
    path, or None if the directory is empty.

    Idempotent on re-runs: if only `axis.<hash>.pmtiles` already exists,
    we trust the existing hash and return it without re-reading the file.
    """
    canonical = axis_dir / f"{axis_id}.pmtiles"
    hashed = sorted(axis_dir.glob(f"{axis_id}.*.pmtiles"))
    hashed = [p for p in hashed if _HASH_RE.match(p.name)]

    if canonical.exists():
        h = _content_hash(canonical)
        new_path = axis_dir / f"{axis_id}.{h}.pmtiles"
        for old in hashed:
            if old != new_path:
                old.unlink()
        if new_path.exists() and new_path != canonical:
            canonical.unlink()
        else:
            canonical.rename(new_path)
        return new_path

    if hashed:
        # Keep the most recently modified hashed file; drop any stragglers.
        keep = max(hashed, key=lambda p: p.stat().st_mtime)
        for old in hashed:
            if old != keep:
                old.unlink()
        return keep

    return None


def build_catalog():
    """Scan tiles/ directory and generate catalog.json.

    For static axes we content-hash the archive filename so a CDN can serve
    them with `Cache-Control: immutable` -- a republish will change the
    hash and busts caches automatically without manual versioning. The
    resolved filename is written into the catalog as `entry.file`, which
    [app/src/tileDataLoader.ts](app/src/tileDataLoader.ts) prefers when
    present.

    Year-keyed archives keep their `axis_YYYY.pmtiles` names because the
    year is already the version key for those.
    """
    print("\n=== BUILDING CATALOG ===")
    catalog = {}
    tiles_dir = TILES

    for axis_dir in sorted(tiles_dir.iterdir()):
        if not axis_dir.is_dir():
            continue
        axis_id = axis_dir.name
        pmtiles = sorted(axis_dir.glob("*.pmtiles"))
        if not pmtiles:
            continue

        years = []
        projections = {}
        # Treat as static unless we discover year/scenario suffixes below.
        is_static = True

        for pm in pmtiles:
            stem = pm.stem
            if "_ssp" in stem:
                parts = stem.split("_")
                ssp = parts[-2]
                yr = parts[-1]
                projections.setdefault(ssp, []).append(int(yr))
                is_static = False
            elif "_" in stem:
                parts = stem.split("_")
                try:
                    yr = int(parts[-1])
                    years.append(yr)
                    is_static = False
                except ValueError:
                    pass

        entry = {"static": is_static}
        if years:
            entry["years"] = sorted(years)
        if projections:
            entry["projections"] = {k: sorted(v) for k, v in projections.items()}

        if is_static:
            resolved = _rehash_static_archive(axis_dir, axis_id)
            if resolved is not None:
                entry["file"] = resolved.name

        catalog[axis_id] = entry
        n_files = len(list(axis_dir.glob("*.pmtiles")))
        suffix = f", file={entry.get('file')}" if entry.get("file") else ""
        print(f"  {axis_id}: {n_files} file(s), static={is_static}{suffix}")

    with open(CATALOG_PATH, "w") as f:
        json.dump(catalog, f, indent=2)
    print(f"  Catalog written to {CATALOG_PATH}")
    return catalog


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def process_air():
    """PM2.5 V6 NetCDF -> air_YYYY.pmtiles"""
    print("\n=== AIR QUALITY (PM2.5 V6) ===")

    try:
        import netCDF4
    except ImportError:
        print("  ERROR: netCDF4 required")
        return None

    pm_dir = DATA / "PM25"
    results = []

    for nc_file in sorted(pm_dir.glob("PM25_*.nc")):
        year = nc_file.stem.split("_")[1]
        print(f"\n--- Air Quality {year} ---")

        out_path = TILES / "air" / f"air_{year}.pmtiles"
        if out_path.exists():
            print(f"  Skipping {out_path.name} (already exists)")
            results.append((year, out_path))
            continue

        with netCDF4.Dataset(nc_file) as ds:
            pm25 = ds.variables['PM25'][:]
            lats = ds.variables['lat'][:]
            lons = ds.variables['lon'][:]

        # Flip if lat is ascending (south-to-north) so row 0 = north
        if len(lats) > 1 and float(lats[0]) < float(lats[-1]):
            pm25 = np.flipud(pm25)

        height, width = pm25.shape
        lat_min, lat_max = float(lats.min()), float(lats.max())
        lon_min, lon_max = float(lons.min()), float(lons.max())

        tif_path = TILES / "air" / f"air_{year}_raw.tif"
        ensure_dir(tif_path.parent)

        transform = from_bounds(lon_min, lat_min, lon_max, lat_max, width, height)
        profile = {
            "driver": "GTiff",
            "dtype": "float32",
            "width": width,
            "height": height,
            "count": 1,
            "crs": "EPSG:4326",
            "transform": transform,
            "nodata": -999,
            "compress": "deflate",
        }
        with rasterio.open(tif_path, "w", **profile) as dst:
            dst.write(pm25.astype(np.float32), 1)

        masked_path = TILES / "air" / f"air_{year}_masked.tif"
        final_tif = apply_ocean_mask(tif_path, masked_path, nodata_val=-999)

        out = full_pipeline(final_tif, "air", year=year, data_min=0, data_max=70, nodata_val=-999, invert=True)
        tif_path.unlink(missing_ok=True)
        masked_path.unlink(missing_ok=True)
        results.append((year, out))

    return results


def process_solar():
    """Global Solar Atlas GHI -> solar.pmtiles (downsample large raster first)"""
    print("\n=== SOLAR (Global Solar Atlas GHI) ===")

    tif = DATA / "GlobalSolarAtlas" / "World_GHI_GISdata_LTAy_AvgDailyTotals_GlobalSolarAtlas-v2_GEOTIFF" / "GHI.tif"
    if not tif.exists():
        print(f"  ERROR: {tif} not found")
        return None

    out_path = TILES / "solar" / "solar.pmtiles"
    if out_path.exists():
        print(f"  Skipping {out_path.name} (already exists)")
        return out_path

    ensure_dir(TILES / "solar")
    downsampled = TILES / "solar" / "solar_downsampled.tif"

    print("  Step 0: Downsample 250m -> ~4km using gdalwarp...")
    run([
        "gdalwarp",
        "-tr", "0.04166667", "0.04166667",
        "-r", "average",
        "-co", "COMPRESS=DEFLATE",
        "-overwrite",
        str(tif),
        str(downsampled),
    ])

    out = full_pipeline(downsampled, "solar", data_min=0, data_max=7.0, nodata_val=np.nan)
    downsampled.unlink(missing_ok=True)
    return out


# MapSPAM 2020 v2 crop codes -> human-readable names
SPAM_CROPS = {
    "WHEA": "Wheat",       "RICE": "Rice",          "MAIZ": "Maize",
    "BARL": "Barley",      "MILL": "Small Millet",  "PMIL": "Pearl Millet",
    "SORG": "Sorghum",     "OCER": "Other Cereals", "POTA": "Potato",
    "SWPO": "Sweet Potato","YAMS": "Yams",          "CASS": "Cassava",
    "ORTS": "Other Roots", "BEAN": "Bean",          "CHIC": "Chickpea",
    "COWP": "Cowpea",      "PIGE": "Pigeon Pea",    "LENT": "Lentil",
    "OPUL": "Other Pulses","SOYB": "Soybean",       "GROU": "Groundnut",
    "CNUT": "Coconut",     "OILP": "Oil Palm",      "SUNF": "Sunflower",
    "RAPE": "Rapeseed",    "SESA": "Sesame",        "OOIL": "Other Oil Crops",
    "SUGC": "Sugarcane",   "SUGB": "Sugar Beet",    "COTT": "Cotton",
    "OFIB": "Other Fibres","COFF": "Arabica Coffee","RCOF": "Robusta Coffee",
    "COCO": "Cocoa",       "TEAS": "Tea",           "TOBA": "Tobacco",
    "BANA": "Banana",      "PLNT": "Plantain",      "CITR": "Citrus",
    "TROF": "Tropical Fruit", "TEMF": "Temperate Fruit", "TOMA": "Tomato",
    "ONIO": "Onion",       "VEGE": "Vegetables",    "RUBB": "Rubber",
    "REST": "Other Crops",
}


def process_agri():
    """MapSPAM 2020 v2 harvested area -> agri.pmtiles + crops_lookup.json

    Approach:
      - Read all 46 per-crop "all-systems" harvested-area GeoTIFFs (5 arc-min, in hectares).
      - Heatmap: sum across crops -> total harvested area per pixel, log-normalised.
        This shows where farming actually thrives (combines suitability + access + economics).
      - Crops lookup: aggregate to 0.25 deg cells, store top-5 crops per cell as JSON
        served from app/public/ for hover tooltips.

    Source: IFPRI MapSPAM 2020 v2 (https://doi.org/10.7910/DVN/SWPENT)
    """
    print("\n=== AGRICULTURE (MapSPAM 2020 v2 -- harvested area) ===")
    spam_dir = DATA / "MapSPAM" / "spam2020V2r0_global_harvested_area"
    if not spam_dir.exists():
        print(f"  ERROR: {spam_dir} not found.")
        print("  Download MapSPAM 2020 v2 harvested-area GeoTIFFs into that folder.")
        return None

    out_path = TILES / "agri" / "agri.pmtiles"
    lookup_path = ROOT / "app" / "public" / "crops_lookup.json"
    ensure_dir(out_path.parent)
    ensure_dir(lookup_path.parent)

    crop_files = []
    for code in SPAM_CROPS:
        f = spam_dir / f"spam2020_V2r0_global_H_{code}_A.tif"
        if f.exists():
            crop_files.append((code, f))
        else:
            print(f"  WARNING: missing {f.name}")
    if not crop_files:
        print("  ERROR: no MapSPAM crop rasters found")
        return None
    print(f"  Found {len(crop_files)} crop rasters")

    # Read first raster to set grid template
    with rasterio.open(crop_files[0][1]) as src:
        height, width = src.shape
        profile = src.profile.copy()
        bounds = src.bounds
        transform = src.transform
    px_deg = abs(transform.a)
    print(f"  Grid: {width}x{height} @ {px_deg:.4f} deg/pixel "
          f"(~{px_deg * 111:.1f} km/pixel at equator)")

    # Aggregate cell size for the hover lookup (0.25 deg ~ 25 km)
    LOOKUP_DEG = 0.25
    factor = max(1, int(round(LOOKUP_DEG / px_deg)))
    lookup_w = width // factor
    lookup_h = height // factor
    print(f"  Crop lookup grid: {lookup_w}x{lookup_h} @ {factor * px_deg:.3f} deg "
          f"(factor={factor})")

    total_ha = np.zeros((height, width), dtype=np.float64)
    per_crop_lookup = np.zeros((len(crop_files), lookup_h, lookup_w), dtype=np.float32)

    for i, (code, f) in enumerate(crop_files):
        with rasterio.open(f) as src:
            arr = src.read(1)
        arr = np.where(np.isnan(arr), 0.0, arr).astype(np.float32)
        total_ha += arr

        # Aggregate to lookup grid by summing each block
        cropped = arr[: lookup_h * factor, : lookup_w * factor]
        per_crop_lookup[i] = cropped.reshape(lookup_h, factor, lookup_w, factor).sum(axis=(1, 3))
        print(f"  [{i+1:>2}/{len(crop_files)}] {code:<4} {SPAM_CROPS[code]:<18} "
              f"global={arr.sum() / 1e6:8.2f} Mha")

    print(f"  Total harvested area: {total_ha.sum() / 1e6:.1f} Mha")
    nz = total_ha[total_ha > 0]
    if nz.size:
        print(f"  Per-pixel ha: median={np.median(nz):.1f}, "
              f"p95={np.percentile(nz, 95):.1f}, max={nz.max():.1f}")

    # Write raw heatmap GeoTIFF
    raw_tif = TILES / "agri" / "agri_total_ha.tif"
    profile.update(dtype="float32", nodata=-1.0, compress="deflate")
    with rasterio.open(raw_tif, "w", **profile) as dst:
        out = total_ha.astype(np.float32)
        out[out <= 0] = -1.0
        dst.write(out, 1)
    print(f"  Wrote raw heatmap -> {raw_tif.name}")

    # Mask ocean and tile (log-normalised so the long tail of intensive farming
    # doesn't blow out the contrast in moderate areas)
    masked_tif = TILES / "agri" / "agri_total_ha_land.tif"
    final_tif = apply_ocean_mask(raw_tif, masked_tif, nodata_val=-1.0)

    # Cap at 99th percentile of nonzero land cells so the colour ramp uses the
    # bulk of the data range rather than a few high-intensity outliers.
    with rasterio.open(final_tif) as src:
        sample = src.read(1)
    valid = sample[sample > 0]
    cap = float(np.percentile(valid, 99.5)) if valid.size else 5000.0
    print(f"  Heatmap cap (p99.5 ha/pixel): {cap:.1f}")

    out = full_pipeline(
        final_tif,
        "agri",
        data_min=0,
        data_max=cap,
        log_transform=True,
        nodata_val=-1.0,
        resampling="bilinear",
    )
    raw_tif.unlink(missing_ok=True)
    if final_tif != raw_tif:
        final_tif.unlink(missing_ok=True)

    # ---------- Build crops lookup JSON for hover tooltips ----------
    print("\n  Building crops lookup JSON for hover tooltips...")
    crop_codes = [c for c, _ in crop_files]
    crop_names = [SPAM_CROPS[c] for c, _ in crop_files]

    cell_total = per_crop_lookup.sum(axis=0)
    nonzero = np.argwhere(cell_total > 1.0)  # at least 1 hectare across crops
    print(f"  Cells with >=1 ha total: {len(nonzero):,} / {lookup_h * lookup_w:,}")

    cells = {}
    TOP_N = 5
    for iy, ix in nonzero:
        col = per_crop_lookup[:, iy, ix]
        order = np.argsort(col)[::-1]
        top = []
        for idx in order[:TOP_N]:
            ha = float(col[idx])
            if ha <= 0:
                break
            # [crop_index, hectares] -- crop_index refers to position in crops array
            top.append([int(idx), int(round(ha))])
        if top:
            cells[f"{int(iy)}_{int(ix)}"] = top

    lookup_doc = {
        "source": "IFPRI MapSPAM 2020 v2 -- harvested area, all systems",
        "source_url": "https://doi.org/10.7910/DVN/SWPENT",
        "year": 2020,
        "units": "hectares",
        "resolution_deg": factor * px_deg,
        "origin": {"lat": float(bounds.top), "lng": float(bounds.left)},
        "ny": int(lookup_h),
        "nx": int(lookup_w),
        "top_n": TOP_N,
        "crops": crop_names,
        "cells": cells,
    }
    with open(lookup_path, "w") as f:
        json.dump(lookup_doc, f)
    size_mb = lookup_path.stat().st_size / 1024 / 1024
    print(f"  Wrote {len(cells):,} cells -> {lookup_path.name} ({size_mb:.2f} MB)")

    # Clean up obsolete year-suffixed agri tiles from the previous pipeline
    for old in (TILES / "agri").glob("agri_*.pmtiles"):
        if old != out:
            print(f"  Removing obsolete {old.name}")
            old.unlink()

    return out


# --- Zabel agricultural suitability v3 (climate-aware crop potential) ---
# Plant index -> crop name. Source: data_description.txt inside zabel zip.
ZABEL_CROPS = [
    "Barley", "Cassava", "Groundnut", "Maize", "Millet", "Oil palm",
    "Potato", "Rapeseed", "Paddy rice", "Rye", "Sorghum", "Soy",
    "Sugarcane", "Sunflower", "Summer wheat", "Winter wheat", "Sugarbeet",
    "Jatropha", "Miscanthus", "Switchgrass", "Reed canary grass",
    "Eucalyptus", "Willow",
]

# Period (folder name) -> (slider year for this midpoint, scenario tag).
# We deliberately ship only the high-emissions (RCP8.5 / SSP5-8.5) projection so
# the timeline stays a single continuous "what could happen" line rather than a
# branching scenario picker.  Add the rcp2p6 entries here if you want to expose
# a low-emissions option later.
ZABEL_PERIODS = [
    ("1980-2009_hist",     1995, "historical"),
    ("2010-2039_rcp8p5",   2025, "ssp585"),
    ("2040-2069_rcp8p5",   2055, "ssp585"),
    ("2070-2099_rcp8p5",   2085, "ssp585"),
]


def _bil_to_geotiff(bil_path: Path, out_tif: Path) -> Path:
    """Read a Zabel BIL raster (uint8, 0-100, NODATA=255) and write a GeoTIFF
    with proper EPSG:4326 georeferencing.  Returns out_tif path.

    The BIL header says the upper-left pixel center is at ~89.9958N, so the
    pixel edge sits exactly at 90.0N -- which blows up Web Mercator (rio-pmtiles
    can't project lat>=85).  We clip the top of the raster to the Mercator-safe
    latitude (85N) before writing.  The Arctic isn't crop country anyway.
    """
    MERC_LAT_LIMIT = 85.0
    with rasterio.open(bil_path) as src:
        arr = src.read(1)
        bounds = src.bounds
        height, width = arr.shape

    # How many rows lie above lat=85?  Strip them off.
    px_h = (bounds.top - bounds.bottom) / height
    if bounds.top > MERC_LAT_LIMIT:
        skip = int(np.ceil((bounds.top - MERC_LAT_LIMIT) / px_h))
        arr = arr[skip:, :]
        new_top = bounds.top - skip * px_h
    else:
        new_top = bounds.top

    new_bottom = max(bounds.bottom, -MERC_LAT_LIMIT)
    if bounds.bottom < -MERC_LAT_LIMIT:
        skip_b = int(np.ceil((-MERC_LAT_LIMIT - bounds.bottom) / px_h))
        if skip_b > 0:
            arr = arr[: arr.shape[0] - skip_b, :]
            new_bottom = bounds.bottom + skip_b * px_h

    height_new, width_new = arr.shape
    # Snap longitudes to exactly +/-180 -- the BIL header carries tiny rounding
    # errors (~1e-6 deg) that wrap east past 180 in Mercator, breaking
    # rio-pmtiles' max-zoom autodetection (log2(0) -> domain error).
    new_left = max(-180.0, bounds.left)
    new_right = min(180.0, bounds.right)
    transform = from_bounds(new_left, new_bottom, new_right, new_top, width_new, height_new)
    profile = {
        "driver": "GTiff",
        "dtype": "uint8",
        "width": width_new,
        "height": height_new,
        "count": 1,
        "crs": "EPSG:4326",
        "transform": transform,
        "nodata": 255,
        "compress": "deflate",
        "tiled": True,
    }
    ensure_dir(out_tif.parent)
    with rasterio.open(out_tif, "w", **profile) as dst:
        dst.write(arr, 1)
    return out_tif


def process_agrip():
    """Zabel et al. 2014 v3 agricultural suitability -> agrip_*.pmtiles + crops_lookup_agrip.json

    Approach:
      - For each (time period, RCP/SSP) combo, read the global ``overall_suitability.bil``
        (30 arc-sec uint8 0-100 with 255 = NODATA), wrap in a real GeoTIFF, and tile.
      - Builds 7 layers total: 1 historical baseline + 3 future midpoints * 2 scenarios.
      - Hover lookup: aggregate the 23 per-crop ``plantspecific_suitability_*.bil`` rasters
        from the historical baseline into 0.25 deg cells (mean suitability per crop), keep
        the top-5 crops per cell.

    Source: Zabel et al. 2014 -- Global Agricultural Suitability v3
            (https://doi.org/10.5281/zenodo.5982577)
    """
    print("\n=== AGRICULTURE POTENTIAL (Zabel v3 -- crop suitability) ===")
    z_root = DATA / "Zabel" / "extracted"
    if not z_root.exists():
        print(f"  ERROR: {z_root} not found.")
        print("  Download + extract Zabel v3 first (see README).")
        return None

    out_dir = TILES / "agrip"
    ensure_dir(out_dir)
    lookup_path = ROOT / "app" / "public" / "crops_lookup_agrip.json"
    ensure_dir(lookup_path.parent)

    # ---------- A. Heatmap PMTiles for every (period, scenario) ----------
    results = []
    for folder, year, scenario in ZABEL_PERIODS:
        bil = z_root / folder / "overall_suitability.bil"
        if not bil.exists():
            print(f"  WARNING: missing {bil}")
            continue

        suffix = str(year) if scenario == "historical" else f"{scenario}_{year}"
        out_path = out_dir / f"agrip_{suffix}.pmtiles"
        if out_path.exists():
            print(f"  Skipping {out_path.name} (already exists)")
            results.append((suffix, out_path))
            continue

        print(f"\n--- Agrip {folder} -> agrip_{suffix} ---")
        tif = out_dir / f"agrip_{suffix}_raw.tif"
        _bil_to_geotiff(bil, tif)

        # Ocean-mask so coastal NODATA fringe doesn't bleed into the colour ramp.
        masked = out_dir / f"agrip_{suffix}_land.tif"
        final_tif = apply_ocean_mask(tif, masked, nodata_val=255)

        # The values are already 0-100 -- normalise that range linearly.
        out = full_pipeline(
            final_tif,
            "agrip",
            year=suffix,
            data_min=0,
            data_max=100,
            log_transform=False,
            nodata_val=255,
            resampling="bilinear",
        )
        tif.unlink(missing_ok=True)
        if final_tif != tif:
            final_tif.unlink(missing_ok=True)
        results.append((suffix, out))

    # ---------- B. Per-crop hover lookup from the historical baseline ----------
    print("\n  Building crops_lookup_agrip.json (top crops by suitability)...")
    base_dir = z_root / "1980-2009_hist"
    if not base_dir.exists():
        print(f"  WARNING: {base_dir} missing -- skipping hover lookup")
        return results

    # Inspect any per-crop raster to grab the grid template.
    template = base_dir / "plantspecific_suitability_1.bil"
    if not template.exists():
        print(f"  WARNING: {template} missing -- skipping hover lookup")
        return results

    with rasterio.open(template) as src:
        height, width = src.shape
        bounds = src.bounds
    px_deg = (bounds.right - bounds.left) / width

    LOOKUP_DEG = 0.25
    factor = max(1, int(round(LOOKUP_DEG / px_deg)))
    lookup_w = width // factor
    lookup_h = height // factor
    print(f"  Grid: {width}x{height} @ {px_deg:.4f} deg/pix; "
          f"lookup: {lookup_w}x{lookup_h} @ {factor*px_deg:.3f} deg "
          f"(factor={factor})")

    # mean suitability per crop in each lookup cell
    per_crop = np.zeros((len(ZABEL_CROPS), lookup_h, lookup_w), dtype=np.float32)

    for i, name in enumerate(ZABEL_CROPS):
        bil = base_dir / f"plantspecific_suitability_{i+1}.bil"
        if not bil.exists():
            print(f"  WARNING: missing {bil.name}")
            continue
        with rasterio.open(bil) as src:
            arr = src.read(1)
        # Treat NODATA (255) as 0 so it doesn't drag the mean
        arr = np.where(arr == 255, 0, arr).astype(np.float32)
        cropped = arr[: lookup_h * factor, : lookup_w * factor]
        block = cropped.reshape(lookup_h, factor, lookup_w, factor)
        per_crop[i] = block.mean(axis=(1, 3))
        peak = float(arr.max())
        global_mean = float(arr[arr > 0].mean()) if np.any(arr > 0) else 0.0
        print(f"  [{i+1:>2}/{len(ZABEL_CROPS)}] {name:<18} "
              f"peak={peak:5.1f}  land-mean={global_mean:5.2f}")

    cell_max = per_crop.max(axis=0)
    nonzero = np.argwhere(cell_max > 1.0)  # at least 1% suitability for something
    print(f"  Cells with any suitable crop: {len(nonzero):,} / {lookup_h * lookup_w:,}")

    cells: dict[str, list[list[int]]] = {}
    TOP_N = 5
    for iy, ix in nonzero:
        col = per_crop[:, iy, ix]
        order = np.argsort(col)[::-1]
        top = []
        for idx in order[:TOP_N]:
            v = float(col[idx])
            if v <= 0:
                break
            top.append([int(idx), int(round(v))])
        if top:
            cells[f"{int(iy)}_{int(ix)}"] = top

    lookup_doc = {
        "source": "Zabel et al. 2014 -- Global Agricultural Suitability v3",
        "source_url": "https://doi.org/10.5281/zenodo.5982577",
        "year": 1995,
        "period": "1980-2009 historical baseline",
        "units": "suitability index (0-100)",
        "resolution_deg": factor * px_deg,
        "origin": {"lat": float(bounds.top), "lng": float(bounds.left)},
        "ny": int(lookup_h),
        "nx": int(lookup_w),
        "top_n": TOP_N,
        "crops": ZABEL_CROPS,
        "cells": cells,
    }
    with open(lookup_path, "w") as f:
        json.dump(lookup_doc, f)
    size_mb = lookup_path.stat().st_size / 1024 / 1024
    print(f"  Wrote {len(cells):,} cells -> {lookup_path.name} ({size_mb:.2f} MB)")

    return results


def process_energy():
    """WRI power plants + World Bank consumption -> energy.pmtiles (net energy balance)"""
    print("\n=== ENERGY BALANCE (WRI + World Bank) ===")

    import csv

    wri_path = DATA / "global_power_plant_database.csv"
    consumption_path = DATA / "energy_consumption_wb.json"
    imports_path = DATA / "energy_imports_net_wb.json"

    if not wri_path.exists():
        print(f"  ERROR: {wri_path} not found")
        print("  Download: curl -L -o data/global_power_plant_database.csv "
              '"https://raw.githubusercontent.com/wri/global-power-plant-database'
              '/master/output_database/global_power_plant_database.csv"')
        return None

    # --- Layer A: Rasterize generation capacity from WRI point data ---
    print("  Layer A: Rasterizing power plant capacity...")
    resolution = 0.1
    width = int(360 / resolution)
    height = int(180 / resolution)

    gen_grid = np.zeros((height, width), dtype=np.float64)
    plant_count = 0
    fuel_breakdown: dict[str, dict[str, float]] = {}

    with open(wri_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                lat = float(row["latitude"])
                lon = float(row["longitude"])
                cap = float(row["capacity_mw"])
            except (ValueError, KeyError):
                continue
            
            country_name = row.get("country_long", "")
            fuel = row.get("primary_fuel", "")
            if country_name and fuel:
                if country_name not in fuel_breakdown:
                    fuel_breakdown[country_name] = {}
                fuel_breakdown[country_name][fuel] = fuel_breakdown[country_name].get(fuel, 0) + cap

            xi = int((lon + 180) / resolution)
            yi = int((90 - lat) / resolution)
            xi = min(max(xi, 0), width - 1)
            yi = min(max(yi, 0), height - 1)

            gen_grid[yi, xi] += cap
            plant_count += 1

    print(f"    Rasterized {plant_count} plants onto {width}x{height} grid")
    print(f"    Total global capacity: {gen_grid.sum():,.0f} MW")
    valid_cells = np.count_nonzero(gen_grid)
    print(f"    Grid cells with plants: {valid_cells}")

    # --- Choose approach based on available data ---
    # If we have the net-imports indicator, use it directly as a cleaner
    # country-level energy balance. Otherwise fall back to consumption data.
    if imports_path.exists():
        print("  Using World Bank net energy imports indicator (direct balance)...")
        scores = _parse_worldbank_json(imports_path)
        if scores:
            print(f"    Parsed {len(scores)} country scores")
            # Net imports: positive = importer, negative = exporter
            # We want higher = better (net exporter), so invert the sign
            # and shift to a 0-100 scale centered at 50
            # Clamp extreme values (some countries have >400% or <-1000%)
            balance_scores = {}
            for country, val in scores.items():
                clamped = max(min(-val, 200), -200)
                normalized = (clamped + 200) / 400 * 100
                balance_scores[country] = normalized

            balance_grid, profile = rasterize_country_data(balance_scores, nodata=-9999)

            # --- Export JSON with normalized GeoJSON names ---
            exported_data = {}
            
            balance_map = map_country_names(balance_scores)
            for geo_name, wb_name in balance_map.items():
                exported_data[geo_name] = {"score": balance_scores[wb_name]}
                
            fuel_map = map_country_names(fuel_breakdown)
            for geo_name, wri_name in fuel_map.items():
                if geo_name not in exported_data:
                    exported_data[geo_name] = {}
                exported_data[geo_name]["fuels"] = fuel_breakdown[wri_name]

            import json
            scores_path = TILES / "energy" / "energy_scores.json"
            ensure_dir(scores_path.parent)
            with open(scores_path, "w") as f:
                json.dump(exported_data, f, separators=(",", ":"))
            print(f"  Exported energy_scores.json with {len(exported_data)} countries")

            # Blend: where we have plant data, enhance the country-level
            # signal with sub-national detail from generation capacity
            gen_log = np.where(gen_grid > 0, np.log1p(gen_grid), 0)
            if gen_log.max() > 0:
                gen_norm = gen_log / gen_log.max() * 30  # up to 30 point boost

            blended = np.where(
                balance_grid > -9999,
                np.clip(balance_grid + gen_norm, 0, 100),
                -9999,
            )

            tif_path = TILES / "energy" / "energy_raw.tif"
            ensure_dir(tif_path.parent)
            with rasterio.open(tif_path, "w", **profile) as dst:
                dst.write(blended.astype(np.float32), 1)

            out = full_pipeline(tif_path, "energy", data_min=0, data_max=100, nodata_val=-9999)
            tif_path.unlink(missing_ok=True)
            return out

    # Fallback: generation-only from WRI data
    print("  Fallback: Using generation capacity only (no consumption data)")
    transform = from_bounds(-180, -90, 180, 90, width, height)
    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "width": width,
        "height": height,
        "count": 1,
        "crs": "EPSG:4326",
        "transform": transform,
        "nodata": 0,
        "compress": "deflate",
    }

    tif_path = TILES / "energy" / "energy_raw.tif"
    ensure_dir(tif_path.parent)
    with rasterio.open(tif_path, "w", **profile) as dst:
        dst.write(gen_grid.astype(np.float32), 1)

    out = full_pipeline(tif_path, "energy", log_transform=True, nodata_val=0)
    tif_path.unlink(missing_ok=True)
    return out


def _parse_worldbank_json(json_path: Path) -> dict[str, float]:
    """Parse a World Bank API v2 JSON response into {country_name: value}."""
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list) or len(data) < 2:
        return {}

    scores = {}
    for entry in data[1]:
        if entry.get("value") is None:
            continue
        country_name = entry.get("country", {}).get("value", "")
        if not country_name:
            continue
        # Skip aggregate regions (World, EU, income groups, etc.)
        iso = entry.get("countryiso3code", "")
        if len(iso) != 3:
            continue
        try:
            scores[country_name] = float(entry["value"])
        except (ValueError, TypeError):
            continue

    return scores


def process_wind():
    """Global Wind Atlas 100m wind speed -> wind.pmtiles (land only)"""
    print("\n=== WIND SPEED (Global Wind Atlas 100m) ===")

    tif = DATA / "GlobalWindAtlas" / "wind_speed_cog_100m.tif"
    if not tif.exists():
        print(f"  ERROR: {tif} not found")
        return None

    out_path = TILES / "wind" / "wind.pmtiles"
    if out_path.exists():
        print(f"  Skipping {out_path.name} (already exists)")
        return out_path

    ensure_dir(TILES / "wind")
    downsampled = TILES / "wind" / "wind_downsampled.tif"

    print("  Step 0: Downsample ~1km -> ~4km using gdalwarp...")
    run([
        "gdalwarp",
        "-tr", "0.04166667", "0.04166667",
        "-r", "average",
        "-co", "COMPRESS=DEFLATE",
        "-overwrite",
        str(tif),
        str(downsampled),
    ])

    masked = TILES / "wind" / "wind_land_only.tif"
    final_tif = apply_ocean_mask(downsampled, masked, nodata_val=np.nan)
    if final_tif != downsampled:
        downsampled.unlink(missing_ok=True)
        downsampled = final_tif

    out = full_pipeline(downsampled, "wind", data_min=0, data_max=20.0, nodata_val=np.nan)
    downsampled.unlink(missing_ok=True)
    return out


def _rasterize_fuel_type(axis_id: str, fuel_names: list[str], data_max: float):
    """Rasterize WRI power plants filtered by fuel type into a PMTiles archive."""
    import csv

    wri_path = DATA / "global_power_plant_database.csv"
    if not wri_path.exists():
        print(f"  ERROR: {wri_path} not found")
        return None

    resolution = 0.1
    width = int(360 / resolution)
    height = int(180 / resolution)

    grid = np.zeros((height, width), dtype=np.float64)
    count = 0

    with open(wri_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            fuel = row.get("primary_fuel", "")
            if fuel not in fuel_names:
                continue
            try:
                lat = float(row["latitude"])
                lon = float(row["longitude"])
                cap = float(row["capacity_mw"])
            except (ValueError, KeyError):
                continue

            xi = int((lon + 180) / resolution)
            yi = int((90 - lat) / resolution)
            xi = min(max(xi, 0), width - 1)
            yi = min(max(yi, 0), height - 1)

            grid[yi, xi] += cap
            count += 1

    print(f"    Rasterized {count} {'/'.join(fuel_names)} plants, total {grid.sum():,.0f} MW")

    if count == 0:
        print("    No plants found, skipping")
        return None

    transform = from_bounds(-180, -90, 180, 90, width, height)
    profile = {
        "driver": "GTiff", "dtype": "float32",
        "width": width, "height": height, "count": 1,
        "crs": "EPSG:4326", "transform": transform,
        "nodata": 0, "compress": "deflate",
    }

    tif_path = TILES / axis_id / f"{axis_id}_raw.tif"
    ensure_dir(tif_path.parent)
    with rasterio.open(tif_path, "w", **profile) as dst:
        dst.write(grid.astype(np.float32), 1)

    out = full_pipeline(tif_path, axis_id, log_transform=True, data_min=0, data_max=data_max, nodata_val=0, resampling="max")
    tif_path.unlink(missing_ok=True)
    return out


FUEL_AXES = {
    "e_oil":   (["Oil", "Petcoke"],        "Oil",         10000),
    "e_coal":  (["Coal"],                   "Coal",        10000),
    "e_gas":   (["Gas", "Cogeneration"],    "Natural Gas", 10000),
    "e_nuke":  (["Nuclear"],                "Nuclear",     10000),
    "e_hydro": (["Hydro"],                  "Hydro",       10000),
    "e_wind":  (["Wind"],                   "Wind",        10000),
    "e_solar": (["Solar"],                  "Solar",       10000),
    "e_geo":   (["Geothermal"],             "Geothermal",  5000),
}


def _make_fuel_processor(axis_id: str, fuels: list[str], label: str, data_max: float):
    def processor():
        print(f"\n=== ENERGY: {label.upper()} (WRI) ===")
        return _rasterize_fuel_type(axis_id, fuels, data_max)
    processor.__doc__ = f"WRI power plants -> {axis_id}.pmtiles ({label} capacity)"
    return processor


def process_e_consume():
    """World Bank energy consumption per capita -> e_consume.pmtiles"""
    print("\n=== ENERGY CONSUMPTION (World Bank) ===")
    consumption_path = DATA / "energy_consumption_wb.json"
    if not consumption_path.exists():
        print(f"  ERROR: {consumption_path} not found")
        return None

    scores = _parse_worldbank_json(consumption_path)
    if not scores:
        print("  ERROR: No consumption data parsed")
        return None

    print(f"  Parsed {len(scores)} country scores")
    balance_grid, profile = rasterize_country_data(scores, nodata=-9999)

    tif_path = TILES / "e_consume" / "e_consume_raw.tif"
    ensure_dir(tif_path.parent)
    with rasterio.open(tif_path, "w", **profile) as dst:
        dst.write(balance_grid.astype(np.float32), 1)

    out = full_pipeline(tif_path, "e_consume", data_min=0, data_max=15000, nodata_val=-9999, resampling="nearest")
    tif_path.unlink(missing_ok=True)
    return out


def process_vista():
    """alltheviews TVS (total viewshed surface) -> vista.pmtiles

    Source raster lives at data/alltheviews/vista_raw.tif and is produced by
    `python pipeline/download_alltheviews.py`, which fetches their global
    z=6 tiles, decodes the per-tile float32+zlib payload, mosaics into a
    single Web Mercator raster, and reprojects to EPSG:4326.

    Values are relative TVS in km^2 visible from each cell. The distribution
    is heavily right-tailed (oceans 0, plains low, mountain peaks 100s of
    millions of units), so we log-transform and cap at the 99.5th percentile
    of land cells. Resulting axis is bright = expansive views, dark = boxed
    in or no view at all.
    """
    print("\n=== VISTA / TOTAL VIEWSHED (alltheviews.world) ===")
    src = DATA / "alltheviews" / "vista_raw.tif"
    if not src.exists():
        print(f"  ERROR: {src} not found")
        print("  Please run: python pipeline/download_alltheviews.py")
        return None

    with rasterio.open(src) as ds:
        arr = ds.read(1)
    finite = arr[np.isfinite(arr) & (arr > 0)]
    if finite.size == 0:
        print("  ERROR: no positive finite values in source")
        return None
    cap = float(np.percentile(finite, 99.5))
    print(f"  source p50={np.percentile(finite,50):.0f}  p99={np.percentile(finite,99):.0f}"
          f"  p99.5={cap:.0f}  max={finite.max():.0f}")

    return full_pipeline(
        src,
        "vista",
        data_min=0,
        data_max=cap,
        log_transform=True,
        nodata_val=float("nan"),
    )


def process_travel():
    """Travel time to closest city -> travel.pmtiles"""
    print("\n=== TRAVEL TIME TO CITY (Weiss et al / Figshare) ===")

    tif = DATA / "Travel" / "travel_time_to_cities_2.tif"
    if not tif.exists():
        print(f"  ERROR: {tif} not found")
        print("  Please download into data/Travel/")
        return None

    out_path = TILES / "travel" / "travel.pmtiles"
    if out_path.exists():
        print(f"  Skipping {out_path.name} (already exists)")
        return out_path

    ensure_dir(TILES / "travel")
    downsampled = TILES / "travel" / "travel_downsampled.tif"

    print("  Step 0: Downsample 1km -> ~1km using gdalwarp...")
    run([
        "gdalwarp",
        "-tr", "0.010416667", "0.010416667",
        "-r", "average",
        "-co", "COMPRESS=DEFLATE",
        "-overwrite",
        str(tif),
        str(downsampled),
    ])

    masked = TILES / "travel" / "travel_land_only.tif"
    final_tif = apply_ocean_mask(downsampled, masked, nodata_val=65535)
    if final_tif != downsampled:
        downsampled.unlink(missing_ok=True)
        downsampled = final_tif

    # Invert so 0 minutes (closest) is 255 (bright). Cap at 720 minutes (12 hours).
    out = full_pipeline(downsampled, "travel", data_min=0, data_max=720, invert=True, nodata_val=65535, max_zoom=7)
    downsampled.unlink(missing_ok=True)
    return out


PROCESSORS = {
    "elev": process_elev,
    "temp": process_temp,
    "tvar": process_tvar,
    "water": process_water,
    "pop": process_pop,
    "gdp": process_gdp,
    "risk": process_risk,
    "depv": process_depv,
    "hcare": process_hcare,
    "inet": process_inet,
    "free": process_free,
    "solar": process_solar,
    "air": process_air,
    "energy": process_energy,
    "agri": process_agri,
    "agrip": process_agrip,
    "wind": process_wind,
    "e_consume": process_e_consume,
    "travel": process_travel,
    "vista": process_vista,
}

for _aid, (_fuels, _label, _dmax) in FUEL_AXES.items():
    PROCESSORS[_aid] = _make_fuel_processor(_aid, _fuels, _label, _dmax)


def main():
    parser = argparse.ArgumentParser(description="Utopia data pipeline")
    parser.add_argument("axes", nargs="*", help="Axes to process (e.g. elev pop)")
    parser.add_argument("--all", action="store_true", help="Process all available axes")
    parser.add_argument("--catalog-only", action="store_true", help="Only rebuild catalog")
    args = parser.parse_args()

    ensure_dir(TILES)

    if args.catalog_only:
        build_catalog()
        return

    targets = list(PROCESSORS.keys()) if args.all else args.axes
    if not targets:
        print("Available axes:", ", ".join(PROCESSORS.keys()))
        print("Usage: python pipeline/build_tiles.py elev pop ...")
        return

    for axis in targets:
        if axis not in PROCESSORS:
            print(f"Unknown axis: {axis}. Available: {', '.join(PROCESSORS.keys())}")
            continue
        PROCESSORS[axis]()

    build_catalog()
    print("\nDone!")


if __name__ == "__main__":
    main()
