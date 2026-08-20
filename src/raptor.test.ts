import { describe, expect, it } from 'vitest';
import { findReachableStops } from './raptor';
import {
  buildPatternsAtStop,
  buildTransfersFromStop,
  TransitMode,
  type Timetable,
  type TransitPattern,
  type TransitTransfer,
} from './timetable';

/** Assembles a full {@link Timetable} from patterns and transfers alone. */
function buildTestTimetable(
  stopCount: number,
  patterns: TransitPattern[],
  transfers: TransitTransfer[] = [],
): Timetable {
  return {
    referenceDate: '20260819',
    stopEastings: new Int32Array(stopCount),
    stopNorthings: new Int32Array(stopCount),
    stopNames: Array.from({ length: stopCount }, (_unused, index) => `stop-${index}`),
    patterns,
    transfers,
    patternsAtStop: buildPatternsAtStop(patterns, stopCount),
    transfersFromStop: buildTransfersFromStop(transfers, stopCount),
  };
}

/** One trip's arrivals/departures, given as `[seconds, seconds]` pairs per stop. */
function trip(...stops: [number, number][]) {
  return {
    arrivals: Uint32Array.from(stops.map(([arrival]) => arrival)),
    departures: Uint32Array.from(stops.map(([, departure]) => departure)),
  };
}

describe('findReachableStops', () => {
  it('rides one pattern to every stop within budget, stopping at the horizon', () => {
    // A(0) --100s--> B(1) --100s--> C(2) --100s--> D(3)
    const pattern: TransitPattern = {
      stopSequence: [0, 1, 2, 3],
      mode: TransitMode.Rail,
      trips: [
        trip([0, 0], [100, 100], [200, 200], [300, 300]),
      ],
    };
    const timetable = buildTestTimetable(4, [pattern]);

    const result = findReachableStops(timetable, 0, 0, 250);

    expect(result.stops).toEqual(
      expect.arrayContaining([
        { stopIndex: 1, arrivalSeconds: 100, transitLegs: 1 },
        { stopIndex: 2, arrivalSeconds: 200, transitLegs: 1 },
      ]),
    );
    expect(result.stops.some((stop) => stop.stopIndex === 3)).toBe(false);
  });

  it('skips a trip that has already left and catches the next one', () => {
    // Trip 1 departs A at 0; trip 2 departs A at 200. Leaving at 150 can only catch trip 2.
    const pattern: TransitPattern = {
      stopSequence: [0, 1],
      mode: TransitMode.Bus,
      trips: [trip([0, 0], [100, 100]), trip([200, 200], [300, 300])],
    };
    const timetable = buildTestTimetable(2, [pattern]);

    const result = findReachableStops(timetable, 0, 150, 200);

    expect(result.stops).toEqual([
      { stopIndex: 1, arrivalSeconds: 300, transitLegs: 1 },
    ]);
  });

  it('uses a transfer to reach a second pattern at a different stop', () => {
    // A(0) --rail 100s--> B(1); B(1) --60s walk--> E(2); E(2) --ferry 200s--> F(3).
    const railPattern: TransitPattern = {
      stopSequence: [0, 1],
      mode: TransitMode.Rail,
      trips: [trip([0, 0], [100, 100])],
    };
    const ferryPattern: TransitPattern = {
      stopSequence: [2, 3],
      mode: TransitMode.Ferry,
      trips: [trip([200, 200], [400, 400])],
    };
    const timetable = buildTestTimetable(
      4,
      [railPattern, ferryPattern],
      [{ fromStopIndex: 1, toStopIndex: 2, seconds: 60 }],
    );

    const result = findReachableStops(timetable, 0, 0, 500);

    const destination = result.stops.find((stop) => stop.stopIndex === 3);
    expect(destination).toEqual({ stopIndex: 3, arrivalSeconds: 400, transitLegs: 2 });

    expect(result.legs).toEqual(
      expect.arrayContaining([
        { fromStopIndex: 0, toStopIndex: 1, mode: TransitMode.Rail, departureSeconds: 0, arrivalSeconds: 100 },
        { fromStopIndex: 1, toStopIndex: 2, mode: 'transfer', departureSeconds: 100, arrivalSeconds: 160 },
        { fromStopIndex: 2, toStopIndex: 3, mode: TransitMode.Ferry, departureSeconds: 200, arrivalSeconds: 400 },
      ]),
    );

    // The full itinerary, in travel order, including the 40s wait for the
    // ferry between the transfer landing (160) and its own departure (200) —
    // exactly what a reader hovering the destination wants to read.
    expect(result.getJourneyTo(3)).toEqual([
      {
        type: 'ride',
        fromStopIndex: 0,
        toStopIndex: 1,
        departureSeconds: 0,
        arrivalSeconds: 100,
        mode: TransitMode.Rail,
      },
      {
        type: 'walk',
        fromStopIndex: 1,
        toStopIndex: 2,
        departureSeconds: 100,
        arrivalSeconds: 160,
      },
      {
        type: 'ride',
        fromStopIndex: 2,
        toStopIndex: 3,
        departureSeconds: 200,
        arrivalSeconds: 400,
        mode: TransitMode.Ferry,
      },
    ]);
    expect(result.getJourneyTo(0)).toEqual([]);
    expect(result.getJourneyTo(99)).toBeNull();
  });

  it('leaves a stop unreached when the connecting trip departs before the transfer lands', () => {
    // Transfer lands at 160, but the ferry already left at 100 — connection missed entirely.
    const railPattern: TransitPattern = {
      stopSequence: [0, 1],
      mode: TransitMode.Rail,
      trips: [trip([0, 0], [100, 100])],
    };
    const ferryPattern: TransitPattern = {
      stopSequence: [2, 3],
      mode: TransitMode.Ferry,
      trips: [trip([50, 50], [100, 100])],
    };
    const timetable = buildTestTimetable(
      4,
      [railPattern, ferryPattern],
      [{ fromStopIndex: 1, toStopIndex: 2, seconds: 60 }],
    );

    const result = findReachableStops(timetable, 0, 0, 500);

    expect(result.stops.some((stop) => stop.stopIndex === 3)).toBe(false);
    // The transfer itself still lands at stop 2 even though nothing onward can be caught.
    expect(result.stops.some((stop) => stop.stopIndex === 2)).toBe(true);
  });

  it('deduplicates a leg shared by two different destinations', () => {
    // A(0) --rail--> B(1) --rail--> C(2), and B(1) --rail--> D(3): the A->B leg
    // is on the path to both C and D, and must appear in `legs` only once.
    const trunk: TransitPattern = {
      stopSequence: [0, 1],
      mode: TransitMode.Rail,
      trips: [trip([0, 0], [100, 100])],
    };
    const branchOne: TransitPattern = {
      stopSequence: [1, 2],
      mode: TransitMode.Rail,
      trips: [trip([100, 100], [200, 200])],
    };
    const branchTwo: TransitPattern = {
      stopSequence: [1, 3],
      mode: TransitMode.Rail,
      trips: [trip([100, 100], [180, 180])],
    };
    const timetable = buildTestTimetable(4, [trunk, branchOne, branchTwo]);

    const result = findReachableStops(timetable, 0, 0, 300);

    const trunkLegs = result.legs.filter(
      (leg) => leg.fromStopIndex === 0 && leg.toStopIndex === 1,
    );
    expect(trunkLegs).toHaveLength(1);
    expect(result.stops.map((stop) => stop.stopIndex).sort()).toEqual([1, 2, 3]);
  });

  it('reaches a stop by transfer alone when no pattern is faster', () => {
    const timetable = buildTestTimetable(2, [], [
      { fromStopIndex: 0, toStopIndex: 1, seconds: 300 },
    ]);

    const result = findReachableStops(timetable, 0, 0, 400);

    expect(result.stops).toEqual([
      { stopIndex: 1, arrivalSeconds: 300, transitLegs: 0 },
    ]);
  });

  it('never lets a bogus early time or a transfer back to it replace the origin', () => {
    // Found against the real national feed: a handful of GTFS "stops" are
    // non-passenger waypoints (named tunnel sections) carrying sentinel
    // 00:00:00 times earlier than any real departure. Modelled here as a
    // trip that "arrives" at stop 1 before it departed stop 0, paired with a
    // same-instant transfer back to the origin — exactly the shape that used
    // to overwrite the origin's own label and turn `reconstructLegs` into an
    // infinite loop walking back and forth between the two stops.
    const pattern: TransitPattern = {
      stopSequence: [0, 1],
      mode: TransitMode.Rail,
      trips: [trip([0, 100], [50, 50])],
    };
    const timetable = buildTestTimetable(2, [pattern], [
      { fromStopIndex: 1, toStopIndex: 0, seconds: 0 },
    ]);

    const result = findReachableStops(timetable, 0, 100, 400);

    expect(result.stops.some((stop) => stop.stopIndex === 0)).toBe(false);
    expect(result.legs.every((leg) => leg.toStopIndex !== 0)).toBe(true);
  });
});
