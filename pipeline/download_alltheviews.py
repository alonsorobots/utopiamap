#!/usr/bin/env python3
"""
Download alltheviews.world Total Viewshed Surface (TVS) tiles and stitch them
into a global GeoTIFF that the standard build_tiles pipeline can consume.

Source: https://alltheviews.world (Tom Buckley-Houston, Ryan Berger, Jaco Dart)
PMTile: cdn.alltheviews.world/runs/ryan-fullworld-raw/pmtiles/world.pmtiles/world.pmtiles
        587 GB single-band float32 (zlib per tile), zoom 0-11, tile_type=0 custom
        Values: relative visibility units (km^2 visible from each cell, ish)

We only download zoom 6 (4096 tiles, ~400 MB total) which matches the rest of
Utopia's MAX_ZOOM and gives ~611 m/pixel at the equator -- plenty for a "where
on Earth has good vistas" preference axis. Tiles are zlib-decoded, written as
per-tile Web Mercator GeoTIFFs, mosaicked with rasterio.merge, then reprojected
to EPSG:4326 and saved as vista_raw.tif for build_tiles.process_vista() to
normalize and pack.

Run: python pipeline/download_alltheviews.py
Output: data/alltheviews/vista_raw.tif (~1 GB float32, EPSG:4326, ~16k x 8k)
"""

from __future__ import annotations

import math
import sys
import time
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import rasterio
import requests
from pmtiles.reader import deserialize_directory, deserialize_header, find_tile
from pmtiles.tile import Compression, zxy_to_tileid
from rasterio.merge import merge
import gzip
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, calculate_default_transform, reproject

URL = "https://cdn.alltheviews.world/runs/ryan-fullworld-raw/pmtiles/world.pmtiles/world.pmtiles"
HEADERS = {"User-Agent": "utopiamap-pipeline/0.1 (alonsorobots@gmail.com)"}
ZOOM = 6
TILE_PX = 256
WEB_MERCATOR_HALF = 20_037_508.342_789_244  # meters; one half of EPSG:3857 extent

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "alltheviews"
TILE_CACHE = OUT_DIR / "tiles_z6"
RAW_OUT = OUT_DIR / "vista_raw.tif"


_session = requests.Session()
_session.headers.update(HEADERS)
_adapter = requests.adapters.HTTPAdapter(pool_connections=64, pool_maxsize=64, max_retries=3)
_session.mount("https://", _adapter)


def http_get(offset: int, length: int) -> bytes:
    h = {"Range": f"bytes={offset}-{offset+length-1}"}
    for attempt in range(4):
        try:
            r = _session.get(URL, headers=h, timeout=60)
            r.raise_for_status()
            return r.content
        except (requests.RequestException, ConnectionError):
            if attempt == 3:
                raise
            time.sleep(0.5 * (2 ** attempt))


class CachedPMTiles:
    """Reads PMTiles header/dirs ONCE and serves tile (offset, length) lookups
    from memory. Avoids the per-tile leaf-directory refetch that the stock
    pmtiles.Reader does.
    """

    def __init__(self):
        print("Fetching PMTiles header...")
        self.header = deserialize_header(http_get(0, 127))
        print(f"  min/max zoom: {self.header['min_zoom']}/{self.header['max_zoom']}")
        print(f"  root dir: {self.header['root_length']} bytes")
        print(f"  leaf dir: {self.header['leaf_directory_length']:,} bytes")
        print(f"  tile data: {self.header['tile_data_length']:,} bytes")

        print("Fetching root directory...")
        self.root_dir = self._read_dir(self.header["root_offset"], self.header["root_length"])

        print("Fetching leaf directory blob (~17 MB, one shot)...")
        # Each leaf-directory entry in the root points to a (offset, length) RANGE
        # within the leaf section, and that slice is itself gzipped (per
        # PMTiles v3 spec). So we keep the raw bytes and let deserialize_directory
        # gunzip per-chunk on lookup.
        self.leaf_blob = http_get(
            self.header["leaf_directory_offset"], self.header["leaf_directory_length"]
        )
        self._leaf_cache: dict[tuple[int, int], list] = {}

    def _read_dir(self, offset: int, length: int):
        return deserialize_directory(http_get(offset, length))

    def _leaf_dir(self, rel_offset: int, length: int):
        key = (rel_offset, length)
        d = self._leaf_cache.get(key)
        if d is not None:
            return d
        # Slice from the in-memory leaf blob (already decompressed). Note: the
        # leaf entries' offset is RELATIVE to leaf_directory_offset, but the
        # leaf blob is already decompressed and concatenated in offset order,
        # so a slice works only if we deserialize each leaf chunk individually.
        chunk = self.leaf_blob[rel_offset : rel_offset + length]
        d = deserialize_directory(chunk)
        self._leaf_cache[key] = d
        return d

    def tile_offset_length(self, z: int, x: int, y: int) -> tuple[int, int] | None:
        tile_id = zxy_to_tileid(z, x, y)
        # walk root, then leaf
        result = find_tile(self.root_dir, tile_id)
        if result is None:
            return None
        if result.run_length == 0:
            # entry points into leaf directory
            leaf = self._leaf_dir(result.offset, result.length)
            result = find_tile(leaf, tile_id)
            if result is None or result.run_length == 0:
                return None
        return (
            self.header["tile_data_offset"] + result.offset,
            result.length,
        )

    def fetch_tile(self, z: int, x: int, y: int) -> bytes | None:
        ol = self.tile_offset_length(z, x, y)
        if ol is None:
            return None
        return http_get(*ol)


def tile_bounds_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Return (left, bottom, right, top) in EPSG:3857 meters for an XYZ tile."""
    n = 2 ** z
    size = 2 * WEB_MERCATOR_HALF / n
    left = -WEB_MERCATOR_HALF + x * size
    right = left + size
    top = WEB_MERCATOR_HALF - y * size
    bottom = top - size
    return left, bottom, right, top


def decode_tile(blob: bytes) -> np.ndarray:
    """alltheviews tiles are zlib-compressed 256x256 float32 little-endian."""
    raw = zlib.decompress(blob)
    if len(raw) != TILE_PX * TILE_PX * 4:
        raise ValueError(f"unexpected tile size {len(raw)} (expected {TILE_PX*TILE_PX*4})")
    return np.frombuffer(raw, dtype="<f4").reshape(TILE_PX, TILE_PX)


def write_tile_geotiff(arr: np.ndarray, z: int, x: int, y: int, dst: Path) -> None:
    left, bottom, right, top = tile_bounds_3857(z, x, y)
    transform = from_bounds(left, bottom, right, top, TILE_PX, TILE_PX)
    profile = {
        "driver": "GTiff",
        "height": TILE_PX,
        "width": TILE_PX,
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:3857",
        "transform": transform,
        "nodata": float("nan"),
        "compress": "lzw",
    }
    out = arr.copy()
    out[out == 0] = np.nan
    with rasterio.open(dst, "w", **profile) as ds:
        ds.write(out.astype(np.float32), 1)


def fetch_one(reader: CachedPMTiles, z: int, x: int, y: int, dst: Path) -> tuple[int, int, str]:
    if dst.exists() and dst.stat().st_size > 0:
        return x, y, "cached"
    try:
        blob = reader.fetch_tile(z, x, y)
    except Exception as e:
        return x, y, f"err:{e}"
    if blob is None:
        return x, y, "miss"
    try:
        arr = decode_tile(blob)
    except Exception as e:
        return x, y, f"decode-err:{e}"
    write_tile_geotiff(arr, z, x, y, dst)
    return x, y, "ok"


def download_all(z: int = ZOOM, workers: int = 32) -> list[Path]:
    TILE_CACHE.mkdir(parents=True, exist_ok=True)
    n = 2 ** z
    reader = CachedPMTiles()
    print(f"\nDownloading {n*n} tiles at z={z} ({workers} workers)...")
    paths: list[Path] = []

    coords = [(x, y) for x in range(n) for y in range(n)]
    n_ok = n_miss = n_cached = n_err = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = []
        for x, y in coords:
            dst = TILE_CACHE / f"z{z}_{x}_{y}.tif"
            futures.append(ex.submit(fetch_one, reader, z, x, y, dst))
        for i, fut in enumerate(as_completed(futures), 1):
            x, y, status = fut.result()
            if status == "ok":
                n_ok += 1
                paths.append(TILE_CACHE / f"z{z}_{x}_{y}.tif")
            elif status == "cached":
                n_cached += 1
                paths.append(TILE_CACHE / f"z{z}_{x}_{y}.tif")
            elif status == "miss":
                n_miss += 1
            else:
                n_err += 1
                print(f"  z{z}/{x}/{y}: {status}")
            if i % 200 == 0 or i == len(coords):
                rate = i / (time.time() - t0)
                eta = (len(coords) - i) / rate if rate else 0
                print(f"  {i}/{len(coords)}  ok={n_ok} cached={n_cached} miss={n_miss} err={n_err}  rate={rate:.1f}/s  eta={eta:.0f}s")
    print(f"Done: {n_ok} downloaded, {n_cached} cached, {n_miss} missing, {n_err} errors")
    return sorted(paths)


def mosaic_to_4326(tile_paths: list[Path], dst: Path) -> None:
    print(f"\nMosaicking {len(tile_paths)} tiles to a global EPSG:3857 raster...")
    srcs = [rasterio.open(p) for p in tile_paths]
    try:
        mosaic, transform = merge(srcs, nodata=float("nan"))
    finally:
        for s in srcs:
            s.close()
    mosaic = mosaic.astype(np.float32)
    print(f"  mosaic: {mosaic.shape}, finite={np.isfinite(mosaic).sum()/mosaic.size*100:.1f}%")

    src_h, src_w = mosaic.shape[-2], mosaic.shape[-1]
    src_profile = {
        "driver": "GTiff",
        "height": src_h,
        "width": src_w,
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:3857",
        "transform": transform,
        "nodata": float("nan"),
    }

    print(f"  reprojecting to EPSG:4326...")
    src_left = transform.c
    src_top = transform.f
    src_right = src_left + transform.a * src_w
    src_bottom = src_top + transform.e * src_h
    dst_transform, dst_w, dst_h = calculate_default_transform(
        "EPSG:3857", "EPSG:4326",
        src_w, src_h,
        src_left, src_bottom, src_right, src_top,
    )
    dst_arr = np.full((dst_h, dst_w), np.nan, dtype=np.float32)
    reproject(
        source=mosaic[0],
        destination=dst_arr,
        src_transform=transform,
        src_crs="EPSG:3857",
        dst_transform=dst_transform,
        dst_crs="EPSG:4326",
        resampling=Resampling.bilinear,
        src_nodata=np.nan,
        dst_nodata=np.nan,
    )

    dst.parent.mkdir(parents=True, exist_ok=True)
    profile = {
        "driver": "GTiff",
        "height": dst_h,
        "width": dst_w,
        "count": 1,
        "dtype": "float32",
        "crs": "EPSG:4326",
        "transform": dst_transform,
        "nodata": float("nan"),
        "compress": "deflate",
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
    }
    with rasterio.open(dst, "w", **profile) as ds:
        ds.write(dst_arr, 1)
    size_mb = dst.stat().st_size / 1024 / 1024
    print(f"  wrote {dst.name}: {dst_w}x{dst_h}, {size_mb:.1f} MB")
    finite = dst_arr[np.isfinite(dst_arr)]
    if finite.size:
        print(f"  value range: min={finite.min():.0f}  p1={np.percentile(finite,1):.0f}"
              f"  p50={np.percentile(finite,50):.0f}  p99={np.percentile(finite,99):.0f}"
              f"  max={finite.max():.0f}")


def main():
    paths = download_all()
    if not paths:
        print("No tiles downloaded; aborting.")
        sys.exit(1)
    mosaic_to_4326(paths, RAW_OUT)
    print(f"\nDone. Next: run `python pipeline/build_tiles.py vista` to package.")


if __name__ == "__main__":
    main()
