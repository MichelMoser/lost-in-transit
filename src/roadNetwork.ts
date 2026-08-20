/**
 * Business context: the in-memory shape `build-road-network.mjs`'s output is
 * decoded into — a directed graph over Switzerland's motorway and trunk
 * network, the driving counterpart of `timetable.ts`. Coordinates share the
 * same EPSG:2056 space as the transit snapshot, so both modes draw on the
 * same map without a reprojection step.
 */

/** One directed hop along a road, from whichever node's own edge list holds it. */
export interface RoadEdge {
  toNodeIndex: number;
  travelSeconds: number;
}

/** The road network for one search to run over. */
export interface RoadNetwork {
  nodeEastings: Int32Array;
  nodeNorthings: Int32Array;
  /** Directed adjacency: `edgesFromNode[i]` is every edge leaving node `i`. */
  edgesFromNode: ReadonlyArray<ReadonlyArray<RoadEdge>>;
}

interface NodesFile {
  eastings: number[];
  northings: number[];
}

/**
 * Decodes `build-road-network.mjs`'s output into a queryable {@link RoadNetwork}.
 *
 * @param nodes - Parsed `nodes.json`.
 * @param edgesBuffer - Raw bytes of `edges.bin`: 12 bytes per directed edge
 *   (uint32 fromNodeIndex, uint32 toNodeIndex, float32 travelSeconds).
 * @returns A network ready for `findReachableRoadNodes`.
 */
export function loadRoadNetwork(nodes: NodesFile, edgesBuffer: ArrayBuffer): RoadNetwork {
  const nodeEastings = Int32Array.from(nodes.eastings);
  const nodeNorthings = Int32Array.from(nodes.northings);

  const edgesFromNode: RoadEdge[][] = Array.from({ length: nodeEastings.length }, () => []);

  const view = new DataView(edgesBuffer);
  const edgeCount = edgesBuffer.byteLength / 12;
  for (let index = 0; index < edgeCount; index += 1) {
    const byteOffset = index * 12;
    const fromNodeIndex = view.getUint32(byteOffset);
    const toNodeIndex = view.getUint32(byteOffset + 4);
    const travelSeconds = view.getFloat32(byteOffset + 8);
    edgesFromNode[fromNodeIndex]?.push({ toNodeIndex, travelSeconds });
  }

  return { nodeEastings, nodeNorthings, edgesFromNode };
}
