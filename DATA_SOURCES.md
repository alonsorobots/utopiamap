# Data Sources, Licenses, and Citations

Every dataset used by Utopia, with its original source, license, and the
citation we ask users to include in any derivative work.

## Summary

| Axis | Source | License | Attribution requirement |
|---|---|---|---|
| Temperature, Temp Volatility | CHELSA v2.1 | CC BY 4.0 | Cite Karger et al. 2017 |
| Water | TerraClimate + Global Surface Water (JRC) | CC BY 4.0 | Cite Abatzoglou et al. 2018; Pekel et al. 2016 |
| Solar | Global Solar Atlas (World Bank/ESMAP) | CC BY 4.0 | Attribute to World Bank Group |
| Wind | Global Wind Atlas (DTU) | Free for use; ToS conditions apply | Attribute to DTU Wind Energy |
| Energy | WRI Global Power Plant DB | CC BY 4.0 | Cite Byers et al. 2021 (WRI) |
| Agriculture | FAO GAEZ v5 | CC BY-NC-SA 3.0 IGO | Attribute to FAO; non-commercial |
| Population | LandScan Global (ORNL) | CC BY 4.0 (since 2022) | Cite ORNL LandScan |
| GDP | Kummu et al. + World Bank | CC BY 4.0 | Cite Kummu et al. 2025 |
| Air Quality | van Donkelaar / SEDAC V6.GL | License unclear (publicly available) | Cite van Donkelaar et al. |
| Elevation | ETOPO 2022 (NOAA) | US Public Domain | Attribute to NOAA NCEI |
| Risk | GEM Seismic + JRC Flood + INFORM | CC BY-NC-SA 4.0 (GEM) + CC BY 4.0 (JRC, INFORM) | Attribute GEM, EC JRC |
| Healthcare | Malaria Atlas Project | CC BY 3.0 | Cite Weiss et al. 2020 |
| Internet | Ookla Speedtest Open Data | CC BY-NC-SA 4.0 | Attribute Ookla; non-commercial |
| Freedom | Transparency Intl CPI + Freedom House FIW | CC BY 4.0 + free for academic | Attribute both |
| Deprivation | SEDAC GRDI (NASA) | CC BY 4.0 | Standard NASA SEDAC citation |
| Travel time to city | derived from MAP friction surface | CC BY 4.0 | Cite Weiss et al. 2018 |

---

## Per-source detail

### CHELSA v2.1 (Climatologies at high resolution for the Earth's land
surface areas)
- **Used for**: Temperature (`temp`), Temperature Volatility (`tvar`), Water (`water`).
- **License**: Creative Commons Attribution 4.0 (CC BY 4.0).
- **Citation**:
  - Karger, D.N. et al. (2017). *Climatologies at high resolution for the
    earth's land surface areas.* Scientific Data 4, 170122.
    https://doi.org/10.1038/sdata.2017.122
- **Source**: https://chelsa-climate.org

### TerraClimate
- **Used for**: Water (`water`).
- **License**: CC BY 4.0.
- **Citation**:
  - Abatzoglou, J.T., Dobrowski, S.Z., Parks, S.A. & Hegewisch, K.C. (2018).
    *TerraClimate, a high-resolution global dataset of monthly climate and
    climatic water balance from 1958–2015.* Scientific Data 5, 170191.
- **Source**: http://www.climatologylab.org/terraclimate.html

### Global Surface Water (EC JRC)
- **Used for**: Water (`water`).
- **License**: CC BY 4.0.
- **Citation**:
  - Pekel, J.-F., Cottam, A., Gorelick, N. & Belward, A.S. (2016). *High-
    resolution mapping of global surface water and its long-term changes.*
    Nature 540, 418–422.
- **Source**: https://global-surface-water.appspot.com

### Global Solar Atlas (World Bank / ESMAP)
- **Used for**: Solar (`solar`).
- **License**: CC BY 4.0.
- **Attribution**: "Global Solar Atlas 2.0, a free, web-based application is
  developed and operated by the company Solargis s.r.o. on behalf of the
  World Bank Group."
- **Source**: https://globalsolaratlas.info

### Global Wind Atlas (DTU)
- **Used for**: Wind (`wind`).
- **License**: The Global Wind Atlas is made available free of charge under
  the terms of use published at https://globalwindatlas.info. Attribution
  required; commercial use permitted with attribution.
- **Citation**:
  - Davis, N.N. et al. (2023). *The Global Wind Atlas: A High-Resolution Dataset
    of Climatologies and Associated Web-Based Application.*
- **Source**: https://globalwindatlas.info

### WRI Global Power Plant Database
- **Used for**: Energy (`energy`) and per-fuel breakdowns (`e_coal`, `e_gas`,
  `e_geo`, `e_hydro`, `e_nuke`, `e_oil`, `e_solar`, `e_wind`).
- **License**: Data CC BY 4.0; code MIT.
- **Citation**:
  - Byers, L. et al. (2021). *Global Power Plant Database v1.3.0.* World
    Resources Institute.
- **Source**: https://datasets.wri.org/dataset/globalpowerplantdatabase
- **Note**: WRI announced v1.3.0 as the final release; data may not reflect
  capacity additions after 2021.

### FAO GAEZ v5
- **Used for**: Agriculture suitability (`agri`, `agrip`).
- **License**: CC BY-NC-SA 3.0 IGO.
- **Attribution**: "FAO Global Agro-Ecological Zones (GAEZ) v5."
- **Source**: https://gaez.fao.org

### LandScan Global (ORNL)
- **Used for**: Population (`pop`).
- **License**: CC BY 4.0 (since 2022 release).
- **Citation**:
  - Oak Ridge National Laboratory. (2022). *LandScan Global Population
    Database.* https://landscan.ornl.gov/
- **Note**: Pre-2022 LandScan releases were under a restrictive license.
  Utopia uses 2022+ releases.

### Kummu Gridded GDP
- **Used for**: GDP per capita PPP (`gdp`), subnational tier.
- **License**: Data CC BY 4.0; code MIT.
- **Citation**:
  - Kummu, M., Taka, M. & Guillaume, J.H.A. (2025). *Gridded global datasets
    of GDP and Human Development Index over 1990–2024.* Scientific Data.
    https://doi.org/10.5281/zenodo.10976733
- **Source**: https://zenodo.org/records/10976733

### World Bank Open Data
- **Used for**: GDP per capita PPP (country tier), Freedom (component).
- **License**: CC BY 4.0.
- **Source**: https://data.worldbank.org

### van Donkelaar PM2.5 (V6.GL)
- **Used for**: Air Quality (`air`).
- **License**: No explicit Creative Commons license; data is publicly
  redistributed via the SEDAC archive at NASA. Academic citation requested.
- **Citation**:
  - van Donkelaar, A. et al. (2021). *Monthly Global Estimates of Fine
    Particulate Matter and Their Uncertainty.* Environmental Science &
    Technology.
- **Source**: https://www.satpm.org and https://sedac.ciesin.columbia.edu

### ETOPO 2022 (NOAA NCEI)
- **Used for**: Elevation (`elev`), and as a component of the multi-hazard
  Risk index.
- **License**: U.S. Public Domain.
- **Attribution**: "ETOPO 2022 Global Relief Model. NOAA National Centers
  for Environmental Information." Cannot claim NOAA endorsement.
- **Source**: https://www.ngdc.noaa.gov/mgg/global/

### GEM Seismic Hazard Map
- **Used for**: Risk (`risk`) — seismic component.
- **License**: CC BY-NC-SA 4.0 (open release). Commercial use requires a
  separate license from the GEM Foundation.
- **Citation**:
  - Pagani, M. et al. (2023). *Global Earthquake Model (GEM) Global
    Seismic Hazard Map (v2023.1.0).* GEM Foundation.
- **Source**: https://hazard.openquake.org

### JRC Global River Flood Hazard
- **Used for**: Risk (`risk`) — flood component.
- **License**: CC BY 4.0.
- **Citation**:
  - Dottori, F. et al. (2016). *Development and evaluation of a framework for
    global flood hazard mapping.* European Commission, JRC.
- **Source**: https://data.jrc.ec.europa.eu

### INFORM Risk (EC JRC)
- **Used for**: Risk (`risk`) — country-level fallback.
- **License**: CC BY 4.0.
- **Source**: https://drmkc.jrc.ec.europa.eu/inform-index/

### Malaria Atlas Project (MAP)
- **Used for**: Healthcare (`hcare`), Travel time to city (`travel`).
- **License**: CC BY 3.0.
- **Citation**:
  - Weiss, D.J. et al. (2020). *Global maps of travel time to healthcare
    facilities.* Nature Medicine 26, 1835–1838.
  - Weiss, D.J. et al. (2018). *A global map of travel time to cities to
    assess inequalities in accessibility in 2015.* Nature 553, 333–336.
- **Source**: https://malariaatlas.org

### Ookla Speedtest Open Data
- **Used for**: Internet (`inet`).
- **License**: CC BY-NC-SA 4.0.
- **Attribution**: "Ookla® Speedtest Intelligence® data, used under
  CC BY-NC-SA 4.0."
- **Source**: https://github.com/teamookla/ookla-open-data

### Transparency International — Corruption Perceptions Index (CPI)
- **Used for**: Freedom (`free`) — corruption component.
- **License**: CC BY 4.0.
- **Attribution**: "Corruption Perceptions Index 2024 by Transparency
  International, licensed under CC BY 4.0."
- **Source**: https://www.transparency.org/en/cpi

### Freedom House — Freedom in the World
- **Used for**: Freedom (`free`) — civil/political liberties component.
- **License**: Free for academic and nonprofit use; commercial use requires
  written permission from Freedom House.
- **Source**: https://freedomhouse.org/report/freedom-world

### SEDAC Global Gridded Relative Deprivation Index (GRDI)
- **Used for**: Deprivation (`depv`).
- **License**: CC BY 4.0.
- **Citation**:
  - CIESIN (2022). *Global Gridded Relative Deprivation Index (GRDI), v1.*
    NASA SEDAC.
- **Source**: https://sedac.ciesin.columbia.edu

### SEDAC SSP Population Grids
- **Used for**: Population (`pop`) future-projection scenarios.
- **License**: CC BY 4.0.
- **Citation**:
  - Jones, B. & O'Neill, B.C. (2016). *Spatially explicit global population
    scenarios consistent with the Shared Socioeconomic Pathways.* Environ.
    Res. Lett.
- **Source**: https://doi.org/10.7927/q7z9-9r69

### CMIP6 via WorldClim
- **Used for**: Future-projection scenarios for Temperature, Temp
  Volatility, Water.
- **License**: CC BY 4.0.
- **Citation**:
  - Fick, S.E. & Hijmans, R.J. (2017). *WorldClim 2: new 1‐km spatial
    resolution climate surfaces for global land areas.* International
    Journal of Climatology 37, 4302–4315.
- **Source**: https://worldclim.org/data/cmip6/cmip6_clim10m.html

### Natural Earth
- **Used for**: Country and state boundary GeoJSONs (basemap layers).
- **License**: U.S. Public Domain (Natural Earth uses no copyright).
- **Source**: https://www.naturalearthdata.com

### geoBoundaries (CGAZ ADM2)
- **Used for**: District-level (ADM2) boundaries for GDP hover and basemap.
- **License**: CC BY 4.0.
- **Citation**:
  - Runfola, D. et al. (2020). *geoBoundaries: A global database of
    political administrative boundaries.* PLOS ONE 15(4): e0231866.
- **Source**: https://www.geoboundaries.org

### CARTO basemap tiles
- **Used for**: Background raster basemap.
- **License**: Free for use with attribution to CARTO and OpenStreetMap.
- **Source**: https://carto.com/basemaps/

### OpenStreetMap
- **Used for**: Underlying geography for the CARTO basemap.
- **License**: Open Database License (ODbL).
- **Attribution**: "© OpenStreetMap contributors."

---

## Combined-output license

Because Ookla and GEM (CC BY-NC-SA 4.0) are mixed into Utopia's combined data
outputs, the bundled tile archives and lookup JSONs as a whole must inherit
CC BY-NC-SA 4.0. See [LICENSE-DATA](./LICENSE-DATA).

If you need to redistribute a Utopia-derived data product under a more
permissive license, you can re-bundle it without the Ookla and GEM layers —
all other layers permit redistribution under their individual terms.
