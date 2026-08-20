import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const DIR = 'extracted';
const REFERENCE_DATE = '20260819';

function streamLines(file, onLine) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(`${DIR}/${file}`),
      crlfDelay: Infinity,
    });
    let header = null;
    rl.on('line', (line) => {
      if (!header) {
        header = line.split(',');
        return;
      }
      onLine(line, header);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// Minimal CSV split good enough for this feed (no embedded commas observed in sampled fields).
function splitCsv(line) {
  return line.split(',');
}

console.time('total');

const activeServiceIds = new Set();
await streamLines('calendar_dates.txt', (line) => {
  const [serviceId, date, exceptionType] = splitCsv(line);
  if (date === REFERENCE_DATE && exceptionType === '1') {
    activeServiceIds.add(serviceId);
  }
});
console.log('active service_ids for', REFERENCE_DATE, ':', activeServiceIds.size);

const activeTripIds = new Set();
const tripRouteOf = new Map();
await streamLines('trips.txt', (line, header) => {
  const cols = splitCsv(line);
  const routeId = cols[header.indexOf('route_id')];
  const serviceId = cols[header.indexOf('service_id')];
  const tripId = cols[header.indexOf('trip_id')];
  if (activeServiceIds.has(serviceId)) {
    activeTripIds.add(tripId);
    tripRouteOf.set(tripId, routeId);
  }
});
console.log('active trips on', REFERENCE_DATE, ':', activeTripIds.size);

let stopTimesRows = 0;
let matchedStopTimesRows = 0;
const stopIdsUsed = new Set();
await streamLines('stop_times.txt', (line, header) => {
  stopTimesRows += 1;
  const cols = splitCsv(line);
  const tripId = cols[header.indexOf('trip_id')];
  if (activeTripIds.has(tripId)) {
    matchedStopTimesRows += 1;
    stopIdsUsed.add(cols[header.indexOf('stop_id')]);
  }
});
console.log('total stop_times rows scanned:', stopTimesRows);
console.log('stop_times rows for active trips:', matchedStopTimesRows);
console.log('distinct stops used by active trips:', stopIdsUsed.size);

const routeTypeOf = new Map();
await streamLines('routes.txt', (line, header) => {
  const cols = splitCsv(line);
  routeTypeOf.set(cols[header.indexOf('route_id')], cols[header.indexOf('route_type')]);
});

const modeCounts = new Map();
for (const tripId of activeTripIds) {
  const routeId = tripRouteOf.get(tripId);
  const type = routeTypeOf.get(routeId) ?? 'unknown';
  modeCounts.set(type, (modeCounts.get(type) ?? 0) + 1);
}
console.log('active trips by route_type:', Object.fromEntries(modeCounts));

console.timeEnd('total');
