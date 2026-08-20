# Transit reachability

Given a start point and a time budget, show everywhere reachable — by
train, bus, tram, boat, cable car, and funicular, or by car — the same idea
as viatopo's walking "reachable area" search, for transit and driving.

## Data sources

**Public transport**: [opentransportdata.swiss](https://opentransportdata.swiss/)
GTFS Switzerland feed (mirrored for convenience at
https://gtfs.geops.ch/dl/gtfs_complete.zip).

- Covers all Swiss public transport: rail, bus, tram, metro, ferry, cable
  car/gondola, funicular.
- ~165 MB compressed / ~1.65 GB uncompressed, one file per timetable year,
  regenerated twice a week.
- Free for hobby/open-source use below rate limits. **Attribution required**:
  cite "opentransportdata.swiss" as the source in any published use.
- No isochrone or "reachable within X minutes" API exists anywhere in the
  Swiss transit open-data ecosystem (checked opentransportdata.swiss and
  transport.opendata.ch) — this has to be computed from the raw timetable,
  the same way viatopo's own walking search computes its own Dijkstra rather
  than calling an external routing API.
- Decided with the project owner (2026-08-19): v1 uses one fixed reference
  day from the static feed, not live GTFS-RT. Real-time delays/cancellations
  are a planned follow-up, not built now — the design below doesn't preclude
  it (RT would overlay adjusted times/cancellations on the same trip/pattern
  structure rather than requiring a rewrite).
- Decided with the project owner: national coverage from the start, not a
  regional pilot.

**Driving**: [OpenStreetMap](https://www.openstreetmap.org/copyright), the
motorway + trunk tiers (Switzerland's autoroute/Autobahn and
expressway/Autostrasse network), fetched via the
[Overpass API](https://overpass-api.de/). Attribution required (ODbL): "©
OpenStreetMap contributors".

- Deliberately not every street: a full national road graph is millions of
  edges, too large for a client-side snapshot with no backend, and "using
  autoroutes" was the brief. See `scripts/build-road-network.mjs`'s header
  comment for the exact Overpass query and the scope trade-off this implies
  — the isochrone reads as "how far the motorway/expressway network
  reaches," widened by a flat estimated local-road buffer around each
  reached junction, not a house-to-house result.
- No traffic modelling — edge speeds come from each way's own `maxspeed`
  tag, or a per-class default (120 km/h motorway, 80 km/h trunk, lower for
  slip roads) when untagged.

## Status

**Done and validated**:

1. **Data pipeline** (`scripts/build-snapshot.mjs`) — turns the raw national
   feed into a compact per-day snapshot.
2. **RAPTOR router** (`src/raptor.ts`) — real, tested, reading that snapshot.
3. **Walking-distance transfer fallback** — stops not linked by an explicit
   `transfers.txt` entry but within 300m still connect.
4. **Road-network pipeline** (`scripts/build-road-network.mjs`) — turns a
   cached Overpass export into a compact directed graph.
5. **Dijkstra driving router** (`src/carRouter.ts`) — real, tested, the
   driving counterpart of the RAPTOR router.
6. **Standalone test viewer** (`viewer/`) — a real browser page proving both
   modes work end to end, verified with headless-browser checks, with a
   Google-Maps-style switch between them.

Real transit numbers from a run against 2026-08-19 (a Wednesday):

| Stage | Count |
|---|---|
| GTFS `stop_times.txt` rows (whole year) | 29,571,505 |
| Active trips on the reference day | 204,257 |
| Distinct stops in the feed | 68,069 |
| **Distinct patterns** (trips grouped by identical ordered stop sequence — the key size win, and what a RAPTOR-style search scans) | 19,017 |
| Stop-time entries retained | 2,898,767 |
| Explicit transfers (`transfers.txt`) | 7,816 |
| Walking transfers added (≤300m, not already explicit) | 96,389 |

Output (`data/output/`, gitignored — regenerate with the script):

- `stops.json` (2.4 MB) — stop names + LV95 (EPSG:2056) coordinates, converted
  from the feed's WGS84 with swisstopo's published approximation formula.
- `manifest.json` (~6 MB) — one entry per pattern: its ordered stop sequence,
  GTFS `route_type` (mode), and byte offsets into the binary blob below.
- `stop-times.bin` (23.2 MB) — every trip's arrival/departure seconds as
  packed `uint32` pairs, one pattern's trips after another.

~30 MB uncompressed total; should compress well under standard gzip/brotli
(untested — worth confirming once this is served). Builds in ~35s on the full
national feed. A search itself (`findReachableStops`) runs in **single-digit
to double-digit milliseconds** even from a major hub — 65ms for 2,459 stops
from central Bern, walking transfers included.

`src/raptor.ts` has 7 unit tests against small hand-built timetables
(`src/raptor.test.ts`), plus `scripts/smoke-test.mjs`, a manual check against
the real national snapshot (not part of `npm test` — needs `data/output/` to
exist first).

Real road-network numbers (motorway + trunk, including slip roads):

| Stage | Count |
|---|---|
| OSM ways in the Overpass export | 18,219 |
| Distinct nodes used | 148,605 |
| Directed edges (one-way ways contribute one, two-way contribute two) | 158,747 |

Output (`data/output/road-network/`, gitignored — regenerate with
`npm run build:road-network` once `data/osm-roads-switzerland.json` exists —
see `scripts/build-road-network.mjs`'s header for the Overpass query):

- `nodes.json` (2.3 MB) — LV95 coordinates, one entry per used node.
- `edges.bin` (1.9 MB) — every directed edge as a packed `(uint32 from,
  uint32 to, float32 travelSeconds)` triple.

Builds in well under a second from the cached Overpass export. A search
(`findReachableRoadNodes`) runs in **single-digit milliseconds** even
reaching tens of thousands of junctions — 8ms for 45,278 junctions within 60
minutes of central Zürich.

`src/carRouter.ts` has 4 unit tests against small hand-built graphs
(`src/carRouter.test.ts`).

### Bugs found by testing against real data, not just hand-built cases

Six, across the data pipeline and the viewer — worth recording, since none
of them would have surfaced from small examples alone:

1. **CSV quoting.** 57,602 rows in `stops.txt` alone contain a quote
   character — Swiss stop names routinely embed a comma ("Genève,
   Cornavin"), which a naive `line.split(',')` does not just mis-render, it
   shifts every later column for that row. Fixed with a real RFC4180 field
   splitter in `build-snapshot.mjs`.
2. **Origin-label mutation → infinite loop.** `reconstructLegs` walks each
   reached stop's "how did I get here" chain back to the origin. Nothing in
   the algorithm protected the origin's own label from being overwritten,
   and a handful of the feed's non-passenger "stops" (see next bug) produced
   arrival times earlier than the search's own departure, which could chain
   back and replace the origin's label — creating a 2-cycle that made the
   backward walk loop forever. Found because a search from Bern, a real
   hub, hung for 60+ seconds instead of the ~3ms a search actually needs.
   Fixed by making the origin immutable for the life of one search, with a
   defensive cycle-guard left in `reconstructLegs` regardless. Regression
   test: "never lets a bogus early time or a transfer back to it replace the
   origin."
3. **Silent `Number('')` coercion.** A `stop_times.txt` row with
   `pickup_type=1, drop_off_type=1` (and, it turns out, empty
   `arrival_time`/`departure_time`) marks a point a vehicle passes through
   without boarding — GTFS uses this for named tunnel/track sections kept
   only for shape accuracy, not real stops. `''.split(':').map(Number)`
   silently read that as `00:00:00`, which is what bug 2's anomalous early
   times actually were, and made things like "Lötschberg-Basistunnel" look
   like a real destination reachable from anywhere in one leg at midnight.
   Fixed by skipping stop_times rows with no recorded time (1,139 of 29.5M).
4. **`optionsFromCapabilities` can't resolve swisstopo's own capabilities
   document.** Its declared CRS is the URN `urn:ogc:def:crs:EPSG::2056`, and
   `ol/tilegrid/WMTS.js`'s internal `createFromCapabilitiesMatrixSet` looks
   the projection up by that exact string with no override available —
   throws reading `getAxisOrientation` off the `null` that returns. viatopo's
   own codebase already sidesteps this by stating the LV95 tile grid
   directly (`src/map/lv95.ts`) rather than parsing it from capabilities;
   `viewer/src/main.ts` copies that approach.
5. **One splat per road node, not per stop, is a different order of
   magnitude.** The isochrone hex-fill algorithm (`computeHexagons`) splats
   a catchment circle from every reached point — fine for transit, where a
   search reaches a few thousand stops at most. The driving router reaches
   every node in the road graph it can afford, tens of thousands of them,
   many mere metres apart along the same carriageway; splatting each one
   independently, several with almost the entire budget still spare (every
   junction near the origin), froze the browser tab for over a minute on a
   single click. Fixed two ways: bucketing reached nodes onto the same hex
   grid before splatting, keeping only the earliest arrival per cell (caps
   the splat count at the network's own footprint rather than its node
   count), and capping how much leftover budget counts toward any one
   splat's radius (`CAR_CATCHMENT_CAP_SECONDS`, 15 minutes) — nobody
   detours 50 km onto back roads from a motorway exit anyway, so the cap is
   the more realistic answer as well as the fast one. Found by testing an
   actual 60-minute search, not the small hand-built graphs the unit tests
   use — those never reach a node count where this mattered.
6. **`ol/Map` and the built-in `Map` collection share a name.** `import Map
   from 'ol/Map.js'` shadows JavaScript's own `Map` class for the rest of
   the file — `new Map<string, number>()` for the stop-search index silently
   resolved to OpenLayers' map constructor instead, caught immediately by
   `tsc` rather than at runtime. Fixed by importing OpenLayers' class as
   `OlMap`.

## Test viewer

`viewer/` is a small standalone Vite + OpenLayers page for trying the search
in an actual browser — not the final UI, just the fastest way to see it work
before committing to the bigger viatopo integration below.

```
cd viewer
npm install
npm run dev
```

Open the printed local URL, wait for "Loaded 68,069 stops…", click anywhere
to search from the nearest stop, adjust the departure time or the budget
slider to re-run. It imports `../src/raptor.ts` and `../src/timetable.ts`
directly — nothing is duplicated between the two.

Since the first version, it has grown:

- **Isochrone area** — a hex-grid heatmap (`src/isochrone.ts`), green→red by
  travel time, computed from the walking catchment around every reached
  stop given whatever budget is left after arriving there — not just the
  transit lines, so it reads like isochrone.ch's own filled-area view.
  Toggleable independently from the line network.
- **Destination tips + hover itinerary** — every arm's actual endpoint gets
  a marker, and hovering one shows the full point-to-point itinerary: which
  stop to walk to, which service to board and when, the wait at each
  change, and the final arrival — backed by a real `getJourneyTo(stopIndex)`
  added to the router itself (`src/raptor.ts`), not just viewer-side
  formatting.
- **English / French / German** — `viewer/src/translations.ts`, a language
  switcher in the panel, persisted to `localStorage`.
- **Driving mode** — a Google-Maps-style switch at the top of the panel
  flips between public transport and car. Car mode runs `findReachableRoadNodes`
  over the motorway/trunk graph instead of RAPTOR, draws the same isochrone
  hex fill (with its own local-road catchment assumption, see the data
  source section above) plus every reached road segment coloured on the
  same green-to-red scale, and keeps each mode's own last result cached so
  flipping back and forth redraws instantly rather than re-running a search.
- **Manual stop entry** — a text input with autocomplete over every used
  transit stop's name (transit mode only; road junctions have no name in
  this data), so a reader who knows their starting point does not have to
  find it on the map first.

Verified end to end with headless-browser checks (Playwright, see
`viewer/README` notes below): basemap renders, a click resolves to the
nearest stop or road junction depending on mode, both searches run, legs
and hexes draw correctly, the mode switch preserves each side's own result,
stop-name search recentres the map and searches, hover itineraries and all
three languages read correctly.

## Hosting (GitHub Pages)

`.github/workflows/deploy.yml` builds `viewer/` and deploys it to GitHub
Pages on every push to `main`. What that means concretely:

- The committed data snapshot under `viewer/public/data/` (~32MB) is what
  ships — the workflow does **not** re-run `build-snapshot.mjs`, so the
  reachability results reflect whatever reference day was last committed
  (currently 2026-08-19), not "today." Moving to a scheduled rebuild (a cron
  trigger that re-runs the snapshot script and commits the refreshed output
  before the deploy step, mirroring the `chore/snapshot-*` pattern viatopo's
  own repo already uses) is a natural follow-up, not yet built.
- `vite.config.ts`'s `base` is conditional on `process.env.GITHUB_ACTIONS`,
  set automatically by every Actions run and never locally — a project site
  is served from `https://<user>.github.io/<repo>/`, not root, so every
  built asset path needs that prefix, but only in the build Actions itself
  produces. Getting this wrong was a real bug caught before deploying: a
  `vite preview` of a build built as if it were the GitHub Pages one
  returned HTTP 200 for a missing script — the preview server's own SPA
  fallback silently served `index.html` in its place, which only the
  response's content type gave away.
- `.github/workflows/test.yml` runs the router's unit tests and both
  projects' type-checks on every push.
- One-time manual step on GitHub: Settings → Pages → Source → "GitHub
  Actions" (only needed the first time; the workflow handles every deploy
  after that).

## Not done yet

1. ~~RAPTOR router~~ — done.
2. ~~Walking-distance transfer fallback~~ — done.
3. ~~Something to see it work in a browser~~ — done (the test viewer).
4. ~~Driving mode~~ — done (motorway/trunk network, see above).
5. **Worker + UI wiring inside viatopo itself.** The test viewer proves both
   searches work; neither is the shipped feature. Turning it into one means
   mirroring `dynamicRoutingWorker.ts` / `useReachabilityTool.ts` /
   `reachabilityDisplay.ts` from viatopo's walking feature: a worker holding
   the loaded snapshot(s), a time-budget slider (likely 1–3 hours for
   transit, less for driving), and a map layer distinguishing mode by colour
   the way the viewer already does. Comparable in size to the whole
   walking-feature port done earlier in `viatopo`.
6. **Combining with viatopo's walking search** for the first/last-mile legs
   of a real journey — right now the origin is "nearest stop" or "nearest
   motorway junction," not "wherever the reader actually clicked."
7. **A real street network for driving.** The motorway/trunk-only graph
   answers "how far does the expressway network reach," not "how far can I
   actually drive" — the flat local-road catchment buffer is an honest
   approximation, not the real thing. A fuller street graph would need
   either a much larger client-side snapshot (millions of edges) or a
   backend to route against, neither built here.
6. **Where this lives long-term.** This folder is a standalone workspace for
   now. Once item 4 exists, the natural home for the shipped feature is
   inside the `viatopo` repo itself (`D:\WORK_MICHEL\VIATOPO\viatopo`),
   following the same `scripts/update:*` snapshot-script convention already
   used there (e.g. `update-sac-huts.mjs`) rather than staying separate.

## Folder layout

```
data/
  gtfs_switzerland.zip          raw GTFS feed (not committed — re-download to refresh)
  extracted/                     unzipped GTFS CSVs
  osm-roads-switzerland.json    raw Overpass export (not committed — re-download to refresh)
  output/
    manifest.json, stops.json, stop-times.bin   build-snapshot.mjs's output
    road-network/nodes.json, edges.bin          build-road-network.mjs's output
scripts/
  lib/geo.mjs             shared WGS84 -> LV95 conversion
  inspect.mjs             one-off exploration script (row counts, mode breakdown)
  build-snapshot.mjs      the transit data-prep pipeline
  build-road-network.mjs  the driving data-prep pipeline
  smoke-test.mjs          manual check against the real national snapshot
src/
  timetable.ts            snapshot -> queryable Timetable, shared by the router and viewer
  raptor.ts                the transit search
  raptor.test.ts           unit tests
  roadNetwork.ts           snapshot -> queryable RoadNetwork
  carRouter.ts              the driving search (Dijkstra)
  carRouter.test.ts         unit tests
viewer/                     standalone Vite + OpenLayers page, see above
```
