/**
 * Business context: the in-memory shape `build-road-network.mjs`'s output is
 * decoded into — a directed graph over every drivable OSM street in
 * Switzerland, the driving counterpart of `timetable.ts`. Coordinates share
 * the same EPSG:2056 space as the transit snapshot, so both modes draw on
 * the same map without a reprojection step.
 *
 * At national-street scale (millions of nodes and edges) the graph is
 * stored as CSR (compressed sparse row): flat typed arrays rather than an
 * array of per-node edge-object arrays, which at this size would mean
 * hundreds of MB of small JS objects and array shells in the browser.
 * `edgeOffset[i] .. edgeOffset[i + 1]` is the slice of `edgeToNode` /
 * `edgeTravelSeconds` holding node `i`'s own outgoing edges, built from
 * `edges.bin` already sorted by source node — see `edgesFrom` below for the
 * usual way to read one node's edges.
 */

/** The road network for one search to run over. */
export interface RoadNetwork {
  nodeEastings: Int32Array;
  nodeNorthings: Int32Array;
  /** CSR row pointers, length `nodeCount + 1`. */
  edgeOffset: Uint32Array;
  /** Parallel to `edgeTravelSeconds`; the far end of each edge. */
  edgeToNode: Uint32Array;
  edgeTravelSeconds: Float32Array;
  /**
   * Whether node `i` sits in a large enough strongly-connected component to
   * make a sensible search origin — 1 if so, 0 otherwise. A plain
   * "has at least one outgoing edge" check is not enough: a one-way
   * off-ramp or cul-de-sac has an outgoing edge or two and then nowhere
   * further to go, which a nearest-click origin snap should route around
   * rather than land on. See `build-road-network.mjs` for how this is
   * computed.
   */
  originEligible: Uint8Array;
}

/** One node's outgoing-edge range within the CSR arrays — see `edgesFrom`. */
export interface RoadEdgeRange {
  start: number;
  end: number;
}

/**
 * The half-open range `[start, end)` into `network.edgeToNode` /
 * `network.edgeTravelSeconds` holding `nodeIndex`'s own outgoing edges.
 * Iterate with a plain indexed loop rather than allocating an array —
 * this runs once per settled node in every Dijkstra step.
 */
export function edgesFrom(network: RoadNetwork, nodeIndex: number): RoadEdgeRange {
  return { start: network.edgeOffset[nodeIndex] ?? 0, end: network.edgeOffset[nodeIndex + 1] ?? 0 };
}

/**
 * Decodes `build-road-network.mjs`'s output into a queryable {@link RoadNetwork}.
 *
 * @param nodesBuffer - Raw bytes of `nodes.bin`: 8 bytes per node
 *   (int32 easting, int32 northing).
 * @param edgesBuffer - Raw bytes of `edges.bin`, sorted by source node: 8
 *   bytes per directed edge (uint32 toNodeIndex, float32 travelSeconds).
 * @param edgeOffsetsBuffer - Raw bytes of `edge-offsets.bin`: `nodeCount + 1`
 *   uint32 CSR row pointers.
 * @param originEligibleBuffer - Raw bytes of `origin-eligible.bin`: one byte
 *   per node, 1 or 0.
 * @returns A network ready for `findReachableRoadNodes`.
 */
export function loadRoadNetwork(
  nodesBuffer: ArrayBuffer,
  edgesBuffer: ArrayBuffer,
  edgeOffsetsBuffer: ArrayBuffer,
  originEligibleBuffer: ArrayBuffer,
): RoadNetwork {
  const nodeCount = nodesBuffer.byteLength / 8;
  const nodeEastings = new Int32Array(nodeCount);
  const nodeNorthings = new Int32Array(nodeCount);
  const nodeView = new DataView(nodesBuffer);
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    nodeEastings[nodeIndex] = nodeView.getInt32(nodeIndex * 8);
    nodeNorthings[nodeIndex] = nodeView.getInt32(nodeIndex * 8 + 4);
  }

  const edgeCount = edgesBuffer.byteLength / 8;
  const edgeToNode = new Uint32Array(edgeCount);
  const edgeTravelSeconds = new Float32Array(edgeCount);
  const edgeView = new DataView(edgesBuffer);
  for (let index = 0; index < edgeCount; index += 1) {
    edgeToNode[index] = edgeView.getUint32(index * 8);
    edgeTravelSeconds[index] = edgeView.getFloat32(index * 8 + 4);
  }

  return {
    nodeEastings,
    nodeNorthings,
    edgeOffset: new Uint32Array(edgeOffsetsBuffer),
    edgeToNode,
    edgeTravelSeconds,
    originEligible: new Uint8Array(originEligibleBuffer),
  };
}
