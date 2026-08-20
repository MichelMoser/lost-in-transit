/**
 * Business context: answers "everywhere reachable by car from one road
 * junction, within this time budget" — the driving counterpart of
 * `raptor.ts`. There is no timetable to round through here, so a plain
 * Dijkstra search over the motorway/trunk graph is the right tool: one
 * priority queue, expanding the closest unsettled node each step, stopping
 * once nothing left in the queue can still beat the budget.
 */
import type { RoadNetwork } from './roadNetwork';

/** One road junction the search reached, and when. */
export interface ReachableRoadNode {
  nodeIndex: number;
  /** Seconds since the search's own start. */
  arrivalSeconds: number;
}

/** One directed hop drawn on the map — the edge of the shortest-path tree leading to `toNodeIndex`. */
export interface ReachableRoadEdge {
  fromNodeIndex: number;
  toNodeIndex: number;
}

/** Result of one driving reachability search. */
export interface CarReachability {
  originNodeIndex: number;
  budgetSeconds: number;
  nodes: ReachableRoadNode[];
  edges: ReachableRoadEdge[];
}

/** Binary min-heap keyed by arrival time — the priority queue Dijkstra pops from. */
class MinHeap {
  private readonly nodeIndices: number[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.nodeIndices.length;
  }

  push(nodeIndex: number, priority: number): void {
    this.nodeIndices.push(nodeIndex);
    this.priorities.push(priority);
    this.bubbleUp(this.nodeIndices.length - 1);
  }

  /** Removes and returns the lowest-priority entry. Only valid when `size > 0`. */
  pop(): { nodeIndex: number; priority: number } {
    const topNodeIndex = this.nodeIndices[0] as number;
    const topPriority = this.priorities[0] as number;

    const lastNodeIndex = this.nodeIndices.pop() as number;
    const lastPriority = this.priorities.pop() as number;

    if (this.nodeIndices.length > 0) {
      this.nodeIndices[0] = lastNodeIndex;
      this.priorities[0] = lastPriority;
      this.bubbleDown(0);
    }

    return { nodeIndex: topNodeIndex, priority: topPriority };
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      if ((this.priorities[parent] as number) <= (this.priorities[current] as number)) {
        break;
      }
      this.swap(parent, current);
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    const length = this.nodeIndices.length;
    for (;;) {
      const left = current * 2 + 1;
      const right = current * 2 + 2;
      let smallest = current;

      if (left < length && (this.priorities[left] as number) < (this.priorities[smallest] as number)) {
        smallest = left;
      }
      if (right < length && (this.priorities[right] as number) < (this.priorities[smallest] as number)) {
        smallest = right;
      }
      if (smallest === current) {
        break;
      }
      this.swap(smallest, current);
      current = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const nodeIndexA = this.nodeIndices[a] as number;
    const priorityA = this.priorities[a] as number;
    this.nodeIndices[a] = this.nodeIndices[b] as number;
    this.priorities[a] = this.priorities[b] as number;
    this.nodeIndices[b] = nodeIndexA;
    this.priorities[b] = priorityA;
  }
}

/**
 * Runs one Dijkstra search from a single origin road node.
 *
 * @param network - Snapshot loaded by `loadRoadNetwork`.
 * @param originNodeIndex - Where the drive starts.
 * @param budgetSeconds - How long the driver is willing to travel.
 * @returns Every junction reached within budget, and the shortest-path
 *   tree's edges (one incoming edge per reached node, for drawing).
 */
export function findReachableRoadNodes(
  network: RoadNetwork,
  originNodeIndex: number,
  budgetSeconds: number,
): CarReachability {
  const nodeCount = network.nodeEastings.length;
  const bestArrival = new Float64Array(nodeCount).fill(Infinity);
  const cameFrom = new Int32Array(nodeCount).fill(-1);
  bestArrival[originNodeIndex] = 0;

  const heap = new MinHeap();
  heap.push(originNodeIndex, 0);

  while (heap.size > 0) {
    const { nodeIndex, priority: arrivalSeconds } = heap.pop();

    // Stale queue entry: a shorter path to this node was already settled.
    if (arrivalSeconds > (bestArrival[nodeIndex] ?? Infinity)) {
      continue;
    }

    for (const edge of network.edgesFromNode[nodeIndex] ?? []) {
      const candidate = arrivalSeconds + edge.travelSeconds;
      if (candidate > budgetSeconds) {
        continue;
      }

      if (candidate < (bestArrival[edge.toNodeIndex] ?? Infinity)) {
        bestArrival[edge.toNodeIndex] = candidate;
        cameFrom[edge.toNodeIndex] = nodeIndex;
        heap.push(edge.toNodeIndex, candidate);
      }
    }
  }

  const nodes: ReachableRoadNode[] = [];
  const edges: ReachableRoadEdge[] = [];

  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    const arrivalSeconds = bestArrival[nodeIndex] ?? Infinity;
    if (arrivalSeconds === Infinity) {
      continue;
    }

    nodes.push({ nodeIndex, arrivalSeconds });

    const fromNodeIndex = cameFrom[nodeIndex] ?? -1;
    if (fromNodeIndex >= 0) {
      edges.push({ fromNodeIndex, toNodeIndex: nodeIndex });
    }
  }

  return { originNodeIndex, budgetSeconds, nodes, edges };
}
