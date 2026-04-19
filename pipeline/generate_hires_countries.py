import geopandas as gpd
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA = REPO_ROOT / "data"
PUBLIC = REPO_ROOT / "app" / "public"

print("Loading 10m country boundaries...")
shp = DATA / "NaturalEarth" / "ne_10m_admin_0_countries_dir" / "ne_10m_admin_0_countries.shp"
world = gpd.read_file(shp)

# Keep only necessary columns to minimize file size
world = world[['NAME', 'ISO_A2', 'geometry']]

print("Simplifying geometries...")
# Simplify slightly to balance file size and accuracy. 
# 0.05 is 5km, maybe 0.02 is better for country borders to keep them crisp.
world.geometry = world.geometry.simplify(0.015)

out_file = PUBLIC / "countries.geojson"
print(f"Saving to {out_file}...")
world.to_file(out_file, driver="GeoJSON")

print("Done!")
