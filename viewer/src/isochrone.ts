/**
 * Business context: turns a RAPTOR (transit) search into the filled-area
 * view isochrone.ch shows, rather than the line network `main.ts` draws on
 * its own. The isochrone is not the transit network's own shape — it is the
 * union of a walking catchment circle around every reached stop, sized to
 * whatever budget is left after arriving there. A stop reached with the
 * whole budget still spare (the origin itself) casts a wide circle; one
 * reached in the trip's last minute casts almost none.
 *
 * Driving reachability is drawn differently (`main.ts`'s `drawCarRoads`
 * traces the actual road network instead) — the road graph reaches far more
 * discrete points than transit reaches stops, dense enough along each
 * carriageway that a per-point catchment circle here would be enormous
 * duplicate work for little visual gain over just drawing the roads
 * themselves.
 *
 * Computed as a hex grid rather than one circle per stop so overlapping
 * catchments merge into one shape and so every cell can report the single
 * best (earliest) arrival time reaching it, whichever stop that came from.
 */
import type { TransitReachability } from '../../src/raptor';
import type { Timetable } from '../../src/timetable';

/** Typical pedestrian speed used to size a transit stop's own walking catchment. */
const WALKING_SPEED_METERS_PER_SECOND = 1.2;

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
 * Each reached stop "splats" onto only the cells within its own walking
 * radius rather than every cell testing every stop, so a search covering a
 * whole city costs work proportional to the ground actually covered, not to
 * (stops × cells).
 *
 * @param originX - Origin easting, in EPSG:2056 metres — the local
 *   coordinate system every hex is centred on.
 * @param originY - Origin northing.
 * @param budgetSeconds - The search's own time budget.
 * @param sources - Every reached stop, with elapsed time since the search
 *   started (the origin itself included, with `elapsedAtArrival: 0`).
 * @returns One hex per covered cell, coloured by elapsed time in the caller.
 */
function computeHexagons(
  originX: number,
  originY: number,
  budgetSeconds: number,
  sources: IsochroneSource[],
): IsochroneHex[] {
  const bestArrivalByHexKey = new Map<string, number>();

  for (const source of sources) {
    const remainingSeconds = budgetSeconds - source.elapsedAtArrival;
    if (remainingSeconds <= 0) {
      continue;
    }

    const radius = remainingSeconds * WALKING_SPEED_METERS_PER_SECOND;

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
          source.elapsedAtArrival + distance / WALKING_SPEED_METERS_PER_SECOND;
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

  return computeHexagons(originX, originY, result.budgetSeconds, sources);
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
