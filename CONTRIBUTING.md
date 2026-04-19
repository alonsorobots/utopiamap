# Contributing to Utopia

Thanks for your interest. Utopia is a small open-source project; contributions
of all sizes are welcome — bug reports, fixes, new data sources, UI polish,
docs, or ideas.

## Getting started

```bash
git clone https://github.com/alonsorobots/utopiamap.git
cd utopiamap/app
npm install
npm run dev
```

The dev server runs at [http://localhost:5173](http://localhost:5173). It reads tiles from
`/data/tiles` via a Vite middleware.

If you only want to work on the frontend you don't need any tile data — the
app will simply show an empty map and report missing axes. To get a working
map locally, either:

1. Point `VITE_TILES_BASE` at the production tile host before `npm run dev`
  (e.g. `VITE_TILES_BASE=https://tiles.utopiamap.com npm run dev`); or
2. Build a few axes locally — see "Pipeline" below.

## Pipeline

The Python pipeline (`pipeline/`) converts raw GeoTIFFs and other inputs into
the PMTiles archives the frontend consumes. It uses GDAL, rasterio, and
geopandas.

```bash
cd pipeline
conda env create -f environment.yml
conda activate utopia
python build_tiles.py            # full rebuild (slow)
python build_tiles.py temp gdp   # rebuild specific axes only
```

Raw inputs are not in the repo. Each `process_*` function in `build_tiles.py`
documents where to download its inputs from — see [DATA_SOURCES.md](./DATA_SOURCES.md)
for canonical links.

## Code style

- TypeScript, React function components, no class components.
- Vite + ESLint defaults (run `npm run lint` in `app/`).
- Python 3.12+, type hints where they help, no formatter enforcement.
- Comments only where intent is non-obvious. Don't narrate what the code does.

## Pull requests

1. Open an issue first for anything beyond a small fix, so we can agree on
  the approach before you spend time on it.
2. Keep PRs focused. One topic per PR.
3. Reference the issue in the PR description.
4. Use clear commit messages. Imperative mood ("add X", not "added X").

## Data sources

If you want to add a new data axis:

1. Confirm the source's license permits redistribution. Note that any source
  under a non-commercial or ShareAlike license will affect the project's
   combined data license — see [LICENSE-DATA](./LICENSE-DATA).
2. Add a `process_<axis>()` function to `pipeline/build_tiles.py` and register
  it in `PROCESSORS`.
3. Add the axis configuration to `AXES` in `app/src/App.tsx`.
4. Add the source to [DATA_SOURCES.md](./DATA_SOURCES.md).

## License

By contributing you agree your contributions will be released under the same
licenses as the project: [MIT](./LICENSE) for code and
[CC BY-NC-SA 4.0](./LICENSE-DATA) for any data outputs you generate.