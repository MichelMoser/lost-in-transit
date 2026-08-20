import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(HERE, '../data/output');

const manifest = JSON.parse(readFileSync(resolve(OUTPUT_DIR, 'manifest.json'), 'utf8'));
const stops = JSON.parse(readFileSync(resolve(OUTPUT_DIR, 'stops.json'), 'utf8'));
const stopTimesBuffer = readFileSync(resolve(OUTPUT_DIR, 'stop-times.bin')).buffer;

// A platform/child stop, not the parent station: stops.txt gives the parent
// station itself no `parent_station`, and it carries no direct stop_times.
const originIndex = stops.names.findIndex(
  (name, index) => name === 'Bern' && stops.parents[index] !== '',
);
console.log('origin stop:', stops.names[originIndex], 'at index', originIndex);

const { loadTimetable } = await import('../src/timetable.ts');
const { findReachableStops } = await import('../src/raptor.ts');

console.time('load');
const timetable = loadTimetable(manifest, stops, stopTimesBuffer);
console.timeEnd('load');

console.time('search');
// Depart 08:00, budget 60 minutes.
const result = findReachableStops(timetable, originIndex, 8 * 3600, 60 * 60);
console.timeEnd('search');

console.log('reachable stops within 60 min of', stops.names[originIndex], ':', result.stops.length);
console.log('legs drawn:', result.legs.length);

const byMode = new Map();
for (const leg of result.legs) {
  byMode.set(leg.mode, (byMode.get(leg.mode) ?? 0) + 1);
}
console.log('legs by mode:', Object.fromEntries(byMode));

const sample = result.stops
  .slice()
  .sort((a, b) => a.arrivalSeconds - b.arrivalSeconds)
  .slice(0, 10)
  .map((stop) => ({
    name: stops.names[stop.stopIndex],
    arrival: new Date(stop.arrivalSeconds * 1000).toISOString().slice(11, 19),
    transitLegs: stop.transitLegs,
  }));
console.log('10 earliest-arriving destinations:', sample);

const farthest = result.stops
  .slice()
  .sort((a, b) => b.arrivalSeconds - a.arrivalSeconds)
  .slice(0, 5)
  .map((stop) => ({
    name: stops.names[stop.stopIndex],
    arrival: new Date(stop.arrivalSeconds * 1000).toISOString().slice(11, 19),
    transitLegs: stop.transitLegs,
  }));
console.log('5 latest-arriving (farthest) destinations:', farthest);
