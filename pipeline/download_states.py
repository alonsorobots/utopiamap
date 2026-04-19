import urllib.request
import zipfile
import io
import os
from pathlib import Path
import geopandas as gpd

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA = REPO_ROOT / "data"
PUBLIC = REPO_ROOT / "app" / "public"

url = "https://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_1_states_provinces_lines.zip"
out_dir = str(DATA / "NaturalEarth" / "states")

print("Downloading Natural Earth 50m states/provinces lines...")
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req) as response:
    with zipfile.ZipFile(io.BytesIO(response.read())) as z:
        z.extractall(out_dir)

shp_path = os.path.join(out_dir, "ne_50m_admin_1_states_provinces_lines.shp")
print(f"Loading {shp_path}...")
gdf = gpd.read_file(shp_path)

# Optional: keep only basic attributes to save space, or none since we just want lines
gdf = gdf[['geometry']]

# Simplify a bit to keep file size small
gdf.geometry = gdf.geometry.simplify(0.02)

out_geojson = str(PUBLIC / "states.geojson")
print(f"Saving to {out_geojson}...")
gdf.to_file(out_geojson, driver="GeoJSON")

import os
size = os.path.getsize(out_geojson)
print(f"Done. File size: {size / 1024:.1f} KB")