/**
 * Business context: the in-memory shape `build-snapshot.mjs`'s output is
 * decoded into. The file on disk is packed for transfer (binary stop-times,
 * a manifest keyed by byte offset); this is the friendlier shape a search
 * actually queries — one array of trips per pattern, each trip's own
 * arrival/departure already sliced out of the shared binary blob.
 */

/** GTFS `route_type`: the mode every trip in one pattern runs as. */
export const enum TransitMode {
  Tram = 0,
  Metro = 1,
  Rail = 2,
  Bus = 3,
  Ferry = 4,
  CableCar = 5,
  Gondola = 6,
  Funicular = 7,
}

/** One trip's own timing along its pattern's fixed stop sequence. */
export interface TransitTrip {
  /** Seconds since midnight, one per stop in the pattern's `stopSequence`. */
  arrivals: Uint32Array;
  /** Seconds since midnight, one per stop in the pattern's `stopSequence`. */
  departures: Uint32Array;
}

/**
 * A group of trips sharing one ordered stop sequence — GTFS calls the
 * individual trips a "route" only loosely; RAPTOR's own notion of "route" is
 * this grouping, since it is what lets a search scan trips by departure time
 * without re-deriving which stops a trip visits.
 */
export interface TransitPattern {
  /** Stop indices, in travel order. */
  stopSequence: number[];
  /** Mode every trip on this pattern runs as. */
  mode: TransitMode;
  /** Trips on this pattern, sorted by departure time at the first stop. */
  trips: TransitTrip[];
}

/** One walkable connection between two stops, such as a station interchange. */
export interface TransitTransfer {
  fromStopIndex: number;
  toStopIndex: number;
  seconds: number;
}

/** The whole timetable for one reference day, ready to search. */
export interface Timetable {
  /** Day the snapshot was built for, as `YYYYMMDD`. */
  referenceDate: string;
  /** Stop coordinates in EPSG:2056, parallel to `stopNames`. */
  stopEastings: Int32Array;
  stopNorthings: Int32Array;
  stopNames: string[];
  patterns: TransitPattern[];
  transfers: TransitTransfer[];
  /**
   * Every pattern touching one stop, and where in its sequence — the reverse
   * index a round of RAPTOR needs to find which patterns are worth scanning
   * from the stops a previous round just improved.
   */
  patternsAtStop: ReadonlyArray<
    ReadonlyArray<{ patternIndex: number; position: number }>
  >;
  /** Every transfer whose `fromStopIndex` is this stop. */
  transfersFromStop: ReadonlyArray<ReadonlyArray<TransitTransfer>>;
}

/** Raw shape of `manifest.json`, before trip times are sliced out of the binary blob. */
interface ManifestPattern {
  stopSequence: number[];
  routeType: number;
  tripByteOffsets: number[];
}

interface Manifest {
  referenceDate: string;
  stopCount: number;
  patterns: ManifestPattern[];
  transfers: [number, number, number][];
}

interface StopsFile {
  names: string[];
  eastings: number[];
  northings: number[];
  parents: string[];
}

/**
 * Decodes `build-snapshot.mjs`'s output into a queryable {@link Timetable}.
 *
 * @param manifest - Parsed `manifest.json`.
 * @param stops - Parsed `stops.json`.
 * @param stopTimesBuffer - Raw bytes of `stop-times.bin`.
 * @returns A timetable ready for `findReachableStops`.
 */
export function loadTimetable(
  manifest: Manifest,
  stops: StopsFile,
  stopTimesBuffer: ArrayBuffer,
): Timetable {
  const stopTimes = new DataView(stopTimesBuffer);
  const patterns: TransitPattern[] = manifest.patterns.map((raw) => {
    const stopsPerTrip = raw.stopSequence.length;
    const trips = raw.tripByteOffsets.map((tripOffset): TransitTrip => {
      const arrivals = new Uint32Array(stopsPerTrip);
      const departures = new Uint32Array(stopsPerTrip);

      for (let position = 0; position < stopsPerTrip; position += 1) {
        const byteOffset = tripOffset + position * 8;
        arrivals[position] = stopTimes.getUint32(byteOffset);
        departures[position] = stopTimes.getUint32(byteOffset + 4);
      }

      return { arrivals, departures };
    });

    return { stopSequence: raw.stopSequence, mode: raw.routeType, trips };
  });

  const transfers: TransitTransfer[] = manifest.transfers.map(
    ([fromStopIndex, toStopIndex, seconds]) => ({
      fromStopIndex,
      toStopIndex,
      seconds,
    }),
  );

  return {
    referenceDate: manifest.referenceDate,
    stopEastings: Int32Array.from(stops.eastings),
    stopNorthings: Int32Array.from(stops.northings),
    stopNames: stops.names,
    patterns,
    transfers,
    patternsAtStop: buildPatternsAtStop(patterns, manifest.stopCount),
    transfersFromStop: buildTransfersFromStop(transfers, manifest.stopCount),
  };
}

/**
 * Indexes, per stop, every pattern touching it and its position within that
 * pattern's stop sequence — what a round of RAPTOR scans from a marked stop.
 */
export function buildPatternsAtStop(
  patterns: readonly TransitPattern[],
  stopCount: number,
): { patternIndex: number; position: number }[][] {
  const patternsAtStop: { patternIndex: number; position: number }[][] =
    Array.from({ length: stopCount }, () => []);

  patterns.forEach((pattern, patternIndex) => {
    pattern.stopSequence.forEach((stopIndex, position) => {
      patternsAtStop[stopIndex]?.push({ patternIndex, position });
    });
  });

  return patternsAtStop;
}

/** Indexes transfers by their origin stop, for the walk step after each round. */
export function buildTransfersFromStop(
  transfers: readonly TransitTransfer[],
  stopCount: number,
): TransitTransfer[][] {
  const transfersFromStop: TransitTransfer[][] = Array.from(
    { length: stopCount },
    () => [],
  );

  for (const transfer of transfers) {
    transfersFromStop[transfer.fromStopIndex]?.push(transfer);
  }

  return transfersFromStop;
}
