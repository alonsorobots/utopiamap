# Utopia

**Find places that fit how you actually feel about the world.**

Live: [utopiamap.com](https://utopiamap.com)

## What it is

Utopia is an interactive web map for thinking through where on Earth might
suit you. It blends real global datasets — climate, water, agriculture,
population, GDP, air quality, hazards, and more — into a single composite map
that you shape with two unique controls:

1. **A preference curve over each dataset.** For every axis you get a global
  histogram and a flexible linear curve drawn over it. The curve is how you  
   express how you *feel* about each possible value: comfortable, tolerable,
   not for me. There's no "filter on/off" — you draw your taste, smoothly.
2. **An arithmetic formula bar that combines the layers.** Use single-letter
  aliases for each axis (`t`, `w`, `p`, …) and combine them with simple
   operators: multiply to require both, divide to penalize, add to reward,
   subtract to deduct. Example: `(t * w) / p` — warm and wet, lightly
   populated.

The interface isn't trying to perfectly model your ideal place — that's not
really a thing. It's trying to let you pose the question well enough that you
notice options you'd never have considered, and ask better questions next.

There is no sign-up, no account. State persists locally and read-only
permalinks encode the full session in the URL hash.

## Data axes


| Axis                    | Hotkey | Description                                | Source                                                                                                                                            | Resolution        | Temporal                 |
| ----------------------- | ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------ |
| **Temperature**         | `t`    | Mean annual temperature                    | [CHELSA v2.1](https://chelsa-climate.org) (bio01)                                                                                                 | 1 km              | 1981–2010; CMIP6 to 2100 |
| **Temp Volatility**     | `v`    | Temperature seasonality (std. dev.)        | [CHELSA v2.1](https://chelsa-climate.org) (bio04)                                                                                                 | 1 km              | 1981–2010; CMIP6 to 2100 |
| **Water**               | `w`    | Freshwater availability                    | [TerraClimate](http://www.climatologylab.org/terraclimate.html) + [Global Surface Water](https://global-surface-water.appspot.com)                | 0.25°             | 1948–2021                |
| **Solar**               | `s`    | Global Horizontal Irradiance               | [Global Solar Atlas](https://globalsolaratlas.info)                                                                                               | 250 m             | Long-term avg            |
| **Wind**                | `n`    | Mean wind speed at 100 m                   | [Global Wind Atlas](https://globalwindatlas.info)                                                                                                 | 250 m             | Long-term avg            |
| **Energy**              | `e`    | Total energy production                    | [WRI Global Power Plant DB](https://datasets.wri.org/dataset/globalpowerplantdatabase)                                                            | Country-level     | Annual                   |
| **Agriculture**         | `a`    | Crop suitability index                     | [FAO GAEZ v5](https://gaez.fao.org)                                                                                                               | ~9 km             | 2020; CMIP6 projections  |
| **Population**          | `p`    | Population density                         | [LandScan Global](https://landscan.ornl.gov/) (ORNL)                                                                                              | 1 km              | 2000, 2005, 2010, 2015   |
| **GDP**                 | `g`    | GDP per capita PPP (subnational)           | [Kummu et al.](https://zenodo.org/records/10976733) + [World Bank](https://data.worldbank.org)                                                    | District-level    | 2000–2024                |
| **Air Quality**         | `q`    | Annual mean PM2.5                          | [van Donkelaar / SEDAC](https://www.satpm.org) V6.GL                                                                                              | ~1 km             | 1998–2023                |
| **Elevation**           | `l`    | Terrain elevation                          | [ETOPO 2022](https://www.ngdc.noaa.gov/mgg/global/) (NOAA)                                                                                        | ~500 m            | Static                   |
| **Risk**                | `k`    | Multi-hazard composite risk                | [GEM Seismic](https://hazard.openquake.org) + [JRC Flood](https://data.jrc.ec.europa.eu) + [INFORM](https://drmkc.jrc.ec.europa.eu/inform-index/) | ~5 km             | Static (2025)            |
| **Healthcare**          | `h`    | Travel time to nearest healthcare facility | [Malaria Atlas Project](https://malariaatlas.org)                                                                                                 | ~1 km             | 2019                     |
| **Internet**            | `i`    | Fixed broadband download speed             | [Ookla Speedtest Open Data](https://github.com/teamookla/ookla-open-data)                                                                         | ~600 m tiles      | Quarterly                |
| **Freedom**             | `f`    | Composite of CPI + Freedom House FIW       | [Transparency Intl](https://www.transparency.org) + [Freedom House](https://freedomhouse.org)                                                     | Country-level     | Annual                   |
| **Deprivation**         | `x`    | Relative deprivation index                 | [SEDAC GRDI](https://sedac.ciesin.columbia.edu) (NASA)                                                                                            | ~1 km             | 2020                     |
| **Travel time to city** | `r`    | Travel time to nearest urban center        | derived from MAP friction surface                                                                                                                 | 1 km              | 2019                     |
| **Draw**                | `d`    | User-painted mask                          | (local)                                                                                                                                           | Adaptive quadtree | N/A                      |


For full per-axis attribution, license, and citation, see [DATA_SOURCES.md](./DATA_SOURCES.md).

### Future projections

For axes with available scientific projections, the time slider extends
beyond the present and lets you switch between SSP scenarios:


| Source                                                                     | Axes                                | Scenarios                              | Range                         |
| -------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------- | ----------------------------- |
| [CMIP6 via WorldClim](https://worldclim.org/data/cmip6/cmip6_clim10m.html) | Temperature, Temp Volatility, Water | SSP1-2.6, SSP2-4.5, SSP3-7.0, SSP5-8.5 | 2021–2100 (20-year windows)   |
| [FAO GAEZ v5](https://gaez.fao.org)                                        | Agriculture                         | Same SSPs                              | 2050, 2070                    |
| [SEDAC SSP Population Grids](https://doi.org/10.7927/q7z9-9r69)            | Population                          | SSP1–SSP5                              | 2020–2100 (10-year intervals) |


## How the controls work

- **Preference curves** — drag the curve over each histogram to express
comfort: high points = "I like this value," low points = "I don't." The
curve is a smooth Bezier, not a hard cutoff, so the resulting heatmap is a
gradient, not a binary mask.
- **Formula bar** — type any arithmetic over single-letter aliases. Common
patterns:
  - `t * w` — both warm and wet (multiplication is logical AND-ish).
  - `t + w` — warm or wet (addition is OR-ish).
  - `t / p` — warm divided by population (penalizes density).
  - `(t * w * a) / r` — warm, wet, agriculturally suitable, far from cities.
- **Draw mask** — paint regions to include or exclude. Works as `d` in
formulas, e.g. `t * d` clips temperature to your painted area.
- **Time scrubber** — slide through historical years and switch between SSP
futures.
- **Read-only permalinks** — every session state (curves, formula, view, draw
mask) round-trips through the URL hash. No accounts.

## Architecture

Raw GeoTIFFs are normalized and converted to PMTiles archives:

```
GeoTIFF --> gdal_translate (normalize to 0-255 byte) --> rio-pmtiles --> .pmtiles
```

Each `.pmtiles` file is a single self-contained archive that supports HTTP
range requests, served from a static object store (Cloudflare R2). The
frontend is a Vite + React SPA on Cloudflare Pages. No tile server, no
backend.

The heatmap is rendered as a custom WebGL layer on top of MapLibre GL JS;
preference curves and arithmetic combination happen in a single fragment
shader, so the map updates instantly when curves change.

## Repo layout

```
app/        Vite + React + MapLibre frontend
pipeline/   Python data pipeline (raw data -> .pmtiles + lookup JSONs)
```

## Local development

Requirements: Node 20+, Python 3.12+, [Conda](https://docs.conda.io/) (for the
pipeline only).

```bash
# Frontend
cd app
npm install
npm run dev          # http://localhost:5173

# Pipeline (only needed if rebuilding tiles from raw data)
cd pipeline
conda env create -f environment.yml
conda activate utopia
python build_tiles.py
```

The frontend serves tile data from `/data/tiles` in dev. In production it
reads `VITE_TILES_BASE` (e.g. `https://tiles.utopiamap.com`) at build time so
tiles are loaded from R2.

## Real-time collaboration (optional)

The frontend supports an Excalidraw-style "Share session" mode: anyone
with the link is in the same room, sees each other's cursors, and stays
in sync on the active axis / formula / year. There's no auth, no login,
and the relay never persists anything -- when the last tab closes, the
session evaporates.

The backend is a tiny Cloudflare Worker + Durable Object in
[`collab-worker/`](./collab-worker/). To run end-to-end locally:

```sh
# terminal 1: relay
cd collab-worker
npm install
npm run dev          # ws://localhost:8787/room/<id>

# terminal 2: app, pointed at the local relay
cd app
echo "VITE_COLLAB_URL=ws://localhost:8787/room/" > .env.local
npm run dev
```

To deploy: `cd collab-worker && npm run deploy`, then optionally
attach a Workers custom domain like `collab.utopiamap.com` and set
`VITE_COLLAB_URL=wss://collab.utopiamap.com/room/` in your production
build env.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

- **Code**: [MIT](./LICENSE)
- **Data outputs (tile archives, lookup JSONs)**: [CC BY-NC-SA 4.0](./LICENSE-DATA),
inherited from the most-restrictive upstream sources (Ookla, GEM). See
[DATA_SOURCES.md](./DATA_SOURCES.md) for per-source licenses and the full
attribution chain.

