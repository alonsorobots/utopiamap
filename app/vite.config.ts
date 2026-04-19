import { defineConfig } from 'vite'
import path from 'path'
import react from '@vitejs/plugin-react'
import type { Plugin, Connect } from 'vite'
import { createReadStream, statSync, existsSync } from 'fs'
import { VitePWA } from 'vite-plugin-pwa'

function serveDataTiles(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url?.startsWith('/data/')) return next();

        const relPath = req.url.replace(/^\/data\//, '');
        const filePath = path.resolve(__dirname, '..', 'data', relPath);
        if (!existsSync(filePath) || statSync(filePath).isDirectory()) return next();

        const stat = statSync(filePath);
        const ext = path.extname(filePath);
        const mimeMap: Record<string, string> = {
          '.json': 'application/json',
          '.pmtiles': 'application/octet-stream',
        };

        res.setHeader('Content-Type', mimeMap[ext] ?? 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');

        // Caching policy:
        //   .pmtiles -- versioned by year (pop_2015.pmtiles etc.) or content
        //               (when we eventually add hash suffixes), so they are
        //               effectively immutable. Cache for a year.
        //   catalog.json -- the manifest. Stale catalog means missing/wrong
        //               tile URLs, so revalidate every load.
        //   *.json (other) -- short max-age, allow stale-while-revalidate
        //               so repeat visits feel instant but updates propagate.
        if (ext === '.pmtiles') {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (relPath === 'tiles/catalog.json') {
          res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        } else if (ext === '.json') {
          res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
        }

        const range = req.headers.range;
        if (range) {
          const parts = range.replace('bytes=', '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
          res.setHeader('Content-Length', String(end - start + 1));
          createReadStream(filePath, { start, end }).pipe(res);
        } else {
          res.setHeader('Content-Length', String(stat.size));
          createReadStream(filePath).pipe(res);
        }
  };
  return {
    name: 'serve-data-tiles',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [
    react(),
    serveDataTiles(),
    VitePWA({
      // Use injectManifest? No -- generateSW is enough; we don't need a custom
      // service worker entry. The plugin handles SW generation, registration,
      // and update prompting (we silently auto-update).
      registerType: 'autoUpdate',
      // Precache the SPA shell. Anything else (PMTiles, GeoJSON, JSON
      // lookups) is handled by runtime caching below so we don't bloat
      // first-install with megabytes the user may not need.
      includeAssets: ['favicon.svg', 'robots.txt'],
      manifest: {
        name: 'Utopia',
        short_name: 'Utopia',
        description: 'Build a personal heatmap of where on Earth feels like home.',
        theme_color: '#101016',
        background_color: '#101016',
        display: 'standalone',
        start_url: '/',
      },
      workbox: {
        // Bumped from default 2 MiB so the maplibre/pmtiles JS bundles fit.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // Don't ship the catalog as part of the precache manifest -- it
        // changes whenever tiles are rebuilt and we revalidate it on every
        // load via runtime caching below.
        globIgnores: ['**/data/**', 'tiles/**'],
        navigateFallback: '/index.html',
        // Skip range-requested PMTiles in the navigation handler -- the
        // PMTiles client makes byte-range requests that look like navigations
        // to Workbox if we're not careful. Static SPA navigation only.
        navigateFallbackDenylist: [/^\/data\//, /\.pmtiles$/],
        runtimeCaching: [
          {
            // Catalog manifest -- always revalidate so newly published
            // tile collections show up on the next load.
            urlPattern: /\/data\/tiles\/catalog\.json$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'utopia-catalog',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // PMTiles archives -- versioned by year or content hash so
            // immutable. Use CacheFirst with a generous quota.
            urlPattern: /\/data\/.+\.pmtiles$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'utopia-pmtiles',
              // Workbox keys cache entries by URL+Range header, so a single
              // .pmtiles file can occupy many entries. Cap at 800 entries
              // and ~30 days; the LRU eviction handles spillover.
              expiration: { maxEntries: 800, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200, 206] },
              rangeRequests: true,
            },
          },
          {
            // Per-axis lookup JSONs (gdp_state_scores, energy_scores,
            // crops_lookup, etc.) -- small, occasionally updated.
            urlPattern: /\/(data\/)?.*(crops_lookup|state_scores|country_scores|cost_cities|free_scores|energy_scores).*\.json$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'utopia-lookups',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Vector hit-test geojson layers used eagerly on first paint.
            urlPattern: /\.geojson$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'utopia-geojson',
              expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Carto basemap tiles -- cache for offline-ish second visits.
            urlPattern: /^https:\/\/basemaps\.cartocdn\.com\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'utopia-basemap',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: { host: true },
})
