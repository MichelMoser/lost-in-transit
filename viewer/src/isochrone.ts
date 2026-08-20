/**
 * Business context: turns a reachability result — transit or driving — into
 * the filled-area view isochrone.ch shows, rather than the line network
 * `main.ts` draws on its own. Neither mode's isochrone is the network's own
 * shape: it is the union of a small catchment circle around every reached
 * point, sized to whatever budget is left after arriving there. A point
 * reached with the whole budget still spare (the origin itself) casts a wide
 * circle; one reached in the trip's last minute casts almost none.
 *
 * For transit, that catchment is a walk from the stop. For driving, the
 * network is deliberately limited to the motorway/trunk grade (see
 * `build-road-network.mjs`) — the catchment stands in for "the local roads
 * around this junction that aren't in the graph," at a flat estimated speed
 * rather than a real street network.
 *
 * Computed as a hex grid rather than one circle per point so overlapping
 * catchments merge into one shape and so every cell can report the single
 * best (earliest) arrival time reaching it, whichever point that came from.
 */
import type { TransitReachability } from '../../src/raptor';
import type { Timetable } from '../../src/timetable';
import type { CarReachability } from '../../src/carRouter';
import type { RoadNetwork } from '../../src/roadNetwork';

/** Typical pedestrian speed used to size a transit stop's own walking catchment. */
const WALKING_SPEED_METERS_PER_SECOND = 1.2;

/**
 * Flat stand-in for "local roads not in the motorway/trunk graph," sizing
 * how far a reached junction's own catchment reaches. Not a real street
 * network — a documented approximation, see the module comment above.
 */
const LOCAL_ROAD_SPEED_METERS_PER_SECOND = 13.9; // 50 km/h

/**
 * Ceiling on how much of the remaining budget turns into a driving
 * junction's own catchment radius, regardless of how much budget is
 * actually left. Without this, a junction reached in the search's first few
 * seconds — there are routinely hundreds of these, immediately around the
 * origin — would each splat a catchment sized off nearly the *entire*
 * budget (tens of kilometres), which is both wildly slow (hundreds of
 * near-duplicate giant splats) and not a believable "local road detour"
 * anyway: nobody leaves the motorway for a 50 km errand on back roads. 15
 * minutes of local driving is a believable detour and keeps every splat
 * cheap.
 */
const CAR_CATCHMENT_CAP_SECONDS = 900;

/** One coloured cell of the isochrone, ready to draw. */
export interface IsochroneHex {
  /** Corner coordinates, closed (first point repeated last). */
  ring: [number, number][];
  /** Seconds since the search's own start that this cell is reached by. */
  elapsedSeconds: number;
}

/** Centre-to-corner size of one hexagon, in metres. Finer reads smoother, costs more to compute. */
const HEX_SIZE_METERS = 180;

const SQRT_3 = Math.sqrt(3);

function hexCenter(q: number, r: number): [number, number] {
  return [
    HEX_SIZE_METERS * SQRT_3 * (q + r / 2),
    HEX_SIZE_METERS * 1.5 * r,
  ];
}

function hexCorners(centerX: number, centerY: number): [number, number][] {
  const corners: [number, number][] = [];
  for (let index = 0; index <= 6; index += 1) {
    // Pointy-top orientation, matching the axial layout `hexCenter` uses.
    const angle = (Math.PI / 180) * (60 * index - 30);
    corners.push([
      centerX + HEX_SIZE_METERS * Math.cos(angle),
      centerY + HEX_SIZE_METERS * Math.sin(angle),
    ]);
  }
  return corners;
}

interface IsochroneSource {
  x: number;
  y: number;
  /** Seconds since the search's own start (not since midnight). */
  elapsedAtArrival: number;
}

/**
 * Builds the isochrone as a hex grid, one earliest-arrival value per cell.
 *
 * Each reached point "splats" onto only the cells within its own catchment
 * radius rather than every cell testing every point, so a search covering a
 * whole city costs work proportional to the ground actually covered, not to
 * (points × cells).
 *
 * @param originX - Origin easting, in EPSG:2056 metres — the local
 *   coordinate system every hex is centred on.
 * @param originY - Origin northing.
 * @param budgetSeconds - The search's own time budget.
 * @param sources - Every reached point, with elapsed time since the search
 *   started (the origin itself included, with `elapsedAtArrival: 0`).
 * @param catchmentSpeedMetersPerSecond - How fast the leftover budget at
 *   each point turns into a catchment radius.
 * @param maxCatchmentSeconds - Caps how much leftover budget counts toward
 *   one point's own radius, so a handful of points reached with almost the
 *   whole budget still spare do not each splat a huge circle (transit has
 *   few enough reached stops that this never matters; the road network's
 *   dense node graph needs it, see `computeCarIsochroneHexagons`).
 * @returns One hex per covered cell, coloured by elapsed time in the caller.
 */
function computeHexagons(
  originX: number,
  originY: number,
  budgetSeconds: number,
  sources: IsochroneSource[],
  catchmentSpeedMetersPerSecond: number,
  maxCatchmentSeconds: number = Infinity,
): IsochroneHex[] {
  const bestArrivalByHexKey = new Map<string, number>();

  for (const source of sources) {
    const remainingSeconds = Math.min(
      budgetSeconds - source.elapsedAtArrival,
      maxCatchmentSeconds,
    );
    if (remainingSeconds <= 0) {
      continue;
    }

    const radius = remainingSeconds * catchmentSpeedMetersPerSecond;

    // Axial range wide enough to cover a square bounding the circle; the
    // per-cell distance check below discards the corners of that square.
    const rSpan = Math.ceil(radius / (HEX_SIZE_METERS * 1.5)) + 1;
    const qSpan = Math.ceil(radius / (HEX_SIZE_METERS * SQRT_3)) + 1;
    const [centerQApprox, centerRApprox] = pixelToApproximateAxial(
      source.x - originX,
      source.y - originY,
    );

    for (let r = centerRApprox - rSpan; r <= centerRApprox + rSpan; r += 1) {
      for (let q = centerQApprox - qSpan; q <= centerQApprox + qSpan; q += 1) {
        const [localX, localY] = hexCenter(q, r);
        const cellX = localX + originX;
        const cellY = localY + originY;
        const deltaX = cellX - source.x;
        const deltaY = cellY - source.y;
        const distance = Math.sqrt(deltaX ** 2 + deltaY ** 2);

        if (distance > radius) {
          continue;
        }

        const candidateElapsed =
          source.elapsedAtArrival + distance / catchmentSpeedMetersPerSecond;
        const key = `${q}:${r}`;
        const existing = bestArrivalByHexKey.get(key);

        if (existing === undefined || candidateElapsed < existing) {
          bestArrivalByHexKey.set(key, candidateElapsed);
        }
      }
    }
  }

  const hexes: IsochroneHex[] = [];
  for (const [key, elapsedSeconds] of bestArrivalByHexKey) {
    const [qText, rText] = key.split(':');
    const q = Number(qText);
    const r = Number(rText);
    const [localX, localY] = hexCenter(q, r);
    hexes.push({
      ring: hexCorners(localX + originX, localY + originY),
      elapsedSeconds,
    });
  }

  return hexes;
}

/** Isochrone for one RAPTOR (transit) search — see `computeHexagons`. */
export function computeTransitIsochroneHexagons(
  timetable: Timetable,
  result: TransitReachability,
): IsochroneHex[] {
  const originX = timetable.stopEastings[result.originStopIndex] ?? 0;
  const originY = timetable.stopNorthings[result.originStopIndex] ?? 0;

  const sources: IsochroneSource[] = [
    { x: originX, y: originY, elapsedAtArrival: 0 },
    ...result.stops.map((stop) => ({
      x: timetable.stopEastings[stop.stopIndex] ?? 0,
      y: timetable.stopNorthings[stop.stopIndex] ?? 0,
      elapsedAtArrival: stop.arrivalSeconds - result.departureSeconds,
    })),
  ];

  return computeHexagons(originX, originY, result.budgetSeconds, sources, WALKING_SPEED_METERS_PER_SECOND);
}

/** Isochrone for one Dijkstra (driving) search — see `computeHexagons`. */
export function computeCarIsochroneHexagons(
  network: RoadNetwork,
  result: CarReachability,
): IsochroneHex[] {
  const originX = network.nodeEastings[result.originNodeIndex] ?? 0;
  const originY = network.nodeNorthings[result.originNodeIndex] ?? 0;

  // The road graph reaches far more discrete nodes than transit reaches
  // stops — one source per node would be hundreds of thousands of
  // near-duplicate splats (neighbouring nodes along the same carriageway
  // are often metres apart). Bucketing onto the same hex grid the isochrone
  // itself draws first, keeping only the earliest arrival per cell, caps the
  // splat count at the network's own footprint rather than its node count.
  const earliestByHexKey = new Map<string, IsochroneSource>();
  for (const node of result.nodes) {
    const x = network.nodeEastings[node.nodeIndex] ?? 0;
    const y = network.nodeNorthings[node.nodeIndex] ?? 0;
    const [q, r] = pixelToApproximateAxial(x - originX, y - originY);
    const key = `${q}:${r}`;
    const existing = earliestByHexKey.get(key);
    if (!existing || node.arrivalSeconds < existing.elapsedAtArrival) {
      earliestByHexKey.set(key, { x, y, elapsedAtArrival: node.arrivalSeconds });
    }
  }

  return computeHexagons(
    originX,
    originY,
    result.budgetSeconds,
    [...earliestByHexKey.values()],
    LOCAL_ROAD_SPEED_METERS_PER_SECOND,
    CAR_CATCHMENT_CAP_SECONDS,
  );
}

/**
 * Rough pixel-to-axial conversion, accurate enough to centre a bounding
 * search box on — the per-cell distance check afterwards is what actually
 * decides membership, this only decides which cells are worth checking.
 */
function pixelToApproximateAxial(x: number, y: number): [number, number] {
  const q = ((x * SQRT_3) / 3 - y / 3) / HEX_SIZE_METERS;
  const r = (y * 2) / 3 / HEX_SIZE_METERS;
  return [Math.round(q), Math.round(r)];
}
