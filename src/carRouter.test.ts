import { describe, expect, it } from 'vitest';
import { findReachableRoadNodes } from './carRouter';
import type { RoadNetwork } from './roadNetwork';

/** Assembles a {@link RoadNetwork} (CSR form) from a list of directed edges alone. */
function buildTestNetwork(
  nodeCount: number,
  edges: [from: number, to: number, seconds: number][],
): RoadNetwork {
  // Group by `from` node, same as build-road-network.mjs's own sort, so the
  // CSR offsets below line up with edgeToNode/edgeTravelSeconds.
  const sorted = [...edges].sort((a, b) => a[0] - b[0]);

  const edgeOffset = new Uint32Array(nodeCount + 1);
  const edgeToNode = new Uint32Array(sorted.length);
  const edgeTravelSeconds = new Float32Array(sorted.length);
  for (let index = 0; index < sorted.length; index += 1) {
    const [from, to, seconds] = sorted[index] as [number, number, number];
    edgeToNode[index] = to;
    edgeTravelSeconds[index] = seconds;
    (edgeOffset[from + 1] as number) += 1;
  }
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    (edgeOffset[nodeIndex + 1] as number) += edgeOffset[nodeIndex] as number;
  }

  return {
    nodeEastings: new Int32Array(nodeCount),
    nodeNorthings: new Int32Array(nodeCount),
    edgeOffset,
    edgeToNode,
    edgeTravelSeconds,
    // Unused by findReachableRoadNodes itself — only the nearest-node snap
    // in the viewer reads this — so a filler value is fine here.
    originEligible: new Uint8Array(nodeCount),
  };
}

describe('findReachableRoadNodes', () => {
  it('reaches every node within budget along the shortest path, stopping at the horizon', () => {
    // 0 --100s--> 1 --100s--> 2 --100s--> 3
    const network = buildTestNetwork(4, [
      [0, 1, 100],
      [1, 2, 100],
      [2, 3, 100],
    ]);

    const result = findReachableRoadNodes(network, 0, 250);

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        { nodeIndex: 0, arrivalSeconds: 0 },
        { nodeIndex: 1, arrivalSeconds: 100 },
        { nodeIndex: 2, arrivalSeconds: 200 },
      ]),
    );
    expect(result.nodes.some((node) => node.nodeIndex === 3)).toBe(false);
  });

  it('takes the shorter of two paths to the same node', () => {
    //      -- 100s --
    //     /           \
    // 0 -+             +-> 2
    //     \           /
    //      -- 10s --> 1 -- 10s -->
    const network = buildTestNetwork(3, [
      [0, 2, 100],
      [0, 1, 10],
      [1, 2, 10],
    ]);

    const result = findReachableRoadNodes(network, 0, 1000);

    const node2 = result.nodes.find((node) => node.nodeIndex === 2);
    expect(node2?.arrivalSeconds).toBe(20);
    expect(result.edges).toContainEqual({ fromNodeIndex: 1, toNodeIndex: 2 });
    expect(result.edges).not.toContainEqual({ fromNodeIndex: 0, toNodeIndex: 2 });
  });

  it('never reaches a node only connected the wrong way down a one-way edge', () => {
    const network = buildTestNetwork(2, [[0, 1, 50]]); // no reverse edge
    const result = findReachableRoadNodes(network, 1, 1000);

    expect(result.nodes).toEqual([{ nodeIndex: 1, arrivalSeconds: 0 }]);
  });

  it('reports the origin itself with zero elapsed time and no incoming edge', () => {
    const network = buildTestNetwork(2, [[0, 1, 50]]);
    const result = findReachableRoadNodes(network, 0, 1000);

    expect(result.nodes).toContainEqual({ nodeIndex: 0, arrivalSeconds: 0 });
    expect(result.edges.some((edge) => edge.toNodeIndex === 0)).toBe(false);
  });

  it('getRouteTo returns the full ordered route, the origin as empty, and null for unreached nodes', () => {
    const network = buildTestNetwork(4, [
      [0, 1, 100],
      [1, 2, 100],
      [2, 3, 100],
    ]);

    const result = findReachableRoadNodes(network, 0, 250);

    expect(result.getRouteTo(0)).toEqual([]);
    expect(result.getRouteTo(2)).toEqual([
      { fromNodeIndex: 0, toNodeIndex: 1, travelSeconds: 100 },
      { fromNodeIndex: 1, toNodeIndex: 2, travelSeconds: 100 },
    ]);
    expect(result.getRouteTo(3)).toBeNull(); // outside the 250s budget
  });
});
