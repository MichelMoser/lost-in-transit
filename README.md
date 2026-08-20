# Transit reachability

Public-transport version of viatopo's walking "reachable area" search:
given a start point and a time budget, show everywhere reachable by
train, bus, tram, boat, cable car, and funicular — the same idea as the
walking kraken, but for transit.

## Data source

[opentransportdata.swiss](https://opentransportdata.swiss/) GTFS Switzerland
feed (mirrored for convenience at https://gtfs.geops.ch/dl/gtfs_complete.zip).

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

## Status

**Done and validated**:

1. **Data pipeline** (`scripts/build-snapshot.mjs`) — turns the raw national
   feed into a compact per-day snapshot.
2. **RAPTOR router** (`src/raptor.ts`) — real, tested, reading that snapshot.
3. **Walking-distance transfer fallback** — stops not linked by an explicit
   `transfers.txt` entry but within 300m still connect.
4. **Standalone test viewer** (`viewer/`) — a real browser page proving the
   whole thing works end to end, verified with a headless-browser check.

Real numbers from a run against 2026-08-19 (a Wednesday):

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

### Bugs found by testing against real data, not just hand-built cases

Four, across the data pipeline and the viewer — worth recording, since none
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

Verified end to end with a headless-browser check (Playwright, see
`viewer/README` notes below): basemap renders, a click resolves to the
nearest stop, the search runs, legs and hexes draw correctly, hover
itineraries and all three languages read correctly.

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
4. **Worker + UI wiring inside viatopo itself.** The test viewer proves the
   search works; it is not the shipped feature. Turning it into one means
   mirroring `dynamicRoutingWorker.ts` / `useReachabilityTool.ts` /
   `reachabilityDisplay.ts` from viatopo's walking feature: a worker holding
   the loaded snapshot, a time-budget slider (likely 1–3 hours, since transit
   covers far more ground than walking), and a map layer distinguishing mode
   by colour the way the viewer already does. Comparable in size to the whole
   walking-feature port done earlier in `viatopo`.
5. **Combining with viatopo's walking search** for the first/last-mile legs
   of a real journey — right now the origin is "nearest stop," not "wherever
   the reader actually clicked."
6. **Where this lives long-term.** This folder is a standalone workspace for
   now. Once item 4 exists, the natural home for the shipped feature is
   inside the `viatopo` repo itself (`D:\WORK_MICHEL\VIATOPO\viatopo`),
   following the same `scripts/update:*` snapshot-script convention already
   used there (e.g. `update-sac-huts.mjs`) rather than staying separate.

## Folder layout

```
data/
  gtfs_switzerland.zip   raw feed (not committed anywhere — re-download to refresh)
  extracted/             unzipped CSVs
  output/                build-snapshot.mjs's output
scripts/
  inspect.mjs            one-off exploration script (row counts, mode breakdown)
  build-snapshot.mjs     the real data-prep pipeline
  smoke-test.mjs         manual check against the real national snapshot
src/
  timetable.ts           snapshot -> queryable Timetable, shared by the router and viewer
  raptor.ts               the search itself
  raptor.test.ts          unit tests
viewer/                   standalone Vite + OpenLayers page, see above
```
