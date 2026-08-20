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

**Driving**: [OpenStreetMap](https://www.openstreetmap.org/copyright), every
drivable street class (motorway down through residential and
living_street — not service roads/driveways, tracks, or non-motorised
paths), fetched via the [Overpass API](https://overpass-api.de/).
Attribution required (ODbL): "© OpenStreetMap contributors".

- Started as motorway/trunk only (~18,000 ways, "using autoroutes" was the
  original brief); extended to every street on request. That is
  ~408,500 ways nationally and, after processing, 4.1 million nodes and
  8.1 million directed edges — see the road-network numbers below and
  `scripts/build-road-network.mjs`'s header comment for the exact Overpass
  query. Reaching that scale needed real re-engineering beyond the original
  motorway-only design: a CSR (typed-array) graph representation instead of
  per-edge JS objects, batched map rendering instead of one feature per
  edge, and lazy loading so a transit-only visit never downloads the ~120MB
  road network at all. See "Bugs found" below for what broke first at each
  order-of-magnitude jump and how it was found.
- No traffic modelling — edge speeds come from each way's own `maxspeed`
  tag, or a per-class default (120 km/h motorway down to 20 km/h
  living_street) when untagged.

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

Real road-network numbers (every drivable street class):

| Stage | Count |
|---|---|
| OSM ways in the Overpass export | 408,507 |
| Distinct nodes in the raw export | 4,137,798 |
| Nodes kept (4,319 dropped: disconnected islands under 10 nodes) | 4,133,479 |
| Directed edges kept | 8,099,671 |
| Origin-eligible nodes (SCC ≥ 20 nodes — see bug 7 below) | 4,116,901 (99.6%) |

Output (`data/output/road-network/`, gitignored — regenerate with
`npm run build:road-network` once `data/osm-roads-switzerland.json` exists —
see `scripts/build-road-network.mjs`'s header for the Overpass query; needs
`--max-old-space-size=8192`, already set in the npm script, to parse a
~500MB export):

- `nodes.bin` (33.1 MB) — LV95 coordinates, packed `(int32 easting, int32
  northing)` pairs, one per kept node.
- `edges.bin` (64.8 MB) — every directed edge, **sorted by source node**, as
  a packed `(uint32 toNodeIndex, float32 travelSeconds)` pair.
- `edge-offsets.bin` (16.5 MB) — CSR row pointers: node `i`'s own edges are
  `edges.bin[edgeOffsets[i] .. edgeOffsets[i+1])`. This is what lets the
  "from" field be dropped from `edges.bin` entirely.
- `origin-eligible.bin` (4.1 MB) — one byte per node, 1 or 0 (see bug 7).

~118MB total, loaded lazily — see "Test viewer" below. Builds in under a
minute from the cached Overpass export (with the larger heap). A search
(`findReachableRoadNodes`) still runs in **around a second** even reaching
into the millions of nodes — 733ms to reach 1,555,552 junctions (over a
third of the entire national network) within 60 minutes of central Bern.

`src/carRouter.ts` has 5 unit tests against small hand-built graphs
(`src/carRouter.test.ts`).

### Bugs found by testing against real data, not just hand-built cases

Ten, across the data pipeline and the viewer — worth recording, since none
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
   use — those never reach a node count where this mattered. (This whole
   hex-fill approach for driving was later replaced outright — see "Test
   viewer" above and bugs 9-10 below — once the network grew from
   motorway/trunk to every street and the project owner asked for
   street-following lines instead of an area fill; `computeHexagons` itself
   lives on for transit alone.)
6. **`ol/Map` and the built-in `Map` collection share a name.** `import Map
   from 'ol/Map.js'` shadows JavaScript's own `Map` class for the rest of
   the file — `new Map<string, number>()` for the stop-search index silently
   resolved to OpenLayers' map constructor instead, caught immediately by
   `tsc` rather than at runtime. Fixed by importing OpenLayers' class as
   `OlMap`.
7. **A motorway-grade off-ramp is a real dead end in a motorway-only graph.**
   Switching the driving isochrone from hex fill to street-following lines
   (per the project owner's request) surfaced this: clicking a spot in Bern
   snapped to the nearest node with at least one outgoing edge, which
   turned out to be the tail end of a `trunk_link` off-ramp
   ("Tiefenaustrasse") that exits onto an ordinary street this graph
   doesn't carry — "reached 2 junctions" instead of tens of thousands.
   "Has an outgoing edge" isn't the same question as "can actually get
   somewhere," and no small hand-built test graph has ramps subtle enough
   to expose the gap. Traced the node's real neighbours to confirm it
   before fixing: node → one `trunk_link` edge → a second node with zero
   outgoing edges, i.e. a two-node stub. Fixed with Tarjan's
   strongly-connected-components algorithm (`build-road-network.mjs`): a
   node only counts as a valid search *origin* if its SCC has at least 20
   nodes, meaning it can both leave and return rather than dead-end onto
   an unmapped street. (Checked the actual SCC size distribution rather
   than guessing the threshold — it barely moves between 5 and 100, a
   clean gap separates real sub-networks from ramp stubs.) Weak
   (undirected) connectivity, filtered separately, answers a different
   question — "is this node reachable at all" — the right one for deciding
   whether to keep a node as a possible *destination*.
8. **Six components under 10 nodes were genuinely disconnected islands** —
   found while investigating bug 7. A short motorway/trunk-tagged segment
   whose real-world connections at *both* ends are to an unmapped road
   class becomes its own tiny fragment, unreachable from the rest of the
   graph in either direction. First instinct was to keep only the single
   *largest* connected component, which would have discarded 36 other real,
   sizeable regional networks along with the artifacts — the second-largest
   alone has 4,842 nodes. Checking the actual size distribution first
   showed the real fix: every genuine sub-network has 19+ nodes, then a
   sharp cliff straight to six components of 4 nodes or fewer. Dropped only
   those.
9. **A million-plus individual `Feature`s froze the tab for 30+ seconds.**
   Extending the driving network from motorway/trunk (max ~97,000 reached
   edges) to every street meant the same 60-minute search from central Bern
   now reaches 1,555,552 nodes — and one OL `Feature` per edge, the
   approach that worked fine at the old scale, meant building and styling
   over 1.5 million of them synchronously on the main thread. Found by
   actually running that search rather than assuming the old approach would
   scale — the page didn't crash, it just stopped responding to anything,
   including the status text update that would have said so. Fixed by
   splitting edges across a small, fixed number (`CAR_ROAD_BATCH_COUNT`,
   24) of `MultiLineString` features instead of one per edge, and — a
   related discovery — decimating the reached network's dead-end "tip"
   markers (78,540 of them at that same search, one for every cul-de-sac)
   onto a coarse grid, keeping only the furthest-arriving one per cell.
10. **Redundant redraw on every mode switch.** Even after fixing bug 9,
    switching back to car mode after visiting transit mode redrew the same
    million-plus-edge result from scratch each time. `drawCarRoads` now
    checks whether the result object is the same one it last drew and
    skips the rebuild if so — confirmed genuinely fast (a fraction of a
    millisecond) via `console.time` around the call site instrumented
    directly in the running page, since Playwright's own wall-clock timing
    around the click included the browser's separate canvas repaint cost
    and made the JS side look slower than it actually was.

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
- **Destination tips + hover itinerary** — restricted to arms whose tip
  lands within `TIP_TIME_TOLERANCE_SECONDS` (3 minutes) of the budget's own
  deadline, not every dead end reached along the way: most stops with no
  onward leg were reached with plenty of budget still spare (they're a
  branch's end, not "how far can I get"), and for the driving network
  especially, showing all of them was both visually overwhelming and slow
  (see bug 9). Hovering a kept tip shows the full point-to-point itinerary:
  which stop to walk to, which service to board and when, the wait at each
  change, and the final arrival — backed by a real `getJourneyTo(stopIndex)`
  added to the router itself (`src/raptor.ts`), not just viewer-side
  formatting.
- **English / French / German** — `viewer/src/translations.ts`, a language
  switcher in the panel, persisted to `localStorage`.
- **Driving mode** — a Google-Maps-style switch at the top of the panel
  flips between public transport and car. Car mode runs `findReachableRoadNodes`
  over the national street graph instead of RAPTOR and draws the result
  differently from transit's hex fill: every reached road segment as its
  own thin, semi-transparent blue stroke, tracing the actual streets rather
  than an abstracted area, with each branch's own frontier point (see
  "Destination tips" above) marked by a ring-and-dot and the origin by a
  solid dot. The road network itself
  (~120MB) is fetched lazily on first switch to car mode, not upfront with
  the transit snapshot, and cached after that — see bugs 9 and 10 below for
  what it took to keep both the render and the mode switch fast at national
  scale.
- **Hover-highlighted route** — hovering a destination (a transit tip or a
  car tip alike) draws the actual point-to-point route to it: transit's own
  full itinerary text for transit, and a solid heavier-weight line traced
  over the always-visible thin network for driving, backed by
  `getJourneyTo` (`src/raptor.ts`) and `getRouteTo` (`src/carRouter.ts`)
  respectively.
- **Manual stop entry** — a text input with autocomplete over every used
  transit stop's name (transit mode only; road junctions have no name in
  this data), so a reader who knows their starting point does not have to
  find it on the map first.

Verified end to end with headless-browser checks (Playwright, see
`viewer/README` notes below): basemap renders, a click resolves to the
nearest stop or street depending on mode, both searches run at both small
and national scale, the mode switch preserves each side's own result and
lazy-loads the road network exactly once, stop-name search recentres the
map and searches, hover routes and itineraries and all three languages
read correctly.

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
4. ~~Driving mode~~ — done, now over every drivable street nationally (see
   above), not just motorway/trunk.
5. **Worker + UI wiring inside viatopo itself.** The test viewer proves both
   searches work; neither is the shipped feature. Turning it into one means
   mirroring `dynamicRoutingWorker.ts` / `useReachabilityTool.ts` /
   `reachabilityDisplay.ts` from viatopo's walking feature: a worker holding
   the loaded snapshot(s), a time-budget slider (likely 1–3 hours for
   transit, less for driving), and a map layer distinguishing mode by colour
   the way the viewer already does. Comparable in size to the whole
   walking-feature port done earlier in `viatopo`. At the road network's
   current scale, this almost certainly needs the Dijkstra search itself
   moved into the worker too (it already runs off the main thread for
   transit) rather than on the page's own thread as it does in the test
   viewer today.
6. **Combining with viatopo's walking search** for the first/last-mile legs
   of a real journey — right now the origin is "nearest stop" or "nearest
   street," not "wherever the reader actually clicked."
7. **Where this lives long-term.** This folder is a standalone workspace for
   now. Once item 5 exists, the natural home for the shipped feature is
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
    road-network/nodes.bin, edges.bin,          build-road-network.mjs's output
      edge-offsets.bin, origin-eligible.bin
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
