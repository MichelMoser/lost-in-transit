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

// --- Drop tiny disconnected islands -----------------------------------------
/**
 * Motorway/trunk-only data is not always one connected mesh: a short
 * segment whose real-world connections at *both* ends are to a road class
 * outside this graph's scope (ordinary streets, not fetched) becomes its
 * own tiny island — reachable from nowhere else in the graph, and reaching
 * nowhere else in turn. A reader whose click snaps to one gets a nonsense
 * "reached 2 junctions" result with no way to tell why. Union-Find over the
 * *undirected* edge set (connectivity is a physical-linkage question, not a
 * direction one) finds every such component.
 *
 * Checked the actual size distribution before picking a threshold — keeping
 * only the single largest component would have discarded 36 real, sizeable
 * regional networks (the second-largest alone has 4,842 nodes: a genuine
 * cluster, not an artifact, likely connected to the main mesh only through
 * a stretch classed below trunk grade that this snapshot doesn't carry).
 * The distribution has a sharp break instead: every real component has 19+
 * nodes, then a cliff straight to six components of 4 nodes or fewer —
 * unambiguous artifacts. `MIN_COMPONENT_NODES` sits in that gap.
 */
const MIN_COMPONENT_NODES = 10;

const parent = Int32Array.from({ length: nodeEastings.length }, (_unused, index) => index);
function find(index) {
  while (parent[index] !== index) {
    parent[index] = parent[parent[index]];
    index = parent[index];
  }
  return index;
}
function union(a, b) {
  const rootA = find(a);
  const rootB = find(b);
  if (rootA !== rootB) {
    parent[rootA] = rootB;
  }
}
for (let index = 0; index < edgeFrom.length; index += 1) {
  union(edgeFrom[index], edgeTo[index]);
}

const componentSize = new Map();
for (let nodeIndex = 0; nodeIndex < nodeEastings.length; nodeIndex += 1) {
  const root = find(nodeIndex);
  componentSize.set(root, (componentSize.get(root) ?? 0) + 1);
}

const keepOldIndex = [];
const newIndexOfOld = new Map();
for (let nodeIndex = 0; nodeIndex < nodeEastings.length; nodeIndex += 1) {
  const size = componentSize.get(find(nodeIndex)) ?? 0;
  if (size >= MIN_COMPONENT_NODES) {
    newIndexOfOld.set(nodeIndex, keepOldIndex.length);
    keepOldIndex.push(nodeIndex);
  }
}

const filteredEastings = keepOldIndex.map((oldIndex) => nodeEastings[oldIndex]);
const filteredNorthings = keepOldIndex.map((oldIndex) => nodeNorthings[oldIndex]);

const filteredEdgeFrom = [];
const filteredEdgeTo = [];
const filteredEdgeSeconds = [];
for (let index = 0; index < edgeFrom.length; index += 1) {
  const newFrom = newIndexOfOld.get(edgeFrom[index]);
  const newTo = newIndexOfOld.get(edgeTo[index]);
  if (newFrom !== undefined && newTo !== undefined) {
    filteredEdgeFrom.push(newFrom);
    filteredEdgeTo.push(newTo);
    filteredEdgeSeconds.push(edgeSeconds[index]);
  }
}

// --- Origin eligibility: which nodes make a sensible search start ----------
/**
 * Weak (undirected) connectivity, filtered above, answers "is this node
 * reachable at all" — the right question for whether to keep it as a
 * possible *destination*. It is the wrong question for the nearest-click
 * *origin* snap: a one-way motorway/trunk off-ramp (`highway=trunk_link`
 * etc.) that exits onto an ordinary street not in this graph is weakly
 * connected to the whole network (something can drive onto it), but has
 * nowhere further to go once there — found by testing an exact repro of a
 * reader's click landing on Bern's "Tiefenaustrasse" off-ramp and getting
 * "reached 2 junctions" back.
 *
 * The real question for an origin is directed forward reachability, which
 * Tarjan's strongly-connected-components algorithm answers cheaply: a node
 * inside a large SCC can both leave and return, meaning it sits on a real
 * mutually-navigable mesh, not a one-way stub. Same threshold-not-just-the-
 * largest reasoning as above — checked the actual size distribution and the
 * result barely moves between threshold 5 and 100 (61.7-61.8% of nodes kept
 * either way, a clean gap separates real sub-networks from singletons/ramps)
 * before picking 20.
 */
const MIN_ORIGIN_SCC_NODES = 20;

function findStronglyConnectedComponents(nodeCount, adjacency) {
  const order = new Int32Array(nodeCount).fill(-1);
  const lowlink = new Int32Array(nodeCount);
  const onStack = new Uint8Array(nodeCount);
  const componentOf = new Int32Array(nodeCount).fill(-1);
  let nextOrder = 0;
  let componentCount = 0;
  const sccStack = [];
  const callStack = []; // [node, nextChildEdgeIndex] — iterative to avoid a 150k-deep JS call stack

  for (let start = 0; start < nodeCount; start += 1) {
    if (order[start] !== -1) {
      continue;
    }
    callStack.push([start, 0]);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const node = frame[0];

      if (frame[1] === 0) {
        order[node] = nextOrder;
        lowlink[node] = nextOrder;
        nextOrder += 1;
        sccStack.push(node);
        onStack[node] = 1;
      }

      const neighbors = adjacency[node];
      if (frame[1] < neighbors.length) {
        const neighbor = neighbors[frame[1]];
        frame[1] += 1;
        if (order[neighbor] === -1) {
          callStack.push([neighbor, 0]);
        } else if (onStack[neighbor] && order[neighbor] < lowlink[node]) {
          lowlink[node] = order[neighbor];
        }
        continue;
      }

      callStack.pop();
      if (callStack.length > 0) {
        const parentFrame = callStack[callStack.length - 1];
        if (lowlink[node] < lowlink[parentFrame[0]]) {
          lowlink[parentFrame[0]] = lowlink[node];
        }
      }

      if (lowlink[node] === order[node]) {
        let member;
        do {
          member = sccStack.pop();
          onStack[member] = 0;
          componentOf[member] = componentCount;
        } while (member !== node);
        componentCount += 1;
      }
    }
  }

  return componentOf;
}

const adjacency = Array.from({ length: filteredEastings.length }, () => []);
for (let index = 0; index < filteredEdgeFrom.length; index += 1) {
  adjacency[filteredEdgeFrom[index]].push(filteredEdgeTo[index]);
}
const sccOf = findStronglyConnectedComponents(filteredEastings.length, adjacency);
const sccSize = new Map();
for (const component of sccOf) {
  sccSize.set(component, (sccSize.get(component) ?? 0) + 1);
}

const originEligible = new Uint8Array(filteredEastings.length);
let originEligibleCount = 0;
for (let nodeIndex = 0; nodeIndex < filteredEastings.length; nodeIndex += 1) {
  if ((sccSize.get(sccOf[nodeIndex]) ?? 0) >= MIN_ORIGIN_SCC_NODES) {
    originEligible[nodeIndex] = 1;
    originEligibleCount += 1;
  }
}

const droppedComponents = [...componentSize.values()].filter((size) => size < MIN_COMPONENT_NODES);
console.log(
  'connected components:', componentSize.size,
  `  dropped (< ${MIN_COMPONENT_NODES} nodes):`, droppedComponents.length,
  '  dropped nodes:', droppedComponents.reduce((sum, size) => sum + size, 0),
  '  dropped edges:', edgeFrom.length - filteredEdgeFrom.length,
);
console.log(
  'origin-eligible nodes (SCC >=', MIN_ORIGIN_SCC_NODES, 'nodes):', originEligibleCount,
  '  of', filteredEastings.length,
  `(${((100 * originEligibleCount) / filteredEastings.length).toFixed(1)}%)`,
);

// --- Serialize: binary edge list, JSON node coordinates ---------------------
mkdirSync(OUTPUT_DIR, { recursive: true });

const BYTES_PER_EDGE = 12; // uint32 from, uint32 to, float32 travelSeconds
const edgeBuffer = new ArrayBuffer(filteredEdgeFrom.length * BYTES_PER_EDGE);
const edgeView = new DataView(edgeBuffer);
for (let index = 0; index < filteredEdgeFrom.length; index += 1) {
  const byteOffset = index * BYTES_PER_EDGE;
  edgeView.setUint32(byteOffset, filteredEdgeFrom[index]);
  edgeView.setUint32(byteOffset + 4, filteredEdgeTo[index]);
  edgeView.setFloat32(byteOffset + 8, filteredEdgeSeconds[index]);
}

writeFileSync(resolve(OUTPUT_DIR, 'edges.bin'), Buffer.from(edgeBuffer));
writeFileSync(resolve(OUTPUT_DIR, 'origin-eligible.bin'), Buffer.from(originEligible.buffer));
writeFileSync(
  resolve(OUTPUT_DIR, 'nodes.json'),
  JSON.stringify({ eastings: filteredEastings, northings: filteredNorthings }),
);

console.log('nodes kept:', filteredEastings.length, '  edges.bin bytes:', edgeBuffer.byteLength);
console.timeEnd('total');
