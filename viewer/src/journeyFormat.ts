/**
 * Business context: turns one `getJourneyTo` result into the same kind of
 * reading isochrone.ch shows on hover — not just "you can get there," but
 * the actual trip: which stop to walk to, which service to board and when,
 * how long the wait at each change is, and when it actually arrives.
 */
import type { JourneySegment, TransitReachability } from '../../src/raptor';
import { TransitMode, type Timetable } from '../../src/timetable';
import { t, tChangeCount, type TranslationKey } from './translations';

const MODE_LABEL_KEYS: Record<number, TranslationKey> = {
  [TransitMode.Tram]: 'mode.tram',
  [TransitMode.Metro]: 'mode.metro',
  [TransitMode.Rail]: 'mode.rail',
  [TransitMode.Bus]: 'mode.bus',
  [TransitMode.Ferry]: 'mode.ferry',
  [TransitMode.CableCar]: 'mode.cableCar',
  [TransitMode.Gondola]: 'mode.cableCar',
  [TransitMode.Funicular]: 'mode.funicular',
};

const MODE_DOT_COLORS: Record<number, string> = {
  [TransitMode.Tram]: '#2980b9',
  [TransitMode.Metro]: '#2980b9',
  [TransitMode.Rail]: '#c0392b',
  [TransitMode.Bus]: '#e67e22',
  [TransitMode.Ferry]: '#16a085',
  [TransitMode.CableCar]: '#8e44ad',
  [TransitMode.Gondola]: '#8e44ad',
  [TransitMode.Funicular]: '#8e44ad',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Formats seconds-since-midnight as a clock reading, past-midnight hours included. */
function formatClock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Formats a duration in seconds as whole minutes, rounding up so a real wait never reads as "0 min". */
function formatMinutes(seconds: number): string {
  return t('journey.minutes', { count: Math.max(1, Math.ceil(seconds / 60)) });
}

/**
 * Renders the full itinerary to one reached stop as an HTML fragment, ready
 * for a tooltip, in the current UI language. Every stop name is escaped —
 * it comes from the timetable snapshot, not from user input, but the
 * escaping costs nothing and a stray `&` in an official name is exactly the
 * kind of thing that has happened.
 *
 * @param timetable - The loaded snapshot, for stop names.
 * @param result - The search the destination was reached by.
 * @param stopIndex - The destination stop.
 * @returns HTML for the tooltip body, or `null` if this search never reached it.
 */
export function formatJourneyHtml(
  timetable: Timetable,
  result: TransitReachability,
  stopIndex: number,
): string | null {
  const journey = result.getJourneyTo(stopIndex);
  if (!journey) {
    return null;
  }

  const destinationName = escapeHtml(timetable.stopNames[stopIndex] ?? '');

  if (journey.length === 0) {
    return (
      `<div class="destination">${destinationName}</div>` +
      `<div class="summary">${t('journey.alreadyHere')}</div>`
    );
  }

  const stop = result.stops.find((candidate) => candidate.stopIndex === stopIndex);
  const totalMinutes = stop
    ? Math.round((stop.arrivalSeconds - result.departureSeconds) / 60)
    : 0;
  const changeCount = journey.filter((segment) => segment.type === 'ride').length - 1;

  const summary = stop
    ? t('journey.summary', { time: formatClock(stop.arrivalSeconds), minutes: totalMinutes }) +
      tChangeCount(changeCount)
    : '';

  const originName = escapeHtml(timetable.stopNames[result.originStopIndex] ?? '');
  const parts: string[] = [
    `<div class="destination">${destinationName}</div>`,
    `<div class="summary">${summary}</div>`,
    `<div class="segment">` +
      `<span class="mode-dot" style="background:transparent"></span>` +
      `<span class="text">${t('journey.from', { name: originName })}</span>` +
      `</div>`,
  ];

  journey.forEach((segment: JourneySegment, index: number) => {
    const toName = escapeHtml(timetable.stopNames[segment.toStopIndex] ?? '');

    if (segment.type === 'walk') {
      const duration = formatMinutes(segment.arrivalSeconds - segment.departureSeconds);
      parts.push(
        `<div class="segment">` +
          `<span class="mode-dot" style="background:#999999"></span>` +
          `<span class="text">${t('journey.walk', { duration, name: toName })}</span>` +
          `</div>`,
      );
    } else {
      const modeKey = MODE_LABEL_KEYS[segment.mode ?? -1];
      const modeLabel = modeKey ? t(modeKey) : t('mode.transit');
      const dotColor = MODE_DOT_COLORS[segment.mode ?? -1] ?? '#555555';
      parts.push(
        `<div class="segment">` +
          `<span class="mode-dot" style="background:${dotColor}"></span>` +
          `<span class="text">${t('journey.ride', {
            mode: modeLabel,
            departure: formatClock(segment.departureSeconds),
            arrival: formatClock(segment.arrivalSeconds),
            name: toName,
          })}</span>` +
          `</div>`,
      );
    }

    const next = journey[index + 1];
    if (next && next.departureSeconds > segment.arrivalSeconds) {
      const waitDuration = formatMinutes(next.departureSeconds - segment.arrivalSeconds);
      parts.push(`<div class="wait">${t('journey.wait', { duration: waitDuration })}</div>`);
    }
  });

  return parts.join('');
}
