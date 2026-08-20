import { register } from 'ol/proj/proj4.js';
import { get as getProjection } from 'ol/proj.js';
import proj4 from 'proj4';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import TileLayer from 'ol/layer/Tile.js';
import WMTS from 'ol/source/WMTS.js';
import WMTSTileGrid from 'ol/tilegrid/WMTS.js';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style.js';
import type { MapBrowserEvent } from 'ol';

import { loadTimetable, TransitMode, type Timetable } from '../../src/timetable';
import { findReachableStops, type TransitReachability } from '../../src/raptor';
import { computeIsochroneHexagons } from './isochrone';
import { formatJourneyHtml } from './journeyFormat';
import { getLanguage, onLanguageChange, setLanguage, t, type Language } from './translations';

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
const budgetInput = document.getElementById('budget') as HTMLInputElement;
const budgetValueElement = document.getElementById('budgetValue') as HTMLSpanElement;
const tooltipElement = document.getElementById('tooltip') as HTMLDivElement;
const showIsochroneInput = document.getElementById('showIsochrone') as HTMLInputElement;
const showNetworkInput = document.getElementById('showNetwork') as HTMLInputElement;
const languageSelect = document.getElementById('language') as HTMLSelectElement;

function setStatus(message: string): void {
  statusElement.textContent = message;
}

/**
 * Re-applies every static label in the panel to the current language. Run
 * once at startup and again on every language change, since nothing here is
 * a reactive framework re-rendering that for us.
 */
function applyStaticText(): void {
  document.title = t('app.title');
  (document.getElementById('appTitle') as HTMLElement).textContent = t('app.title');
  (document.getElementById('appHint') as HTMLElement).textContent = t('app.hint');
  (document.getElementById('departureLabel') as HTMLElement).textContent = t('departure.label');
  (document.getElementById('budgetLabel') as HTMLElement).textContent = t('budget.label');
  (document.getElementById('showIsochroneLabel') as HTMLElement).textContent = t('layer.isochrone');
  (document.getElementById('showNetworkLabel') as HTMLElement).textContent = t('layer.network');
  (document.getElementById('isochroneStart') as HTMLElement).textContent = t('isochrone.start');
  (document.getElementById('isochroneEnd') as HTMLElement).textContent = t('isochrone.end');
  (document.getElementById('legendRail') as HTMLElement).textContent = t('legend.rail');
  (document.getElementById('legendBus') as HTMLElement).textContent = t('legend.bus');
  (document.getElementById('legendTram') as HTMLElement).textContent = t('legend.tram');
  (document.getElementById('legendFerry') as HTMLElement).textContent = t('legend.ferry');
  (document.getElementById('legendCableCar') as HTMLElement).textContent = t('legend.cableCar');
  (document.getElementById('legendWalking') as HTMLElement).textContent = t('legend.walking');
  budgetValueElement.textContent = t('budget.minutes', { minutes: budgetInput.value });
  languageSelect.value = getLanguage();
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

// --- Isochrone layer: the filled-area view, drawn under the line network. --
const isochroneSource = new VectorSource();
const isochroneLayer = new VectorLayer({ source: isochroneSource, zIndex: 5 });

/**
 * Colours one hex by how much of the budget was spent reaching it — green
 * for the first stretch, through amber, to red as the deadline nears. The
 * same convention isochrone.ch itself uses, because a reader comparing this
 * against a tool they already know should not have to relearn a palette.
 */
function isochroneFillStyle(elapsedSeconds: number, budgetSeconds: number): Style {
  const fraction = Math.min(Math.max(elapsedSeconds / budgetSeconds, 0), 1);
  const hue = 130 * (1 - fraction); // 130 (green) down to 0 (red)
  return new Style({
    fill: new Fill({ color: `hsla(${hue}, 75%, 45%, 0.5)` }),
  });
}

// --- Reachability layer -----------------------------------------------------
const reachabilitySource = new VectorSource();
const reachabilityLayer = new VectorLayer({ source: reachabilitySource, zIndex: 10 });

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

const ORIGIN_STYLE = new Style({
  image: new CircleStyle({
    radius: 8,
    fill: new Fill({ color: '#111111' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 }),
  }),
  zIndex: 5,
});

/** A tip: the far end of one arm, where no further leg continues outward. */
const TIP_STYLE = new Style({
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: '#ffffff' }),
    stroke: new Stroke({ color: '#111111', width: 2 }),
  }),
  zIndex: 4,
});
const TIP_HOVER_STYLE = new Style({
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: '#ffe066' }),
    stroke: new Stroke({ color: '#111111', width: 2 }),
  }),
  zIndex: 6,
});

/** Marks a feature so hit-testing can tell a tip circle from a leg or the origin. */
const ROLE_PROPERTY = 'role';
const STOP_NAME_PROPERTY = 'stopName';
const STOP_INDEX_PROPERTY = 'stopIndex';

function coordinateOf(timetable: Timetable, stopIndex: number): [number, number] {
  return [timetable.stopEastings[stopIndex] ?? 0, timetable.stopNorthings[stopIndex] ?? 0];
}

/**
 * Finds every stop the search reached that no drawn leg continues onward
 * from — the actual tip of its arm, rather than a junction passed through on
 * the way to one.
 */
function findTipStopIndices(result: TransitReachability): number[] {
  const stopsWithOutgoingLeg = new Set(result.legs.map((leg) => leg.fromStopIndex));
  return result.stops
    .map((stop) => stop.stopIndex)
    .filter((stopIndex) => !stopsWithOutgoingLeg.has(stopIndex));
}

function drawIsochrone(timetable: Timetable, result: TransitReachability): void {
  isochroneSource.clear();

  const start = performance.now();
  const hexagons = computeIsochroneHexagons(timetable, result);

  for (const hex of hexagons) {
    const feature = new Feature({ geometry: new Polygon([hex.ring]) });
    feature.setStyle(isochroneFillStyle(hex.elapsedSeconds, result.budgetSeconds));
    isochroneSource.addFeature(feature);
  }

  console.log(
    `Isochrone: ${hexagons.length.toLocaleString()} hexes in ${(performance.now() - start).toFixed(1)}ms`,
  );
}

function drawReachability(timetable: Timetable, result: TransitReachability): void {
  reachabilitySource.clear();

  for (const leg of result.legs) {
    const feature = new Feature({
      geometry: new LineString([
        coordinateOf(timetable, leg.fromStopIndex),
        coordinateOf(timetable, leg.toStopIndex),
      ]),
    });
    feature.setStyle(legStyle(leg.mode));
    reachabilitySource.addFeature(feature);
  }

  for (const stopIndex of findTipStopIndices(result)) {
    const tipFeature = new Feature({ geometry: new Point(coordinateOf(timetable, stopIndex)) });
    tipFeature.set(ROLE_PROPERTY, 'tip');
    tipFeature.set(STOP_NAME_PROPERTY, timetable.stopNames[stopIndex] ?? '');
    tipFeature.set(STOP_INDEX_PROPERTY, stopIndex);
    tipFeature.setStyle(TIP_STYLE);
    reachabilitySource.addFeature(tipFeature);
  }

  const originFeature = new Feature({
    geometry: new Point(coordinateOf(timetable, result.originStopIndex)),
  });
  originFeature.setStyle(ORIGIN_STYLE);
  reachabilitySource.addFeature(originFeature);
}

// --- Nearest-stop lookup: brute force, fine for one click at a time. --------
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

function departureSecondsFromInput(): number {
  const [hours, minutes] = departureInput.value.split(':').map(Number);
  return (hours ?? 8) * 3600 + (minutes ?? 0) * 60;
}

async function main(): Promise<void> {
  applyStaticText();
  setStatus(t('status.loading'));

  const [manifest, stops, stopTimesBuffer] = await Promise.all([
    // Root-relative, not absolute: GitHub Pages serves this as a project
    // site under /<repo>/, so an absolute `/data/...` would miss the data
    // this same deploy carries and instead ask the domain's real root for
    // it. `BASE_URL` is Vite's own build-time answer to "where am I served
    // from", already trailing-slashed.
    fetch(`${import.meta.env.BASE_URL}data/manifest.json`).then((response) => response.json()),
    fetch(`${import.meta.env.BASE_URL}data/stops.json`).then((response) => response.json()),
    fetch(`${import.meta.env.BASE_URL}data/stop-times.bin`).then((response) =>
      response.arrayBuffer(),
    ),
  ]);

  const timetable = loadTimetable(manifest, stops, stopTimesBuffer);

  const basemapLayer = createBasemapLayer(lv95Projection);
  const view = new View({
    projection: 'EPSG:2056',
    center: [2600000, 1200000], // Roughly the centre of Switzerland.
    zoom: 8,
  });

  const map = new Map({
    target: 'map',
    layers: [basemapLayer, isochroneLayer, reachabilityLayer],
    view,
  });

  let currentOriginIndex: number | null = null;
  let currentResult: TransitReachability | null = null;
  let lastSearchElapsedMs = 0;
  let hoveredTip: Feature | null = null;

  /**
   * Re-renders whatever the status line is currently saying — the loaded
   * summary, or the last search's result — so a language change updates
   * text already on screen instead of only the next thing said after it.
   */
  function refreshStatus(): void {
    if (currentOriginIndex !== null && currentResult !== null) {
      setStatus(
        t('status.result', {
          name: timetable.stopNames[currentOriginIndex] ?? '',
          stops: currentResult.stops.length.toLocaleString(),
          legs: currentResult.legs.length.toLocaleString(),
          ms: lastSearchElapsedMs.toFixed(1),
        }),
      );
      return;
    }

    setStatus(
      `${t('status.loaded', {
        stops: timetable.stopNames.length.toLocaleString(),
        patterns: timetable.patterns.length.toLocaleString(),
        date: timetable.referenceDate,
      })}\n${t('status.clickHint')}`,
    );
  }

  function runSearch(): void {
    if (currentOriginIndex === null) {
      return;
    }

    // The redrawn layer holds none of the previous features, so a lingering
    // reference here would style a tip that no longer exists in the source.
    hoveredTip = null;
    tooltipElement.style.display = 'none';

    const departureSeconds = departureSecondsFromInput();
    const budgetSeconds = Number(budgetInput.value) * 60;
    const start = performance.now();
    const result = findReachableStops(
      timetable,
      currentOriginIndex,
      departureSeconds,
      budgetSeconds,
    );
    lastSearchElapsedMs = performance.now() - start;
    currentResult = result;

    drawIsochrone(timetable, result);
    drawReachability(timetable, result);
    refreshStatus();
  }

  refreshStatus();
  onLanguageChange(() => {
    applyStaticText();
    refreshStatus();
  });

  // --- Hover: lift a tip and show which station it is. -------------------
  const setHoveredTip = (feature: Feature | null) => {
    if (hoveredTip === feature) {
      return;
    }

    hoveredTip?.setStyle(TIP_STYLE);
    hoveredTip = feature;
    hoveredTip?.setStyle(TIP_HOVER_STYLE);
  };

  map.on('pointermove', (event: MapBrowserEvent) => {
    if (event.dragging) {
      return;
    }

    const feature = map.forEachFeatureAtPixel(
      event.pixel,
      (candidate) => candidate,
      {
        hitTolerance: 6,
        layerFilter: (layer) => layer === reachabilityLayer,
      },
    );

    const tip =
      feature instanceof Feature && feature.get(ROLE_PROPERTY) === 'tip' ? feature : null;

    setHoveredTip(tip);
    map.getTargetElement().style.cursor = tip ? 'pointer' : '';

    const tipStopIndex = tip ? (tip.get(STOP_INDEX_PROPERTY) as number | undefined) : undefined;
    const html =
      tip && currentResult !== null && tipStopIndex !== undefined
        ? formatJourneyHtml(timetable, currentResult, tipStopIndex)
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
    const nearest = nearestUsedStopIndex(timetable, easting, northing);

    if (nearest === null) {
      setStatus(t('status.noStop'));
      return;
    }

    currentOriginIndex = nearest;
    runSearch();
  });

  departureInput.addEventListener('change', runSearch);
  budgetInput.addEventListener('input', () => {
    budgetValueElement.textContent = t('budget.minutes', { minutes: budgetInput.value });
    runSearch();
  });

  isochroneLayer.setVisible(showIsochroneInput.checked);
  reachabilityLayer.setVisible(showNetworkInput.checked);
  showIsochroneInput.addEventListener('change', () => {
    isochroneLayer.setVisible(showIsochroneInput.checked);
  });
  showNetworkInput.addEventListener('change', () => {
    reachabilityLayer.setVisible(showNetworkInput.checked);
  });

  languageSelect.value = getLanguage();
  languageSelect.addEventListener('change', () => {
    setLanguage(languageSelect.value as Language);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  setStatus(t('status.failed', { message: error instanceof Error ? error.message : String(error) }));
});
