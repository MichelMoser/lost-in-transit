import { register } from 'ol/proj/proj4.js';
import { get as getProjection } from 'ol/proj.js';
import proj4 from 'proj4';
import OlMap from 'ol/Map.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import TileLayer from 'ol/layer/Tile.js';
import WMTS from 'ol/source/WMTS.js';
import WMTSTileGrid from 'ol/tilegrid/WMTS.js';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style.js';
import type { MapBrowserEvent } from 'ol';

import { loadTimetable, TransitMode, type Timetable } from '../../src/timetable';
import { findReachableStops, type JourneySegment, type TransitReachability } from '../../src/raptor';
import { loadRoadNetwork, type RoadNetwork } from '../../src/roadNetwork';
import { findReachableRoadNodes, type CarReachability } from '../../src/carRouter';
import { computeTransitIsochroneHexagons } from './isochrone';
import { formatJourneyHtml } from './journeyFormat';
import { getLanguage, onLanguageChange, setLanguage, t, type Language } from './translations';

type Mode = 'transit' | 'car';

/** Official swisstopo LV95 WMTS coverage, in metres. */
const LV95_WMTS_EXTENT = [2_420_000, 1_030_000, 2_900_000, 1_350_000];

// --- Swiss LV95 (EPSG:2056) projection, matching the snapshot's own coordinates. ---
proj4.defs(
  'EPSG:2056',
  '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 ' +
    '+k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel ' +
    '+towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs +type=crs',
);
register(proj4);

// `optionsFromCapabilities` reads the projection's own extent while matching
// the capabilities document's tile matrix set; a bare `register(proj4)` alone
// leaves that unset and it throws reading `getAxisOrientation` on a lookup
// that comes back incomplete.
const lv95Projection = getProjection('EPSG:2056');
if (!lv95Projection) {
  throw new Error('EPSG:2056 registration did not expose an OpenLayers projection.');
}
lv95Projection.setExtent(LV95_WMTS_EXTENT);

const statusElement = document.getElementById('status') as HTMLDivElement;
const departureInput = document.getElementById('departure') as HTMLInputElement;
const departureRowElement = document.getElementById('departureRow') as HTMLDivElement;
const budgetInput = document.getElementById('budget') as HTMLInputElement;
const budgetValueElement = document.getElementById('budgetValue') as HTMLSpanElement;
const tooltipElement = document.getElementById('tooltip') as HTMLDivElement;
const showIsochroneInput = document.getElementById('showIsochrone') as HTMLInputElement;
const showIsochroneRowElement = document.getElementById('showIsochroneRow') as HTMLLabelElement;
const isochroneLegendElement = document.getElementById('isochroneLegend') as HTMLDivElement;
const showNetworkInput = document.getElementById('showNetwork') as HTMLInputElement;
const languageSelect = document.getElementById('language') as HTMLSelectElement;
const originDisplayElement = document.getElementById('originDisplay') as HTMLParagraphElement;
const isochroneEndElement = document.getElementById('isochroneEnd') as HTMLSpanElement;
const modeTransitButton = document.getElementById('modeTransit') as HTMLButtonElement;
const modeCarButton = document.getElementById('modeCar') as HTMLButtonElement;
const stopSearchRowElement = document.getElementById('stopSearchRow') as HTMLDivElement;
const stopSearchInput = document.getElementById('stopSearch') as HTMLInputElement;
const stopSearchDatalist = document.getElementById('stopSearchOptions') as HTMLDataListElement;
const legendTransitElement = document.getElementById('legendTransit') as HTMLDivElement;
const legendCarElement = document.getElementById('legendCar') as HTMLDivElement;

let currentMode: Mode = 'transit';

function setStatus(message: string): void {
  statusElement.textContent = message;
}

/**
 * Re-applies every static label in the panel to the current language. Run
 * once at startup and again on every language change or mode switch, since
 * nothing here is a reactive framework re-rendering that for us.
 */
function applyStaticText(): void {
  document.title = t('app.title');
  (document.getElementById('appTitle') as HTMLElement).textContent = t('app.title');
  (document.getElementById('appHint') as HTMLElement).textContent =
    currentMode === 'car' ? t('app.hint.car') : t('app.hint');
  (document.getElementById('modeTransitLabel') as HTMLElement).textContent = t('mode.switch.transit');
  (document.getElementById('modeCarLabel') as HTMLElement).textContent = t('mode.switch.car');
  (document.getElementById('stopSearchLabel') as HTMLElement).textContent = t('stopSearch.label');
  stopSearchInput.placeholder = t('stopSearch.placeholder');
  (document.getElementById('departureLabel') as HTMLElement).textContent = t('departure.label');
  (document.getElementById('budgetLabel') as HTMLElement).textContent = t('budget.label');
  (document.getElementById('showIsochroneLabel') as HTMLElement).textContent = t('layer.isochrone');
  (document.getElementById('showNetworkLabel') as HTMLElement).textContent = t('layer.network');
  (document.getElementById('isochroneStart') as HTMLElement).textContent = t('isochrone.start');
  (document.getElementById('legendRail') as HTMLElement).textContent = t('legend.rail');
  (document.getElementById('legendBus') as HTMLElement).textContent = t('legend.bus');
  (document.getElementById('legendTram') as HTMLElement).textContent = t('legend.tram');
  (document.getElementById('legendFerry') as HTMLElement).textContent = t('legend.ferry');
  (document.getElementById('legendCableCar') as HTMLElement).textContent = t('legend.cableCar');
  (document.getElementById('legendWalking') as HTMLElement).textContent = t('legend.walking');
  (document.getElementById('legendMotorway') as HTMLElement).textContent = t('legend.motorway');
  (document.getElementById('legendCarNote') as HTMLElement).textContent = t('legend.carNote');
  updateBudgetLabels();
  languageSelect.value = getLanguage();
}

/** The budget value appears twice — the slider readout and the isochrone legend's red end — kept in sync from one place. */
function updateBudgetLabels(): void {
  const text = t('budget.minutes', { minutes: budgetInput.value });
  budgetValueElement.textContent = text;
  isochroneEndElement.textContent = text;
}

// --- Basemap: swisstopo WMTS, grid built by hand rather than through
// `optionsFromCapabilities`. --------------------------------------------
//
// The capabilities document declares its CRS as a URN
// ("urn:ogc:def:crs:EPSG::2056"), and `ol/tilegrid/WMTS.js`'s own
// `createFromCapabilitiesMatrixSet` looks the projection up by that exact
// string with no way to override it — it throws reading `getAxisOrientation`
// off the `null` that lookup returns, however the EPSG:2056 registration
// above is named. swisstopo's own pyramid is fixed and published, so viatopo
// itself sidesteps the capabilities document entirely and states the grid
// directly; this copies that grid rather than fighting the parser further.
const LV95_VIEW_RESOLUTIONS = [
  4_000, 3_750, 3_500, 3_250, 3_000, 2_750, 2_500, 2_250, 2_000, 1_750, 1_500,
  1_250, 1_000, 750, 650, 500, 250, 100, 50, 20, 10, 5, 2.5, 2, 1.5, 1, 0.5,
  0.25, 0.1,
];

function createBasemapLayer(projection: ReturnType<typeof getProjection>): TileLayer<WMTS> {
  const tileGrid = new WMTSTileGrid({
    extent: LV95_WMTS_EXTENT,
    resolutions: LV95_VIEW_RESOLUTIONS,
    matrixIds: LV95_VIEW_RESOLUTIONS.map((_unused, index) => String(index)),
    origin: [LV95_WMTS_EXTENT[0], LV95_WMTS_EXTENT[3]],
  });

  return new TileLayer({
    source: new WMTS({
      url:
        'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/2056/' +
        '{TileMatrix}/{TileCol}/{TileRow}.jpeg',
      layer: 'ch.swisstopo.pixelkarte-farbe',
      matrixSet: '2056',
      format: 'image/jpeg',
      style: 'default',
      requestEncoding: 'REST',
      projection: projection ?? undefined,
      tileGrid,
    }),
  });
}

// --- Isochrone layer: the filled-area view, shared by both modes. ----------
const isochroneSource = new VectorSource();
const isochroneLayer = new VectorLayer({ source: isochroneSource, zIndex: 5 });

/**
 * Hue for how much of the budget was spent reaching a point — green for the
 * first stretch, through amber, to red as the deadline nears. The same
 * convention isochrone.ch itself uses, because a reader comparing this
 * against a tool they already know should not have to relearn a palette.
 * Shared between the isochrone hexes, the transit tip markers, and the
 * driving network's own road segments so all three read as one scale.
 */
function elapsedHue(elapsedSeconds: number, budgetSeconds: number): number {
  const fraction = Math.min(Math.max(elapsedSeconds / budgetSeconds, 0), 1);
  return 130 * (1 - fraction); // 130 (green) down to 0 (red)
}

function isochroneFillStyle(elapsedSeconds: number, budgetSeconds: number): Style {
  return new Style({
    fill: new Fill({ color: `hsla(${elapsedHue(elapsedSeconds, budgetSeconds)}, 75%, 45%, 0.5)` }),
  });
}

// --- Transit reachability layer (tip markers only) --------------------------
const reachabilitySource = new VectorSource();
const reachabilityLayer = new VectorLayer({ source: reachabilitySource, zIndex: 10 });

/** The single route drawn to whichever tip is currently hovered, in either mode — see `drawHoverRoute` / `drawCarHoverRoute`. */
const hoverRouteSource = new VectorSource();
const hoverRouteLayer = new VectorLayer({ source: hoverRouteSource, zIndex: 8 });

// --- Car reachability layer: every reached road segment, drawn immediately
// (unlike transit's arms, the motorway/trunk graph is compact enough that
// hover-gating would only hide information, not declutter anything). -------
const carRoadSource = new VectorSource();
const carRoadLayer = new VectorLayer({ source: carRoadSource, zIndex: 8 });

const MODE_COLORS: Record<number, string> = {
  [TransitMode.Tram]: '#2980b9',
  [TransitMode.Metro]: '#2980b9',
  [TransitMode.Rail]: '#c0392b',
  [TransitMode.Bus]: '#e67e22',
  [TransitMode.Ferry]: '#16a085',
  [TransitMode.CableCar]: '#8e44ad',
  [TransitMode.Gondola]: '#8e44ad',
  [TransitMode.Funicular]: '#8e44ad',
};

function legStyle(mode: number | 'transfer'): Style {
  if (mode === 'transfer') {
    return new Style({
      stroke: new Stroke({ color: '#999999', width: 2, lineDash: [4, 4] }),
    });
  }

  return new Style({
    stroke: new Stroke({ color: MODE_COLORS[mode] ?? '#555555', width: 3 }),
  });
}

/**
 * Every reached road segment is drawn as its own thin, semi-transparent
 * blue stroke — a shared `Style` instance, since it never varies per
 * feature (fresh `Style`/`Stroke` objects per edge would be needless
 * allocation across tens of thousands of segments). Two edges drawn on top
 * of each other — a two-way road's opposite-direction pair sharing the same
 * geometry, or several short segments bunched at an interchange — compose
 * their alpha on the canvas, so denser road coverage reads visibly darker
 * without any per-pixel density computed by hand.
 */
const CAR_ROAD_STYLE = new Style({
  stroke: new Stroke({ color: 'rgba(37, 99, 235, 0.35)', width: 1.6 }),
});

/**
 * A tip: the furthest point reached along one branch of the road network,
 * where no further edge continues outward within budget — an outer ring
 * with a solid black centre dot, distinct from both the transit tips
 * (coloured by elapsed time) and the origin (a plain solid dot) so all
 * three read as different things at a glance. The hovered variant is
 * simply larger, same as the transit tips' own hover state.
 */
function carTipStyle(hovered: boolean): Style[] {
  return [
    new Style({
      image: new CircleStyle({
        radius: hovered ? 9 : 6,
        fill: new Fill({ color: 'rgba(255, 255, 255, 0.9)' }),
        stroke: new Stroke({ color: '#2563eb', width: hovered ? 2.5 : 1.5 }),
      }),
      zIndex: 4,
    }),
    new Style({
      image: new CircleStyle({
        radius: hovered ? 3.5 : 2.5,
        fill: new Fill({ color: '#111111' }),
      }),
      zIndex: 5,
    }),
  ];
}
const CAR_TIP_STYLE = carTipStyle(false);
const CAR_TIP_HOVER_STYLE = carTipStyle(true);

/** The highlighted route to a hovered car tip — solid and heavier than the always-visible network underneath it. */
const CAR_HOVER_ROUTE_STYLE = new Style({
  stroke: new Stroke({ color: '#1d4ed8', width: 4 }),
  zIndex: 7,
});

const ORIGIN_STYLE = new Style({
  image: new CircleStyle({
    radius: 8,
    fill: new Fill({ color: '#111111' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 }),
  }),
  zIndex: 5,
});

/**
 * A tip: the far end of one transit arm, where no further leg continues
 * outward. Filled with the same green-to-red hue as the isochrone hex it
 * sits in, so a reader can read "how much budget is left here" from the dot
 * alone without having to hover.
 */
function tipStyle(elapsedSeconds: number, budgetSeconds: number, hovered: boolean): Style {
  const hue = elapsedHue(elapsedSeconds, budgetSeconds);
  return new Style({
    image: new CircleStyle({
      radius: hovered ? 8 : 5,
      fill: new Fill({ color: `hsl(${hue}, 75%, 45%)` }),
      stroke: new Stroke({ color: '#111111', width: hovered ? 3 : 2 }),
    }),
    zIndex: hovered ? 6 : 4,
  });
}

/** Marks a feature so hit-testing can tell a tip circle from a leg or the origin. */
const ROLE_PROPERTY = 'role';
const STOP_NAME_PROPERTY = 'stopName';
const STOP_INDEX_PROPERTY = 'stopIndex';
const NODE_INDEX_PROPERTY = 'nodeIndex';
const NORMAL_STYLE_PROPERTY = 'normalStyle';
const HOVER_STYLE_PROPERTY = 'hoverStyle';

function coordinateOf(timetable: Timetable, stopIndex: number): [number, number] {
  return [timetable.stopEastings[stopIndex] ?? 0, timetable.stopNorthings[stopIndex] ?? 0];
}

function roadCoordinateOf(network: RoadNetwork, nodeIndex: number): [number, number] {
  return [network.nodeEastings[nodeIndex] ?? 0, network.nodeNorthings[nodeIndex] ?? 0];
}

/**
 * Finds every stop the search reached that no drawn leg continues onward
 * from — the actual tip of its arm, rather than a junction passed through on
 * the way to one.
 */
function findTipStops(result: TransitReachability): TransitReachability['stops'] {
  const stopsWithOutgoingLeg = new Set(result.legs.map((leg) => leg.fromStopIndex));
  return result.stops.filter((stop) => !stopsWithOutgoingLeg.has(stop.stopIndex));
}

/**
 * Same idea as `findTipStops`, for the road network's own reached nodes —
 * but a full street network's dead ends are numerous enough (tens of
 * thousands at a typical budget: every cul-de-sac and short residential
 * spur is its own tip) that showing every one would be both visually
 * overwhelming and slow to render and hit-test. Keeping only the
 * latest-arriving tip per grid cell caps the marker count at the network's
 * own geographic footprint rather than its raw dead-end count.
 */
const CAR_TIP_GRID_METERS = 400;

function findTipRoadNodes(
  network: RoadNetwork,
  result: CarReachability,
): CarReachability['nodes'] {
  const hasOutgoingEdge = new Uint8Array(network.nodeEastings.length);
  for (const edge of result.edges) {
    hasOutgoingEdge[edge.fromNodeIndex] = 1;
  }

  const bestByCell = new Map<string, CarReachability['nodes'][number]>();
  for (const node of result.nodes) {
    if (hasOutgoingEdge[node.nodeIndex]) {
      continue;
    }

    const easting = network.nodeEastings[node.nodeIndex] ?? 0;
    const northing = network.nodeNorthings[node.nodeIndex] ?? 0;
    const key = `${Math.floor(easting / CAR_TIP_GRID_METERS)}:${Math.floor(northing / CAR_TIP_GRID_METERS)}`;
    const existing = bestByCell.get(key);
    if (!existing || node.arrivalSeconds > existing.arrivalSeconds) {
      bestByCell.set(key, node);
    }
  }

  return [...bestByCell.values()];
}

function drawTransitIsochrone(timetable: Timetable, result: TransitReachability): void {
  isochroneSource.clear();

  const start = performance.now();
  const hexagons = computeTransitIsochroneHexagons(timetable, result);

  for (const hex of hexagons) {
    const feature = new Feature({ geometry: new Polygon([hex.ring]) });
    feature.setStyle(isochroneFillStyle(hex.elapsedSeconds, result.budgetSeconds));
    isochroneSource.addFeature(feature);
  }

  console.log(
    `Isochrone: ${hexagons.length.toLocaleString()} hexes in ${(performance.now() - start).toFixed(1)}ms`,
  );
}

/**
 * Draws only the tips and the origin marker — the legs themselves are not
 * drawn upfront (every arm at once made the map unreadable at national
 * scale); `drawHoverRoute` below draws the one route to whichever tip is
 * currently hovered instead.
 */
function drawTransitReachability(timetable: Timetable, result: TransitReachability): void {
  reachabilitySource.clear();

  for (const stop of findTipStops(result)) {
    const elapsedSeconds = stop.arrivalSeconds - result.departureSeconds;
    const tipFeature = new Feature({
      geometry: new Point(coordinateOf(timetable, stop.stopIndex)),
    });
    tipFeature.set(ROLE_PROPERTY, 'tip');
    tipFeature.set(STOP_NAME_PROPERTY, timetable.stopNames[stop.stopIndex] ?? '');
    tipFeature.set(STOP_INDEX_PROPERTY, stop.stopIndex);
    tipFeature.set(NORMAL_STYLE_PROPERTY, tipStyle(elapsedSeconds, result.budgetSeconds, false));
    tipFeature.set(HOVER_STYLE_PROPERTY, tipStyle(elapsedSeconds, result.budgetSeconds, true));
    tipFeature.setStyle(tipFeature.get(NORMAL_STYLE_PROPERTY) as Style);
    reachabilitySource.addFeature(tipFeature);
  }

  const originFeature = new Feature({
    geometry: new Point(coordinateOf(timetable, result.originStopIndex)),
  });
  originFeature.setStyle(ORIGIN_STYLE);
  reachabilitySource.addFeature(originFeature);
}

/** Draws the point-to-point route to one hovered tip, or clears it when `stopIndex` is `null`. */
function drawHoverRoute(
  timetable: Timetable,
  result: TransitReachability,
  stopIndex: number | null,
): void {
  hoverRouteSource.clear();

  if (stopIndex === null) {
    return;
  }

  const journey = result.getJourneyTo(stopIndex);
  if (!journey) {
    return;
  }

  for (const segment of journey as JourneySegment[]) {
    const feature = new Feature({
      geometry: new LineString([
        coordinateOf(timetable, segment.fromStopIndex),
        coordinateOf(timetable, segment.toStopIndex),
      ]),
    });
    feature.setStyle(legStyle(segment.type === 'walk' ? 'transfer' : segment.mode ?? 'transfer'));
    hoverRouteSource.addFeature(feature);
  }
}

/**
 * Distinct `Feature`s the reached road network is split across — see
 * `drawCarRoads`. At national street-network scale a search can reach
 * well over a million edges (every residential cul-de-sac counts); one OL
 * `Feature` per edge was measured freezing the tab for tens of seconds.
 * Splitting into a small, fixed number of `MultiLineString`s instead keeps
 * the feature count — and so the render cost — roughly constant regardless
 * of how much was reached, the same fix the isochrone hex splat needed at
 * this project's last order-of-magnitude jump.
 */
const CAR_ROAD_BATCH_COUNT = 24;

/**
 * Draws the reached road network as thin lines that follow the actual
 * streets, plus a ring-and-dot marker at each branch's furthest point and
 * the usual origin marker — a more street-literal picture than a hex fill,
 * per the project owner's own request. Edges are split across
 * `CAR_ROAD_BATCH_COUNT` batches rather than drawn individually (see
 * above); within a batch, coincident segments (a two-way road's
 * opposite-direction pair, several short segments bunched at an
 * interchange) still won't double up since they share one path, but two
 * segments landing in *different* batches do compose their alpha on the
 * canvas, so dense coverage still reads visibly thicker without any
 * density computed by hand.
 */
/**
 * The result last drawn into `carRoadSource` — rebuilding the batches below
 * is itself a couple of seconds' work at national scale (see
 * `CAR_ROAD_BATCH_COUNT`), so switching back to car mode after visiting
 * transit mode should redraw the *layer* (cheap — the features are still
 * there) rather than redo that work for a result that hasn't changed.
 */
let lastDrawnCarResult: CarReachability | null = null;

function drawCarRoads(network: RoadNetwork, result: CarReachability): void {
  if (result === lastDrawnCarResult) {
    return;
  }
  lastDrawnCarResult = result;

  carRoadSource.clear();

  const batches: [number, number][][][] = Array.from({ length: CAR_ROAD_BATCH_COUNT }, () => []);
  result.edges.forEach((edge, index) => {
    batches[index % CAR_ROAD_BATCH_COUNT]?.push([
      roadCoordinateOf(network, edge.fromNodeIndex),
      roadCoordinateOf(network, edge.toNodeIndex),
    ]);
  });

  for (const lines of batches) {
    if (lines.length === 0) {
      continue;
    }
    const feature = new Feature({ geometry: new MultiLineString(lines) });
    feature.setStyle(CAR_ROAD_STYLE);
    carRoadSource.addFeature(feature);
  }

  for (const node of findTipRoadNodes(network, result)) {
    const tipFeature = new Feature({
      geometry: new Point(roadCoordinateOf(network, node.nodeIndex)),
    });
    tipFeature.set(ROLE_PROPERTY, 'tip');
    tipFeature.set(NODE_INDEX_PROPERTY, node.nodeIndex);
    tipFeature.set(NORMAL_STYLE_PROPERTY, CAR_TIP_STYLE);
    tipFeature.set(HOVER_STYLE_PROPERTY, CAR_TIP_HOVER_STYLE);
    tipFeature.setStyle(CAR_TIP_STYLE);
    carRoadSource.addFeature(tipFeature);
  }

  const originFeature = new Feature({
    geometry: new Point(roadCoordinateOf(network, result.originNodeIndex)),
  });
  originFeature.setStyle(ORIGIN_STYLE);
  carRoadSource.addFeature(originFeature);
}

/** Draws the point-to-point route to one hovered car tip, or clears it when `nodeIndex` is `null`. */
function drawCarHoverRoute(
  network: RoadNetwork,
  result: CarReachability,
  nodeIndex: number | null,
): void {
  hoverRouteSource.clear();

  if (nodeIndex === null) {
    return;
  }

  const route = result.getRouteTo(nodeIndex);
  if (!route) {
    return;
  }

  for (const segment of route) {
    const feature = new Feature({
      geometry: new LineString([
        roadCoordinateOf(network, segment.fromNodeIndex),
        roadCoordinateOf(network, segment.toNodeIndex),
      ]),
    });
    feature.setStyle(CAR_HOVER_ROUTE_STYLE);
    hoverRouteSource.addFeature(feature);
  }
}

// --- Nearest-point lookups: brute force, fine for one click at a time. ------
function nearestUsedStopIndex(
  timetable: Timetable,
  easting: number,
  northing: number,
): number | null {
  let bestIndex: number | null = null;
  let bestDistanceSquared = Infinity;

  for (let stopIndex = 0; stopIndex < timetable.stopEastings.length; stopIndex += 1) {
    if ((timetable.patternsAtStop[stopIndex]?.length ?? 0) === 0) {
      continue;
    }

    const deltaEasting = (timetable.stopEastings[stopIndex] ?? 0) - easting;
    const deltaNorthing = (timetable.stopNorthings[stopIndex] ?? 0) - northing;
    const distanceSquared = deltaEasting ** 2 + deltaNorthing ** 2;

    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestIndex = stopIndex;
    }
  }

  return bestIndex;
}

function nearestRoadNodeIndex(network: RoadNetwork, easting: number, northing: number): number | null {
  let bestIndex: number | null = null;
  let bestDistanceSquared = Infinity;

  for (let nodeIndex = 0; nodeIndex < network.nodeEastings.length; nodeIndex += 1) {
    // Skip nodes that make poor origins — mostly motorway/trunk off-ramps
    // that exit onto a street outside this graph's scope (see the
    // road-network data-source note in the README). A plain "has an
    // outgoing edge" check isn't enough: an off-ramp usually has one or two
    // and then nowhere further to go. `originEligible` instead marks nodes
    // in a large enough strongly-connected component to have a real onward
    // network — built from an actual repro (a click landing on Bern's
    // Tiefenaustrasse off-ramp gave "reached 2 junctions").
    if (network.originEligible[nodeIndex] !== 1) {
      continue;
    }

    const deltaEasting = (network.nodeEastings[nodeIndex] ?? 0) - easting;
    const deltaNorthing = (network.nodeNorthings[nodeIndex] ?? 0) - northing;
    const distanceSquared = deltaEasting ** 2 + deltaNorthing ** 2;

    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestIndex = nodeIndex;
    }
  }

  return bestIndex;
}

function departureSecondsFromInput(): number {
  const [hours, minutes] = departureInput.value.split(':').map(Number);
  return (hours ?? 8) * 3600 + (minutes ?? 0) * 60;
}

/**
 * Fetches and decodes the road network — a national, every-street graph, so
 * around 120MB even packed as CSR typed arrays. Loaded lazily, only once a
 * reader actually switches to car mode, rather than upfront alongside the
 * ~30MB transit snapshot: making every visitor wait on 150MB before the
 * page is interactive at all, for data most searches (transit ones) never
 * touch, would be a bad trade for the one-time cost of a short pause the
 * first time someone tries driving mode.
 */
function fetchRoadNetwork(): Promise<RoadNetwork> {
  return Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/road-network/nodes.bin`).then((response) =>
      response.arrayBuffer(),
    ),
    fetch(`${import.meta.env.BASE_URL}data/road-network/edges.bin`).then((response) =>
      response.arrayBuffer(),
    ),
    fetch(`${import.meta.env.BASE_URL}data/road-network/edge-offsets.bin`).then((response) =>
      response.arrayBuffer(),
    ),
    fetch(`${import.meta.env.BASE_URL}data/road-network/origin-eligible.bin`).then((response) =>
      response.arrayBuffer(),
    ),
  ]).then(([nodesBuffer, edgesBuffer, edgeOffsetsBuffer, originEligibleBuffer]) =>
    loadRoadNetwork(nodesBuffer, edgesBuffer, edgeOffsetsBuffer, originEligibleBuffer),
  );
}

async function main(): Promise<void> {
  applyStaticText();
  setStatus(t('status.loading'));

  // Root-relative, not absolute: GitHub Pages serves this as a project site
  // under /<repo>/, so an absolute `/data/...` would miss the data this
  // same deploy carries and instead ask the domain's real root for it.
  // `BASE_URL` is Vite's own build-time answer to "where am I served
  // from", already trailing-slashed.
  const [manifest, stops, stopTimesBuffer] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/manifest.json`).then((response) => response.json()),
    fetch(`${import.meta.env.BASE_URL}data/stops.json`).then((response) => response.json()),
    fetch(`${import.meta.env.BASE_URL}data/stop-times.bin`).then((response) =>
      response.arrayBuffer(),
    ),
  ]);

  const timetable = loadTimetable(manifest, stops, stopTimesBuffer);
  let roadNetwork: RoadNetwork | null = null;
  let roadNetworkLoadPromise: Promise<RoadNetwork> | null = null;

  const basemapLayer = createBasemapLayer(lv95Projection);
  const view = new View({
    projection: 'EPSG:2056',
    center: [2600000, 1200000], // Roughly the centre of Switzerland.
    zoom: 8,
  });

  const map = new OlMap({
    target: 'map',
    layers: [basemapLayer, isochroneLayer, hoverRouteLayer, carRoadLayer, reachabilityLayer],
    view,
  });

  let transitOriginIndex: number | null = null;
  let transitResult: TransitReachability | null = null;
  let carOriginIndex: number | null = null;
  let carResult: CarReachability | null = null;
  let lastSearchElapsedMs = 0;
  let hoveredTip: Feature | null = null;

  /**
   * Re-renders whatever the status line is currently saying — the loaded
   * summary, or the last search's result — so a language change or mode
   * switch updates text already on screen instead of only the next thing
   * said after it.
   */
  function refreshStatus(): void {
    if (currentMode === 'transit') {
      if (transitOriginIndex !== null && transitResult !== null) {
        const originName = timetable.stopNames[transitOriginIndex] ?? '';
        originDisplayElement.textContent = t('journey.from', { name: originName });
        originDisplayElement.style.display = 'block';
        setStatus(
          t('status.result', {
            name: originName,
            stops: transitResult.stops.length.toLocaleString(),
            legs: transitResult.legs.length.toLocaleString(),
            ms: lastSearchElapsedMs.toFixed(1),
          }),
        );
        return;
      }

      originDisplayElement.style.display = 'none';
      setStatus(
        `${t('status.loaded', {
          stops: timetable.stopNames.length.toLocaleString(),
          patterns: timetable.patterns.length.toLocaleString(),
          date: timetable.referenceDate,
        })}\n${t('status.clickHint')}`,
      );
      return;
    }

    if (carOriginIndex !== null && carResult !== null) {
      originDisplayElement.textContent = t('journey.from', { name: t('origin.selectedPoint') });
      originDisplayElement.style.display = 'block';
      setStatus(
        t('status.car.result', {
          nodes: carResult.nodes.length.toLocaleString(),
          edges: carResult.edges.length.toLocaleString(),
          ms: lastSearchElapsedMs.toFixed(1),
        }),
      );
      return;
    }

    originDisplayElement.style.display = 'none';
    setStatus(t('status.clickHint'));
  }

  function runSearch(): void {
    if (currentMode === 'transit') {
      if (transitOriginIndex === null) {
        return;
      }

      // The redrawn layer holds none of the previous features, so a
      // lingering reference here would style a tip that no longer exists.
      hoveredTip = null;
      hoverRouteSource.clear();
      tooltipElement.style.display = 'none';

      const departureSeconds = departureSecondsFromInput();
      const budgetSeconds = Number(budgetInput.value) * 60;
      const start = performance.now();
      const result = findReachableStops(timetable, transitOriginIndex, departureSeconds, budgetSeconds);
      lastSearchElapsedMs = performance.now() - start;
      transitResult = result;

      drawTransitIsochrone(timetable, result);
      drawTransitReachability(timetable, result);
      refreshStatus();
      return;
    }

    if (carOriginIndex === null || roadNetwork === null) {
      return;
    }

    hoveredTip = null;
    hoverRouteSource.clear();

    const budgetSeconds = Number(budgetInput.value) * 60;
    const start = performance.now();
    const result = findReachableRoadNodes(roadNetwork, carOriginIndex, budgetSeconds);
    lastSearchElapsedMs = performance.now() - start;
    carResult = result;

    drawCarRoads(roadNetwork, result);
    refreshStatus();
  }

  // --- Manual stop entry: a name typed or picked from the datalist sets the
  // transit origin exactly as a map click would, for a reader who knows
  // where they want to start from rather than where it is on the map. ------
  const stopIndexByName = new Map<string, number>();
  for (let stopIndex = 0; stopIndex < timetable.stopNames.length; stopIndex += 1) {
    if ((timetable.patternsAtStop[stopIndex]?.length ?? 0) === 0) {
      continue;
    }
    const name = timetable.stopNames[stopIndex] ?? '';
    if (name && !stopIndexByName.has(name)) {
      stopIndexByName.set(name, stopIndex);
    }
  }

  const datalistFragment = document.createDocumentFragment();
  for (const name of stopIndexByName.keys()) {
    const option = document.createElement('option');
    option.value = name;
    datalistFragment.appendChild(option);
  }
  stopSearchDatalist.appendChild(datalistFragment);
  console.log(`Stop search: ${stopIndexByName.size.toLocaleString()} named stops indexed.`);

  stopSearchInput.addEventListener('input', () => {
    const stopIndex = stopIndexByName.get(stopSearchInput.value.trim());
    if (stopIndex === undefined) {
      return;
    }

    transitOriginIndex = stopIndex;
    view.setCenter(coordinateOf(timetable, stopIndex));
    runSearch();
  });

  refreshStatus();
  onLanguageChange(() => {
    applyStaticText();
    refreshStatus();
  });

  // --- Hover: lift a tip and draw the one route that reaches it —
  // connections are not drawn until a tip is hovered, so the map at rest
  // shows just the reachable area and its endpoints. Works the same way in
  // both modes; only the itinerary tooltip is transit-only (road junctions
  // have no name to show, and "which streets" is exactly what the
  // highlighted route already draws). ---------------------------------
  const setHoveredTip = (feature: Feature | null) => {
    if (hoveredTip === feature) {
      return;
    }

    hoveredTip?.setStyle(hoveredTip.get(NORMAL_STYLE_PROPERTY) as Style | Style[]);
    hoveredTip = feature;
    hoveredTip?.setStyle(hoveredTip.get(HOVER_STYLE_PROPERTY) as Style | Style[]);

    if (currentMode === 'transit' && transitResult !== null) {
      const stopIndex = hoveredTip ? (hoveredTip.get(STOP_INDEX_PROPERTY) as number) : null;
      drawHoverRoute(timetable, transitResult, stopIndex);
    } else if (currentMode === 'car' && carResult !== null && roadNetwork !== null) {
      const nodeIndex = hoveredTip ? (hoveredTip.get(NODE_INDEX_PROPERTY) as number) : null;
      drawCarHoverRoute(roadNetwork, carResult, nodeIndex);
    }
  };

  map.on('pointermove', (event: MapBrowserEvent) => {
    if (event.dragging) {
      return;
    }

    const hoverLayer = currentMode === 'transit' ? reachabilityLayer : carRoadLayer;
    const feature = map.forEachFeatureAtPixel(
      event.pixel,
      (candidate) => candidate,
      {
        hitTolerance: 6,
        layerFilter: (layer) => layer === hoverLayer,
      },
    );

    const tip =
      feature instanceof Feature && feature.get(ROLE_PROPERTY) === 'tip' ? feature : null;

    setHoveredTip(tip);
    map.getTargetElement().style.cursor = tip ? 'pointer' : '';

    const tipStopIndex = tip ? (tip.get(STOP_INDEX_PROPERTY) as number | undefined) : undefined;
    const html =
      currentMode === 'transit' && tip && transitResult !== null && tipStopIndex !== undefined
        ? formatJourneyHtml(timetable, transitResult, tipStopIndex)
        : null;

    if (html) {
      tooltipElement.innerHTML = html;
      tooltipElement.style.left = `${event.pixel[0]}px`;
      tooltipElement.style.top = `${event.pixel[1]}px`;
      tooltipElement.style.display = 'block';
    } else {
      tooltipElement.style.display = 'none';
    }
  });

  map.on('singleclick', (event: MapBrowserEvent) => {
    const [easting, northing] = event.coordinate;

    if (currentMode === 'transit') {
      const nearest = nearestUsedStopIndex(timetable, easting, northing);
      if (nearest === null) {
        setStatus(t('status.noStop'));
        return;
      }
      transitOriginIndex = nearest;
      runSearch();
      return;
    }

    if (roadNetwork === null) {
      return; // Still loading — see setMode; the map is effectively inert until it resolves.
    }

    const nearest = nearestRoadNodeIndex(roadNetwork, easting, northing);
    if (nearest === null) {
      setStatus(t('status.noRoad'));
      return;
    }
    carOriginIndex = nearest;
    runSearch();
  });

  departureInput.addEventListener('change', runSearch);
  budgetInput.addEventListener('input', () => {
    updateBudgetLabels();
    runSearch();
  });

  function applyNetworkLayerVisibility(): void {
    reachabilityLayer.setVisible(currentMode === 'transit' && showNetworkInput.checked);
    hoverRouteLayer.setVisible(showNetworkInput.checked);
    carRoadLayer.setVisible(currentMode === 'car' && showNetworkInput.checked);
  }

  // The isochrone hex fill only exists for transit — car mode traces the
  // road network itself instead (`drawCarRoads`), so the layer, its
  // checkbox row, and its legend all only make sense in transit mode.
  function applyIsochroneVisibility(): void {
    isochroneLayer.setVisible(currentMode === 'transit' && showIsochroneInput.checked);
    showIsochroneRowElement.style.display = currentMode === 'transit' ? 'flex' : 'none';
    isochroneLegendElement.style.display = currentMode === 'transit' ? 'block' : 'none';
  }

  applyIsochroneVisibility();
  applyNetworkLayerVisibility();
  showIsochroneInput.addEventListener('change', applyIsochroneVisibility);
  showNetworkInput.addEventListener('change', applyNetworkLayerVisibility);

  // --- Mode switch: like Google Maps' travel-mode tabs, each mode keeps its
  // own last result, so flipping back and forth redraws rather than re-runs
  // a search. ---------------------------------------------------------------
  async function setMode(mode: Mode): Promise<void> {
    if (currentMode === mode) {
      return;
    }

    if (mode === 'car' && roadNetwork === null) {
      // First switch to car mode: fetch the ~120MB road network before
      // finishing the switch, rather than leaving the map clickable with
      // nothing loaded to search against yet.
      modeTransitButton.disabled = true;
      modeCarButton.disabled = true;
      setStatus(t('status.loadingRoadNetwork'));

      roadNetworkLoadPromise ??= fetchRoadNetwork();
      roadNetwork = await roadNetworkLoadPromise;

      modeTransitButton.disabled = false;
      modeCarButton.disabled = false;
    }

    currentMode = mode;
    modeTransitButton.setAttribute('aria-pressed', String(mode === 'transit'));
    modeCarButton.setAttribute('aria-pressed', String(mode === 'car'));
    stopSearchRowElement.style.display = mode === 'transit' ? 'block' : 'none';
    departureRowElement.style.display = mode === 'transit' ? 'block' : 'none';
    legendTransitElement.style.display = mode === 'transit' ? 'grid' : 'none';
    legendCarElement.style.display = mode === 'car' ? 'grid' : 'none';

    hoveredTip = null;
    hoverRouteSource.clear();
    tooltipElement.style.display = 'none';
    applyNetworkLayerVisibility();
    applyIsochroneVisibility();

    if (mode === 'transit') {
      if (transitResult !== null) {
        drawTransitIsochrone(timetable, transitResult);
        drawTransitReachability(timetable, transitResult);
      } else {
        isochroneSource.clear();
        reachabilitySource.clear();
      }
    } else {
      isochroneSource.clear();
      if (carResult !== null && roadNetwork !== null) {
        drawCarRoads(roadNetwork, carResult);
      } else {
        carRoadSource.clear();
      }
    }

    applyStaticText();
    refreshStatus();
  }

  modeTransitButton.addEventListener('click', () => void setMode('transit'));
  modeCarButton.addEventListener('click', () => void setMode('car'));

  languageSelect.value = getLanguage();
  languageSelect.addEventListener('change', () => {
    setLanguage(languageSelect.value as Language);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  setStatus(t('status.failed', { message: error instanceof Error ? error.message : String(error) }));
});
