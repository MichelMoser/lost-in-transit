/**
 * Business context: answers "everywhere reachable by public transport from
 * one stop, leaving at this time, within this budget" — the transit
 * counterpart of viatopo's own walking `calculateReachability`. The
 * algorithm is RAPTOR (Round-based Public Transit Optimized Router): each
 * round represents one more transit leg, so round 1 finds every stop
 * reachable with no transfer, round 2 with one transfer, and so on, until a
 * round improves nothing or the budget is exhausted.
 *
 * RAPTOR scans by *pattern* rather than by trip, because every trip in one
 * pattern visits the same stops in the same order: a single pass along a
 * pattern's stop sequence can carry "the best trip boarded so far" forward,
 * upgrading to an earlier trip whenever a stop just improved this round
 * offers one, without ever re-deriving which stops the trip visits.
 */
import type { Timetable, TransitMode } from './timetable';

/** How the search reached one stop: on foot from the origin, or one transit leg. */
export type ReachLabel =
  | { readonly type: 'origin' }
  | {
      readonly type: 'transfer';
      readonly fromStopIndex: number;
      readonly seconds: number;
    }
  | {
      readonly type: 'trip';
      readonly patternIndex: number;
      readonly tripIndex: number;
      readonly boardStopIndex: number;
      readonly boardPosition: number;
      readonly alightPosition: number;
    };

/** One stop the search reached, and when. */
export interface ReachableTransitStop {
  stopIndex: number;
  /** Seconds since midnight of arrival at this stop. */
  arrivalSeconds: number;
  /** Number of transit legs ridden to get here (0 means reached on foot alone). */
  transitLegs: number;
}

/** One physical hop drawn on the map — a single trip's ride between two consecutive stops it serves, or a transfer. */
export interface ReachableTransitLeg {
  fromStopIndex: number;
  toStopIndex: number;
  mode: TransitMode | 'transfer';
  departureSeconds: number;
  arrivalSeconds: number;
}

/**
 * One step of a full point-to-point itinerary, in travel order. Consecutive
 * segments always chain — one's `toStopIndex` is the next one's
 * `fromStopIndex` — so the gap between one's `arrivalSeconds` and the next's
 * `departureSeconds` is exactly how long that interchange waits.
 */
export interface JourneySegment {
  readonly type: 'walk' | 'ride';
  readonly fromStopIndex: number;
  readonly toStopIndex: number;
  readonly departureSeconds: number;
  readonly arrivalSeconds: number;
  /** Present only when `type` is `'ride'`. */
  readonly mode?: TransitMode;
}

/** Result of one reachability search. */
export interface TransitReachability {
  originStopIndex: number;
  departureSeconds: number;
  budgetSeconds: number;
  stops: ReachableTransitStop[];
  legs: ReachableTransitLeg[];
  /**
   * The full step-by-step itinerary to one reached stop, in travel order —
   * what a reader hovering a destination actually wants, as opposed to
   * `legs`, which is the deduplicated network drawn on the map.
   *
   * @param stopIndex - A stop from this same search's `stops` (or the
   *   origin itself, which answers with an empty itinerary).
   * @returns The itinerary, or `null` if this search never reached that stop.
   */
  getJourneyTo: (stopIndex: number) => JourneySegment[] | null;
}

/** Rounds above this add legs a reader is very unlikely to want anyway. */
const DEFAULT_MAX_ROUNDS = 8;

/**
 * Finds, within one pattern's trips sorted by departure, the first whose
 * departure at `position` is no earlier than `earliestBoarding` — the
 * standard RAPTOR "earliest catchable trip" lookup. Trips within a pattern
 * never overtake each other, so sorting by the first stop's departure also
 * sorts every later stop's time, and one binary search per boarding attempt
 * suffices regardless of which position is being boarded at.
 *
 * @returns The trip's index within the pattern, or -1 if none can be caught.
 */
function findEarliestCatchableTrip(
  pattern: Timetable['patterns'][number],
  position: number,
  earliestBoarding: number,
): number {
  let low = 0;
  let high = pattern.trips.length;

  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((pattern.trips[middle]?.departures[position] ?? Infinity) < earliestBoarding) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low < pattern.trips.length ? low : -1;
}

/**
 * Relaxes every transfer leaving the given stops, improving arrival times
 * where a walk beats what is already known.
 *
 * @returns Stops whose arrival time this pass actually improved.
 */
function relaxTransfers(
  timetable: Timetable,
  arrival: Float64Array,
  label: (ReachLabel | null)[],
  transitLegCount: Int32Array,
  fromStops: ReadonlySet<number>,
  deadline: number,
  originStopIndex: number,
): Set<number> {
  const improved = new Set<number>();

  for (const stopIndex of fromStops) {
    for (const transfer of timetable.transfersFromStop[stopIndex] ?? []) {
      // The origin is fixed for the whole search. Real-world GTFS carries
      // enough data anomalies (sentinel `00:00:00` times on non-passenger
      // "stops" were one found by testing against the national feed) that a
      // bogus arrival earlier than the departure itself can otherwise reach
      // back to the origin, which then loses its own `origin` label and
      // turns the backward walk in `reconstructLegs` into an infinite loop.
      if (transfer.toStopIndex === originStopIndex) {
        continue;
      }

      const candidate = (arrival[stopIndex] ?? Infinity) + transfer.seconds;

      if (candidate <= deadline && candidate < (arrival[transfer.toStopIndex] ?? Infinity)) {
        arrival[transfer.toStopIndex] = candidate;
        // A transfer is not a transit leg of its own; it carries forward
        // however many the reader had already ridden to reach `stopIndex`.
        transitLegCount[transfer.toStopIndex] = transitLegCount[stopIndex] ?? 0;
        label[transfer.toStopIndex] = {
          type: 'transfer',
          fromStopIndex: stopIndex,
          seconds: transfer.seconds,
        };
        improved.add(transfer.toStopIndex);
      }
    }
  }

  return improved;
}

/**
 * Runs one RAPTOR search from a single origin stop.
 *
 * @param timetable - Snapshot loaded by `loadTimetable`.
 * @param originStopIndex - Where the walk to the network ends.
 * @param departureSeconds - Seconds since midnight the reader leaves at.
 * @param budgetSeconds - How long they are willing to spend travelling.
 * @param maxRounds - Safety cap on transfers, independent of the budget.
 * @returns Every stop reached within budget, and the legs used to reach them.
 */
export function findReachableStops(
  timetable: Timetable,
  originStopIndex: number,
  departureSeconds: number,
  budgetSeconds: number,
  maxRounds: number = DEFAULT_MAX_ROUNDS,
): TransitReachability {
  const deadline = departureSeconds + budgetSeconds;
  const stopCount = timetable.stopEastings.length;
  const arrival = new Float64Array(stopCount).fill(Infinity);
  const label: (ReachLabel | null)[] = new Array(stopCount).fill(null);
  const transitLegCount = new Int32Array(stopCount);

  arrival[originStopIndex] = departureSeconds;
  label[originStopIndex] = { type: 'origin' };

  let marked = new Set<number>([originStopIndex]);
  const walkedFromOrigin = relaxTransfers(
    timetable,
    arrival,
    label,
    transitLegCount,
    marked,
    deadline,
    originStopIndex,
  );
  marked = new Set([...marked, ...walkedFromOrigin]);

  for (let round = 0; round < maxRounds && marked.size > 0; round += 1) {
    const patternsToScan = new Set<number>();
    for (const stopIndex of marked) {
      for (const entry of timetable.patternsAtStop[stopIndex] ?? []) {
        patternsToScan.add(entry.patternIndex);
      }
    }

    const improvedByTrip = new Set<number>();

    for (const patternIndex of patternsToScan) {
      const pattern = timetable.patterns[patternIndex];
      if (!pattern) {
        continue;
      }

      let boardedTripIndex = -1;
      let boardedAtPosition = -1;

      for (let position = 0; position < pattern.stopSequence.length; position += 1) {
        const stopIndex = pattern.stopSequence[position];
        if (stopIndex === undefined) {
          continue;
        }

        if (boardedTripIndex !== -1) {
          const trip = pattern.trips[boardedTripIndex];
          const arrivalHere = trip?.arrivals[position];

          if (
            arrivalHere !== undefined &&
            arrivalHere <= deadline &&
            arrivalHere < (arrival[stopIndex] ?? Infinity) &&
            // See the matching guard in `relaxTransfers`: the origin's own
            // label must never be replaced, however early a trip's recorded
            // time claims to reach it.
            stopIndex !== originStopIndex
          ) {
            const boardStopIndex = pattern.stopSequence[boardedAtPosition] ?? 0;
            arrival[stopIndex] = arrivalHere;
            transitLegCount[stopIndex] = (transitLegCount[boardStopIndex] ?? 0) + 1;
            label[stopIndex] = {
              type: 'trip',
              patternIndex,
              tripIndex: boardedTripIndex,
              boardStopIndex: pattern.stopSequence[boardedAtPosition] ?? -1,
              boardPosition: boardedAtPosition,
              alightPosition: position,
            };
            improvedByTrip.add(stopIndex);
          }
        }

        // A stop only offers a fresh boarding when this round actually
        // improved it: re-checking every marked stop from every prior round
        // on every pattern pass would repeat work rounds already did.
        if (marked.has(stopIndex)) {
          const knownArrival = arrival[stopIndex] ?? Infinity;
          const currentTrip = boardedTripIndex === -1 ? null : pattern.trips[boardedTripIndex];

          if (
            knownArrival < Infinity &&
            (!currentTrip || knownArrival <= (currentTrip.departures[position] ?? Infinity))
          ) {
            const candidate = findEarliestCatchableTrip(pattern, position, knownArrival);

            if (candidate !== -1 && (boardedTripIndex === -1 || candidate < boardedTripIndex)) {
              boardedTripIndex = candidate;
              boardedAtPosition = position;
            }
          }
        }
      }
    }

    const improvedByTransfer = relaxTransfers(
      timetable,
      arrival,
      label,
      transitLegCount,
      improvedByTrip,
      deadline,
      originStopIndex,
    );

    marked = new Set([...improvedByTrip, ...improvedByTransfer]);
  }

  // The origin is where the journey starts, not somewhere it reaches: it is
  // drawn as its own marker by the caller, the same way the walking search's
  // origin is never one of its own `nodes`.
  const stops: ReachableTransitStop[] = [];
  for (let stopIndex = 0; stopIndex < stopCount; stopIndex += 1) {
    if (stopIndex === originStopIndex) {
      continue;
    }

    const arrivalSeconds = arrival[stopIndex];
    if (arrivalSeconds !== undefined && Number.isFinite(arrivalSeconds)) {
      stops.push({
        stopIndex,
        arrivalSeconds,
        transitLegs: transitLegCount[stopIndex] ?? 0,
      });
    }
  }

  const legs = reconstructLegs(timetable, label, arrival, stops);
  const getJourneyTo = (stopIndex: number): JourneySegment[] | null => {
    if (stopIndex !== originStopIndex && !Number.isFinite(arrival[stopIndex])) {
      return null;
    }

    return walkBackFromStop(timetable, label, arrival, stopIndex)
      .map(({ dedupeKey: _unused, ...segment }) => segment)
      .reverse();
  };

  return { originStopIndex, departureSeconds, budgetSeconds, stops, legs, getJourneyTo };
}

/** One step of a backward walk from a stop to the origin, still carrying its dedup key. */
interface InternalSegment extends JourneySegment {
  readonly dedupeKey: string;
}

/**
 * Walks one stop's label back to the origin, in that direction — last leg
 * of the journey first. Shared by `reconstructLegs`, which dedupes across
 * every reached stop's own walk to build the network drawn on the map, and
 * `getJourneyTo`, which reverses one stop's own walk into a single ordered
 * itinerary.
 */
function walkBackFromStop(
  timetable: Timetable,
  label: (ReachLabel | null)[],
  arrival: Float64Array,
  stopIndex: number,
): InternalSegment[] {
  const segments: InternalSegment[] = [];
  let current: number | null = stopIndex;
  const visited = new Set<number>();

  while (current !== null) {
    // Defensive rather than expected: `findReachableStops` keeps the
    // origin's own label fixed for exactly this reason, so a cycle here
    // would mean some other real-world data oddity produced one. Reached
    // distances are already final by this point regardless — only the
    // itinerary for this one destination would be cut short.
    if (visited.has(current)) {
      break;
    }
    visited.add(current);

    const currentLabel: ReachLabel | null | undefined = label[current];
    if (!currentLabel || currentLabel.type === 'origin') {
      break;
    }

    if (currentLabel.type === 'transfer') {
      const departureSeconds = arrival[currentLabel.fromStopIndex] ?? 0;
      segments.push({
        type: 'walk',
        fromStopIndex: currentLabel.fromStopIndex,
        toStopIndex: current,
        departureSeconds,
        arrivalSeconds: departureSeconds + currentLabel.seconds,
        dedupeKey: `transfer:${currentLabel.fromStopIndex}:${current}`,
      });
      current = currentLabel.fromStopIndex;
      continue;
    }

    const pattern = timetable.patterns[currentLabel.patternIndex];
    const trip = pattern?.trips[currentLabel.tripIndex];

    if (pattern && trip) {
      segments.push({
        type: 'ride',
        fromStopIndex: currentLabel.boardStopIndex,
        toStopIndex: current,
        departureSeconds: trip.departures[currentLabel.boardPosition] ?? 0,
        arrivalSeconds: trip.arrivals[currentLabel.alightPosition] ?? 0,
        mode: pattern.mode,
        dedupeKey: `trip:${currentLabel.patternIndex}:${currentLabel.boardPosition}:${currentLabel.alightPosition}`,
      });
    }

    current = currentLabel.boardStopIndex;
  }

  return segments;
}

/**
 * Walks each reached stop's label back to the origin, collecting the
 * physical hops used, deduplicated so a hop shared by several destinations'
 * paths is drawn once.
 */
function reconstructLegs(
  timetable: Timetable,
  label: (ReachLabel | null)[],
  arrival: Float64Array,
  stops: readonly ReachableTransitStop[],
): ReachableTransitLeg[] {
  const legs: ReachableTransitLeg[] = [];
  const seenLegKeys = new Set<string>();

  for (const stop of stops) {
    for (const segment of walkBackFromStop(timetable, label, arrival, stop.stopIndex)) {
      if (seenLegKeys.has(segment.dedupeKey)) {
        continue;
      }

      seenLegKeys.add(segment.dedupeKey);
      legs.push({
        fromStopIndex: segment.fromStopIndex,
        toStopIndex: segment.toStopIndex,
        mode: segment.type === 'walk' ? 'transfer' : (segment.mode as TransitMode),
        departureSeconds: segment.departureSeconds,
        arrivalSeconds: segment.arrivalSeconds,
      });
    }
  }

  return legs;
}
