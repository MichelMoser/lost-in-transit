import { describe, expect, it } from 'vitest';
import { findReachableRoadNodes } from './carRouter';
import type { RoadNetwork } from './roadNetwork';

/** Assembles a {@link RoadNetwork} from a list of directed edges alone. */
function buildTestNetwork(
  nodeCount: number,
  edges: [from: number, to: number, seconds: number][],
): RoadNetwork {
  const edgesFromNode: { toNodeIndex: number; travelSeconds: number }[][] = Array.from(
    { length: nodeCount },
    () => [],
  );
  for (const [from, to, seconds] of edges) {
    edgesFromNode[from]?.push({ toNodeIndex: to, travelSeconds: seconds });
  }

  return {
    nodeEastings: new Int32Array(nodeCount),
    nodeNorthings: new Int32Array(nodeCount),
    edgesFromNode,
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
});
