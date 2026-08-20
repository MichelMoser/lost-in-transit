/**
 * Business context: turns the national Swiss GTFS feed (~1.65 GB uncompressed
 * across ten relational CSV files) into one compact per-day snapshot a
 * browser can load — a dense set of stops, transfers, and "patterns" (groups
 * of trips sharing the same ordered stop sequence, each stop time as a
 * typed-array row) that a RAPTOR search can scan directly.
 *
 * GTFS stores each trip's PATTERN once, referenced by a service_id whose
 * active dates live in calendar_dates.txt — so "one day" is not one file cut
 * along a date column, it is three passes: which services run on the chosen
 * date, which trips belong to those services, and which stop_times rows
 * belong to those trips. The passes run largest-file-last so the smaller
 * filters are already known before the ~1.4 GB stop_times.txt is streamed
 * exactly once.
 *
 * Usage: `node build-snapshot.mjs [YYYYMMDD]` (defaults to today).
 */
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '../data/extracted');
const OUTPUT_DIR = resolve(HERE, '../data/output');

const referenceDate =
  process.argv[2] ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');

console.log(`Building snapshot for ${referenceDate}`);
console.time('total');

/**
 * Streams one GTFS file line by line, calling `onRow` with an object keyed
 * by the file's own header rather than a fixed schema, since GTFS exporters
 * vary which optional columns they include.
 */
function streamRows(file, onRow) {
  return new Promise((resolvePromise, reject) => {
    const rl = createInterface({
      input: createReadStream(resolve(DATA_DIR, file)),
      crlfDelay: Infinity,
    });
    let header = null;
    rl.on('line', (line) => {
      const cells = splitCsvLine(line);
      if (!header) {
        header = cells;
        return;
      }
      const row = {};
      for (let index = 0; index < header.length; index += 1) {
        row[header[index]] = cells[index];
      }
      onRow(row);
    });
    rl.on('close', resolvePromise);
    rl.on('error', reject);
  });
}

/**
 * Splits one CSV line into fields, honouring RFC4180 quoting: a field
 * wrapped in double quotes may itself contain commas, and a doubled quote
 * inside one is a literal quote character.
 *
 * Swiss stop names routinely embed a comma — "Genève, Cornavin" is the
 * ordinary way this feed spells a station name — so a plain `split(',')`
 * does not just leave stray quote characters in the output, it shifts every
 * column after the quoted field for that entire row: a stop's coordinate
 * ends up read from what was actually its `stop_desc`, and so on down the
 * line. This was found by a smoke test: a well-known hub returned almost no
 * reachable stops, and its own name in the output carried a leading `"`.
 */
function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (insideQuotes) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          insideQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      insideQuotes = true;
    } else if (character === ',') {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }

  fields.push(field);
  return fields;
}

/** Parses "HH:MM:SS" into seconds since midnight, allowing hours past 23. */
function parseGtfsTime(value) {
  const [hours, minutes, seconds] = value.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Converts WGS84 degrees to Swiss LV95 (EPSG:2056) using swisstopo's
 * published approximate formula — accurate to about 1 metre, well inside
 * what a transit stop marker needs.
 */
function wgs84ToLv95(lat, lon) {
  const latSec = (lat * 3600 - 169028.66) / 10000;
  const lonSec = (lon * 3600 - 26782.5) / 10000;
  const easting =
    2600072.37 +
    211455.93 * lonSec -
    10938.51 * lonSec * latSec -
    0.36 * lonSec * latSec ** 2 -
    44.54 * lonSec ** 3;
  const northing =
    1200147.07 +
    308807.95 * latSec +
    3745.25 * lonSec ** 2 +
    76.63 * latSec ** 2 -
    194.56 * lonSec ** 2 * latSec +
    119.79 * latSec ** 3;
  return [Math.round(easting), Math.round(northing)];
}

// --- Pass 1: which services run on the reference date -----------------
const activeServiceIds = new Set();
await streamRows('calendar_dates.txt', (row) => {
  if (row.date === referenceDate && row.exception_type === '1') {
    activeServiceIds.add(row.service_id);
  }
});
console.log('active services:', activeServiceIds.size);

// --- Pass 2: which trips belong to those services ----------------------
/** trip_id -> { routeId } for trips running on the reference date. */
const activeTrips = new Map();
await streamRows('trips.txt', (row) => {
  if (activeServiceIds.has(row.service_id)) {
    activeTrips.set(row.trip_id, { routeId: row.route_id });
  }
});
console.log('active trips:', activeTrips.size);

// --- Route metadata: mode (route_type) per route_id ---------------------
const routeTypeOf = new Map();
await streamRows('routes.txt', (row) => {
  routeTypeOf.set(row.route_id, Number(row.route_type));
});

// --- Stops: dense index, LV95 coordinate, name ---------------------------
const stopIndexOf = new Map();
const stopNames = [];
const stopEastings = [];
const stopNorthings = [];
const stopParent = [];
await streamRows('stops.txt', (row) => {
  const index = stopNames.length;
  stopIndexOf.set(row.stop_id, index);
  stopNames.push(row.stop_name || '');
  const [easting, northing] = wgs84ToLv95(
    Number(row.stop_lat),
    Number(row.stop_lon),
  );
  stopEastings.push(easting);
  stopNorthings.push(northing);
  stopParent.push(row.parent_station || '');
});
console.log('stops in feed:', stopNames.length);

// --- Pass 3: stop_times rows for active trips, grouped per trip ----------
/** trip_id -> array of { stopId, sequence, arrival, departure } */
const stopTimesByTrip = new Map();
let scannedRows = 0;
let skippedNoTimeRows = 0;
await streamRows('stop_times.txt', (row) => {
  scannedRows += 1;
  if (!activeTrips.has(row.trip_id)) {
    return;
  }

  // A row with no times is GTFS's way of marking a point the vehicle passes
  // without boarding — typically paired with pickup_type=1, drop_off_type=1
  // — kept only to preserve the trip's shape. `''.split(':').map(Number)`
  // would otherwise silently read as 00:00:00, which is how the Swiss feed's
  // handful of non-passenger "stops" (named tunnel/track sections, not real
  // places) ended up looking reachable from anywhere in one leg at midnight.
  if (!row.arrival_time || !row.departure_time) {
    skippedNoTimeRows += 1;
    return;
  }

  let rows = stopTimesByTrip.get(row.trip_id);
  if (!rows) {
    rows = [];
    stopTimesByTrip.set(row.trip_id, rows);
  }
  rows.push({
    stopId: row.stop_id,
    sequence: Number(row.stop_sequence),
    arrival: parseGtfsTime(row.arrival_time),
    departure: parseGtfsTime(row.departure_time),
  });
});
console.log('stop_times rows scanned:', scannedRows);
console.log('stop_times rows skipped (no boarding time):', skippedNoTimeRows);
console.log('trips with stop_times:', stopTimesByTrip.size);

// Sort each trip's own stop visits into travel order.
for (const rows of stopTimesByTrip.values()) {
  rows.sort((a, b) => a.sequence - b.sequence);
}

// --- Group trips into patterns: identical ordered stop sequence ----------
/**
 * A pattern is what RAPTOR calls a "route": every trip in it visits the same
 * stops in the same order, so a search can scan trips within one pattern by
 * departure time alone rather than re-deriving the stop sequence per trip.
 */
const patternKeyOf = new Map();
const patterns = [];
for (const [tripId, rows] of stopTimesByTrip) {
  if (rows.length < 2) {
    continue;
  }

  const stopSequence = rows.map((row) => stopIndexOf.get(row.stopId));
  const key = stopSequence.join(',');
  let pattern = patternKeyOf.get(key);

  if (!pattern) {
    pattern = {
      stopSequence,
      routeType: routeTypeOf.get(activeTrips.get(tripId).routeId) ?? -1,
      trips: [],
    };
    patternKeyOf.set(key, pattern);
    patterns.push(pattern);
  }

  pattern.trips.push({
    arrivals: rows.map((row) => row.arrival),
    departures: rows.map((row) => row.departure),
  });
}

// Trips within one pattern are scanned by departure time from the first stop.
for (const pattern of patterns) {
  pattern.trips.sort((a, b) => a.departures[0] - b.departures[0]);
}

console.log('patterns (distinct stop sequences):', patterns.length);
const totalStopTimeEntries = patterns.reduce(
  (sum, pattern) => sum + pattern.trips.length * pattern.stopSequence.length,
  0,
);
console.log('stop-time entries retained:', totalStopTimeEntries);

// --- Transfers -------------------------------------------------------------
const transferKey = (from, to) => `${from}:${to}`;
const explicitTransferKeys = new Set();
const transfers = [];
await streamRows('transfers.txt', (row) => {
  const from = stopIndexOf.get(row.from_stop_id);
  const to = stopIndexOf.get(row.to_stop_id);
  if (from !== undefined && to !== undefined && from !== to) {
    transfers.push([from, to, Number(row.min_transfer_time) || 120]);
    explicitTransferKeys.add(transferKey(from, to));
  }
});
console.log('explicit transfers:', transfers.length);

// --- Walking-transfer fallback ----------------------------------------------
/**
 * `transfers.txt` only lists interchanges an agency bothered to declare —
 * 7,816 pairs nationally, a small fraction of the roughly 39,000 stops
 * actually used on a given day. A reader standing at one stop can still walk
 * to another platform, or across a square to a different agency's stop,
 * that nobody wrote a transfer record for. This fills that gap the same way
 * a reachability search itself would: a straight-line distance and a
 * pedestrian speed, not a claim about the actual pavement between them.
 */
const WALK_TRANSFER_MAX_METERS = 300;
const WALKING_SPEED_METERS_PER_SECOND = 1.2;
const MIN_TRANSFER_BUFFER_SECONDS = 60;
const GRID_CELL_METERS = WALK_TRANSFER_MAX_METERS;

const usedStopIndices = new Set();
for (const pattern of patterns) {
  for (const stopIndex of pattern.stopSequence) {
    usedStopIndices.add(stopIndex);
  }
}

const grid = new Map();
const cellKeyFor = (easting, northing) =>
  `${Math.floor(easting / GRID_CELL_METERS)}:${Math.floor(northing / GRID_CELL_METERS)}`;

for (const stopIndex of usedStopIndices) {
  const key = cellKeyFor(stopEastings[stopIndex], stopNorthings[stopIndex]);
  let bucket = grid.get(key);
  if (!bucket) {
    bucket = [];
    grid.set(key, bucket);
  }
  bucket.push(stopIndex);
}

let walkingTransfersAdded = 0;
for (const fromIndex of usedStopIndices) {
  const fromEasting = stopEastings[fromIndex];
  const fromNorthing = stopNorthings[fromIndex];
  const cellColumn = Math.floor(fromEasting / GRID_CELL_METERS);
  const cellRow = Math.floor(fromNorthing / GRID_CELL_METERS);

  for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
    for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
      const bucket = grid.get(`${cellColumn + columnOffset}:${cellRow + rowOffset}`);
      if (!bucket) {
        continue;
      }

      for (const toIndex of bucket) {
        if (toIndex === fromIndex || explicitTransferKeys.has(transferKey(fromIndex, toIndex))) {
          continue;
        }

        const deltaEasting = stopEastings[toIndex] - fromEasting;
        const deltaNorthing = stopNorthings[toIndex] - fromNorthing;
        const distance = Math.sqrt(deltaEasting ** 2 + deltaNorthing ** 2);

        if (distance <= WALK_TRANSFER_MAX_METERS) {
          const seconds =
            Math.round(distance / WALKING_SPEED_METERS_PER_SECOND) +
            MIN_TRANSFER_BUFFER_SECONDS;
          transfers.push([fromIndex, toIndex, seconds]);
          explicitTransferKeys.add(transferKey(fromIndex, toIndex));
          walkingTransfersAdded += 1;
        }
      }
    }
  }
}

console.log('walking transfers added:', walkingTransfersAdded);
console.log('transfers total:', transfers.length);

// --- Serialize: one binary blob for pattern stop-times, JSON for the rest -
mkdirSync(OUTPUT_DIR, { recursive: true });

// Binary layout per pattern, concatenated: for each trip, stopSequence.length
// pairs of (arrivalSec:uint32, departureSec:uint32). Offsets recorded in the
// JSON manifest so the reader can slice without a second pass.
const tripByteLengths = [];
let totalBytes = 0;
for (const pattern of patterns) {
  const stopsPerTrip = pattern.stopSequence.length;
  for (const trip of pattern.trips) {
    const bytes = stopsPerTrip * 8;
    tripByteLengths.push(bytes);
    totalBytes += bytes;
  }
}

const timesBuffer = new ArrayBuffer(totalBytes);
const timesView = new DataView(timesBuffer);
let byteOffset = 0;
const manifestPatterns = [];

for (const pattern of patterns) {
  const stopsPerTrip = pattern.stopSequence.length;
  const tripOffsets = [];

  for (const trip of pattern.trips) {
    tripOffsets.push(byteOffset);
    for (let stopIndex = 0; stopIndex < stopsPerTrip; stopIndex += 1) {
      timesView.setUint32(byteOffset, trip.arrivals[stopIndex]);
      timesView.setUint32(byteOffset + 4, trip.departures[stopIndex]);
      byteOffset += 8;
    }
  }

  manifestPatterns.push({
    stopSequence: pattern.stopSequence,
    routeType: pattern.routeType,
    tripByteOffsets: tripOffsets,
  });
}

writeFileSync(resolve(OUTPUT_DIR, 'stop-times.bin'), Buffer.from(timesBuffer));
writeFileSync(
  resolve(OUTPUT_DIR, 'manifest.json'),
  JSON.stringify({
    referenceDate,
    stopCount: stopNames.length,
    patterns: manifestPatterns,
    transfers,
  }),
);
writeFileSync(
  resolve(OUTPUT_DIR, 'stops.json'),
  JSON.stringify({
    names: stopNames,
    eastings: stopEastings,
    northings: stopNorthings,
    parents: stopParent,
  }),
);

console.log('stop-times.bin bytes:', totalBytes);
console.timeEnd('total');
