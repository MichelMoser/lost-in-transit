/**
 * Business context: turns Switzerland's motorway + trunk road network (the
 * "autoroute"/"Autobahn" and "Autostrasse"/expressway tiers, fetched from
 * OpenStreetMap via Overpass) into a compact directed graph a browser can
 * run Dijkstra over — the driving counterpart of build-snapshot.mjs's
 * transit patterns.
 *
 * Scope is deliberately limited to the two highest road classes rather than
 * every street: a full national street graph is millions of edges, too
 * large for a client-side snapshot with no backend, and "using autoroutes"
 * was the brief. The isochrone this produces reads as "how far the
 * motorway/expressway network reaches," widened by a flat local-road buffer
 * around each reached junction (see viewer/src/isochrone.ts) rather than a
 * house-to-house result — a documented approximation, not a bug.
 *
 * Usage: `node build-road-network.mjs` — reads the cached Overpass export at
 * data/osm-roads-switzerland.json. To refresh that export:
 *
 *   curl -s --data-urlencode "data@query.txt" \
 *     https://overpass-api.de/api/interpreter -o data/osm-roads-switzerland.json
 *
 * where query.txt is:
 *   [out:json][timeout:180];
 *   area["ISO3166-1"="CH"][admin_level=2]->.ch;
 *   (way["highway"~"^(motorway|motorway_link|trunk|trunk_link)$"](area.ch););
 *   out body;
 *   >;
 *   out skel qt;
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { wgs84ToLv95 } from './lib/geo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = resolve(HERE, '../data/osm-roads-switzerland.json');
const OUTPUT_DIR = resolve(HERE, '../data/output/road-network');

console.log('Building road network snapshot');
console.time('total');

const raw = JSON.parse(readFileSync(INPUT_FILE, 'utf8'));

const nodeLatLonById = new Map();
const ways = [];
for (const element of raw.elements) {
  if (element.type === 'node') {
    nodeLatLonById.set(element.id, [element.lat, element.lon]);
  } else if (element.type === 'way') {
    ways.push(element);
  }
}
console.log('nodes in feed:', nodeLatLonById.size, '  ways in feed:', ways.length);

// --- Dense node index, LV95 coordinates, only for nodes any way actually uses ---
const nodeIndexOf = new Map();
const nodeEastings = [];
const nodeNorthings = [];

function indexOf(osmNodeId) {
  const existing = nodeIndexOf.get(osmNodeId);
  if (existing !== undefined) {
    return existing;
  }

  const [lat, lon] = nodeLatLonById.get(osmNodeId);
  const [easting, northing] = wgs84ToLv95(lat, lon);
  const index = nodeEastings.length;
  nodeIndexOf.set(osmNodeId, index);
  nodeEastings.push(easting);
  nodeNorthings.push(northing);
  return index;
}

// --- Speed per class, legal-limit approximation (no traffic modelling) -----
const DEFAULT_SPEED_KMH = {
  motorway: 120,
  motorway_link: 40,
  trunk: 80,
  trunk_link: 50,
};

function speedKmhFor(tags) {
  const tagged = Number(tags.maxspeed);
  if (Number.isFinite(tagged) && tagged > 0) {
    return tagged;
  }
  return DEFAULT_SPEED_KMH[tags.highway] ?? 50;
}

/**
 * OSM tagging convention: a motorway's two carriageways are almost always
 * mapped as separate one-way ways even when nobody bothered to add the
 * `oneway` tag itself; other classes default to two-way absent a tag.
 * Returns 1 (forward only), -1 (reverse only), or 0 (both directions).
 */
function directionOf(tags) {
  if (tags.oneway === 'yes') return 1;
  if (tags.oneway === '-1') return -1;
  if (tags.oneway === 'no') return 0;
  return tags.highway === 'motorway' || tags.highway === 'motorway_link' ? 1 : 0;
}

// --- Edges: directed, one per consecutive node pair per way ----------------
const edgeFrom = [];
const edgeTo = [];
const edgeSeconds = [];
let skippedDanglingRef = 0;
let skippedZeroLength = 0;

for (const way of ways) {
  const speedMetersPerSecond = (speedKmhFor(way.tags) * 1000) / 3600;
  const direction = directionOf(way.tags);

  for (let position = 0; position < way.nodes.length - 1; position += 1) {
    const fromOsmId = way.nodes[position];
    const toOsmId = way.nodes[position + 1];

    if (!nodeLatLonById.has(fromOsmId) || !nodeLatLonById.has(toOsmId)) {
      skippedDanglingRef += 1;
      continue;
    }

    const fromIndex = indexOf(fromOsmId);
    const toIndex = indexOf(toOsmId);
    const deltaEasting = nodeEastings[toIndex] - nodeEastings[fromIndex];
    const deltaNorthing = nodeNorthings[toIndex] - nodeNorthings[fromIndex];
    const distanceMeters = Math.sqrt(deltaEasting ** 2 + deltaNorthing ** 2);

    if (distanceMeters === 0) {
      skippedZeroLength += 1;
      continue;
    }

    const travelSeconds = distanceMeters / speedMetersPerSecond;

    if (direction >= 0) {
      edgeFrom.push(fromIndex);
      edgeTo.push(toIndex);
      edgeSeconds.push(travelSeconds);
    }
    if (direction <= 0) {
      edgeFrom.push(toIndex);
      edgeTo.push(fromIndex);
      edgeSeconds.push(travelSeconds);
    }
  }
}

console.log('nodes used:', nodeEastings.length);
console.log('directed edges:', edgeFrom.length);
console.log('way segments skipped (dangling node ref):', skippedDanglingRef);
console.log('way segments skipped (zero length):', skippedZeroLength);

// --- Serialize: binary edge list, JSON node coordinates ---------------------
mkdirSync(OUTPUT_DIR, { recursive: true });

const BYTES_PER_EDGE = 12; // uint32 from, uint32 to, float32 travelSeconds
const edgeBuffer = new ArrayBuffer(edgeFrom.length * BYTES_PER_EDGE);
const edgeView = new DataView(edgeBuffer);
for (let index = 0; index < edgeFrom.length; index += 1) {
  const byteOffset = index * BYTES_PER_EDGE;
  edgeView.setUint32(byteOffset, edgeFrom[index]);
  edgeView.setUint32(byteOffset + 4, edgeTo[index]);
  edgeView.setFloat32(byteOffset + 8, edgeSeconds[index]);
}

writeFileSync(resolve(OUTPUT_DIR, 'edges.bin'), Buffer.from(edgeBuffer));
writeFileSync(
  resolve(OUTPUT_DIR, 'nodes.json'),
  JSON.stringify({ eastings: nodeEastings, northings: nodeNorthings }),
);

console.log('edges.bin bytes:', edgeBuffer.byteLength);
console.timeEnd('total');
