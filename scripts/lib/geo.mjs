/**
 * Converts WGS84 degrees to Swiss LV95 (EPSG:2056) using swisstopo's
 * published approximate formula — accurate to about 1 metre, well inside
 * what a transit stop or road node marker needs. Shared by both the GTFS
 * and OSM road-network build scripts so the two snapshots' coordinates
 * always agree.
 */
export function wgs84ToLv95(lat, lon) {
  const latSec = (lat * 3600 - 169028.66) / 10000;
  const lonSec = (lon * 3600 - 26782.5) / 10000;
  const easting =
    2600072.37 +
    211455.93 * lonSec -
    10938.51 * lonSec * latSec -
    0.36 * lonSec * latSec ** 2 -
    44.54 * lonSec ** 3;
  const northing =
    1200147.07 +
    308807.95 * latSec +
    3745.25 * lonSec ** 2 +
    76.63 * latSec ** 2 -
    194.56 * lonSec ** 2 * latSec +
    119.79 * latSec ** 3;
  return [Math.round(easting), Math.round(northing)];
}
