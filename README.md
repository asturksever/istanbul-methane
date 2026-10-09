# Istanbul methane

Carbon Mapper methane plumes over Istanbul's two big landfills, drawn as volumetric 3D gas clouds on a 3D map:
an open satellite map that needs no key, or Google Photorealistic 3D Tiles if you have a key. One static web app does two jobs: an interactive explorer, and (driven frame by frame
by `render.py`) a cinematic video renderer.

- **Silivri:** Seymen landfill, European side
- **Şile:** Kömürcüoda landfill, Asian side

Data: [Carbon Mapper](https://data.carbonmapper.org) (Tanager-1 and EMIT, Jun 2024 to Apr 2026, 13 overpasses,
16 plumes). 3D map: Esri World Imagery on open terrain by default, Google Photorealistic 3D Tiles optionally. Rendering: CesiumJS. Plume footprints and emission rates are
measured; plume heights, turbulence and motion are modelled for illustration, and the UI says so.

## Run the app

```bash
cd web && python3 -m http.server 8000     # then open http://localhost:8000
```

No build step. CesiumJS loads from jsDelivr. For offline use and for the renderer, `npm install` and link the
local copy with `ln -s ../node_modules/cesium/Build/Cesium web/cesium`; on localhost the page prefers it.

Two 3D base maps:

- **Open map (default, no key).** Esri World Imagery draped on open terrain (Mapzen Terrain Tiles on AWS Open
  Data: SRTM, EU-DEM, GMTED, ETOPO1, decoded in the browser). Anyone with the link can explore. The sea floor is
  clamped to sea level so the coasts sit flat; bundled crops of the two sites show wherever a world tile fails.
- **Google Photorealistic 3D Tiles (optional).** Buildings and landfill terraces in full 3D. Click "Google 3D
  Tiles" in the panel and paste a Google Maps Platform API key with the Map Tiles API enabled. The key is kept in
  the browser's localStorage and sent only to tile.googleapis.com. For a public deploy, put a key restricted to
  your domain's HTTP referrer in `web/config.js`; visitors then get Google's tiles by default and can switch to
  the open map from the panel.

`?base=open` forces the open map even when a key is stored (the old `?nokey=1` still works).

Deploy: the `web/` folder is the whole site. `netlify.toml` and `vercel.json` point at it, or drag the folder
onto app.netlify.com/drop.

GitHub Pages: `.github/workflows/pages.yml` publishes `web/` on every push to `main` that touches it (or run it
by hand from the Actions tab). One-time setup: Settings > Pages > Source: GitHub Actions. Optionally add a
repository secret `GMAPS_PUBLIC_KEY` holding a browser key restricted to `https://asturksever.github.io/*`;
the workflow writes it into `config.js` at deploy time so visitors get Google's 3D tiles. Without it, visitors
get the open map. The site is served
at https://asturksever.github.io/istanbul-methane/.

### Features

- Site switch, overpass list and a timeline of every detection from Jun 2024 to today (withheld rates as hollow
  dots); click a dot or row to jump to that overpass.
- Free orbit and zoom, auto-orbit, Motion, Replay plume, Speed (0.25x to 4x, also drives the tour), Density.
- Display settings: Look (Ember with red core, Turbo, Natural), Height (vertical exaggeration; 1x is the
  physical spread), Quality (Auto adapts only once the map has settled, never below 75% resolution).
- Play tour: the 64 s video choreography with play/pause, scrubber and chapters.
- Shareable links (`?site=&ov=&look=`), Copy link, keyboard shortcuts (arrow keys pan the map, c re-centre,
  j/k overpass, space tour, 1/2 site, [ ] speed, o orbit, r replay, h panel).
- Fast first load: the engine, data and app code download in parallel, only the opening site's terrain is read
  before the map appears (the other site's on first visit, with coarser tiles than the video renderer), and a
  loading screen with progress shows from the first paint.
- Phone layout (bottom sheet), focus styles, reduced-motion support, clear errors for a rejected or restricted
  key, WebGL 2 check.

## Plume model

- Horizontal footprint and rate: Carbon Mapper plume rasters (measured), composited per overpass.
- Vertical structure: Gaussian plume from a ground-level area source; sigma_z from Briggs rural dispersion
  curves, blended across stability classes A to D from the overpass wind speed, capped at a 900 m morning mixing
  height. The profile is normalised, so the vertical integral equals the measured column.
- Turbulence: billowy noise frozen into the air and advected with the wind, eddies growing with the plume,
  wind-aligned streaks, eroded edges.
- Light: sun position from the overpass time, 3-octave multiple scattering, dual-lobe phase function, sky and
  ground ambient, fog matched to Cesium's, soft plume shadow on the ground.
- Implementation: a depth-aware post-process raymarch in `web/app.js` (local east-north-up frame per site,
  Cesium log depth decoded exactly, half-resolution volume with a tent-filter composite).

## Render the video

```bash
npm install && ln -s ../node_modules/cesium/Build/Cesium web/cesium   # local CesiumJS for the renderer
pip install playwright && playwright install chromium
export GOOGLE_MAPS_API_KEY=AIza...            # never commit it
python3 render.py                             # -> out/istanbul-methane.mp4, 64 s, 1920x1080, 30 fps
python3 render.py --stills 3,22,47            # stills at those seconds
```

Options: `--fps 30 --w 1920 --h 1080 --sse 8 --steps 80 --volscale 0.5 --look ember|turbo|natural --crf 16`.
30 fps is the recommended output: at a fixed upload size every extra frame costs detail, and a tested 90 fps
version looked much worse at 30 MB than 30 fps. Rendering is resumable: frames are written in segments under
`out/<name>_segments/` and a rerun skips finished ones. With a GPU it takes minutes; on a software renderer, hours.

## Data tools

- `tools/fetch_istanbul.py`: every Carbon Mapper CH4 plume over Istanbul province for the last N years
  (`--years 2`), as plumes.json, plumes.csv and a per-source summary.
- `tools/fetch_plumes.py` and `tools/invert_plume_png.py`: refresh the two landfill sites and rebuild
  `data/plumes.js` (copy it to `web/plumes.js` to use it in the app).

## Credits

Methane data: Carbon Mapper. 3D map: Esri World Imagery (Esri, Maxar, Earthstar Geographics, GIS User
Community) on Mapzen Terrain Tiles hosted by AWS Open Data, or Google Photorealistic 3D Tiles. The active map's
attribution is shown on screen. Rendering: CesiumJS.
