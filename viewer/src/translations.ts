/**
 * Business context: Switzerland reads this in at least three languages, and
 * a tool about its own transport network is a strange one to leave in only
 * one. English stays as the fallback and the base key set; French and
 * German are typed against it, so a key added to one and forgotten in
 * another fails to compile rather than silently falling back at runtime.
 */

export type Language = 'en' | 'fr' | 'de';

export const LANGUAGES: readonly Language[] = ['en', 'fr', 'de'];

/** Values substituted into a template's `{name}` placeholders. */
export type TranslationParams = Record<string, string | number>;

const en = {
  'app.title': 'Transit reachability (test viewer)',
  'app.hint': 'Click the map to search from the nearest stop.',
  'departure.label': 'Departure time',
  'budget.label': 'Budget',
  'budget.minutes': '{minutes} min',
  'layer.isochrone': 'Show isochrone area',
  'layer.network': 'Show network lines',
  'status.loading': 'Loading timetable snapshot (~30 MB)…',
  'status.loaded': 'Loaded {stops} stops, {patterns} patterns for {date}.',
  'status.clickHint': 'Click the map to search.',
  'status.noStop': 'No used stop found nearby.',
  'status.result': '{name}: reached {stops} stops, {legs} legs drawn ({ms} ms).',
  'status.failed': 'Failed to start: {message}',
  'legend.rail': 'Rail',
  'legend.bus': 'Bus',
  'legend.tram': 'Tram/Metro',
  'legend.ferry': 'Ferry',
  'legend.cableCar': 'Cable car/Funicular',
  'legend.walking': 'Walking transfer',
  'isochrone.start': '0 min',
  'journey.alreadyHere': 'You are already here.',
  'journey.summary': 'Arrive {time} · {minutes} min',
  'journey.change.one': ' · {count} change',
  'journey.change.other': ' · {count} changes',
  'journey.from': 'From {name}',
  'journey.walk': 'Walk {duration} to {name}',
  'journey.wait': 'Wait {duration}',
  'journey.ride': '{mode} {departure} → {arrival} to {name}',
  'journey.minutes': '{count} min',
  'mode.rail': 'Rail',
  'mode.bus': 'Bus',
  'mode.tram': 'Tram',
  'mode.metro': 'Metro',
  'mode.ferry': 'Ferry',
  'mode.cableCar': 'Cable car',
  'mode.funicular': 'Funicular',
  'mode.transit': 'Transit',
} as const;

export type TranslationKey = keyof typeof en;

const fr: Record<TranslationKey, string> = {
  'app.title': 'Accessibilité en transports publics (test)',
  'app.hint': "Cliquez sur la carte pour chercher depuis l'arrêt le plus proche.",
  'departure.label': 'Heure de départ',
  'budget.label': 'Durée',
  'budget.minutes': '{minutes} min',
  'layer.isochrone': 'Afficher la zone isochrone',
  'layer.network': 'Afficher le réseau',
  'status.loading': "Chargement de l'horaire (~30 Mo)…",
  'status.loaded': '{stops} arrêts, {patterns} lignes chargés pour le {date}.',
  'status.clickHint': 'Cliquez sur la carte pour lancer une recherche.',
  'status.noStop': 'Aucun arrêt desservi trouvé à proximité.',
  'status.result': '{name} : {stops} arrêts atteints, {legs} tronçons affichés ({ms} ms).',
  'status.failed': 'Échec du démarrage : {message}',
  'legend.rail': 'Train',
  'legend.bus': 'Bus',
  'legend.tram': 'Tram/Métro',
  'legend.ferry': 'Bateau',
  'legend.cableCar': 'Téléphérique/Funiculaire',
  'legend.walking': 'Correspondance à pied',
  'isochrone.start': '0 min',
  'journey.alreadyHere': 'Vous êtes déjà ici.',
  'journey.summary': 'Arrivée {time} · {minutes} min',
  'journey.change.one': ' · {count} changement',
  'journey.change.other': ' · {count} changements',
  'journey.from': 'Depuis {name}',
  'journey.walk': "Marchez {duration} jusqu'à {name}",
  'journey.wait': 'Attente {duration}',
  'journey.ride': '{mode} {departure} → {arrival} jusqu\'à {name}',
  'journey.minutes': '{count} min',
  'mode.rail': 'Train',
  'mode.bus': 'Bus',
  'mode.tram': 'Tram',
  'mode.metro': 'Métro',
  'mode.ferry': 'Bateau',
  'mode.cableCar': 'Téléphérique',
  'mode.funicular': 'Funiculaire',
  'mode.transit': 'Transport',
};

const de: Record<TranslationKey, string> = {
  'app.title': 'ÖV-Erreichbarkeit (Testansicht)',
  'app.hint': 'Auf die Karte klicken, um ab der nächsten Haltestelle zu suchen.',
  'departure.label': 'Abfahrtszeit',
  'budget.label': 'Zeitbudget',
  'budget.minutes': '{minutes} Min',
  'layer.isochrone': 'Isochronenfläche anzeigen',
  'layer.network': 'Liniennetz anzeigen',
  'status.loading': 'Fahrplan wird geladen (~30 MB)…',
  'status.loaded': '{stops} Haltestellen, {patterns} Linienmuster geladen für {date}.',
  'status.clickHint': 'Auf die Karte klicken, um zu suchen.',
  'status.noStop': 'Keine bediente Haltestelle in der Nähe gefunden.',
  'status.result': '{name}: {stops} Haltestellen erreicht, {legs} Abschnitte gezeichnet ({ms} ms).',
  'status.failed': 'Start fehlgeschlagen: {message}',
  'legend.rail': 'Bahn',
  'legend.bus': 'Bus',
  'legend.tram': 'Tram/Metro',
  'legend.ferry': 'Schiff',
  'legend.cableCar': 'Seilbahn/Standseilbahn',
  'legend.walking': 'Fussweg-Umstieg',
  'isochrone.start': '0 Min',
  'journey.alreadyHere': 'Sie sind bereits hier.',
  'journey.summary': 'Ankunft {time} · {minutes} Min',
  'journey.change.one': ' · {count} Umstieg',
  'journey.change.other': ' · {count} Umstiege',
  'journey.from': 'Ab {name}',
  'journey.walk': '{duration} zu Fuss bis {name}',
  'journey.wait': '{duration} Wartezeit',
  'journey.ride': '{mode} {departure} → {arrival} bis {name}',
  'journey.minutes': '{count} Min',
  'mode.rail': 'Bahn',
  'mode.bus': 'Bus',
  'mode.tram': 'Tram',
  'mode.metro': 'Metro',
  'mode.ferry': 'Schiff',
  'mode.cableCar': 'Seilbahn',
  'mode.funicular': 'Standseilbahn',
  'mode.transit': 'ÖV',
};

const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = { en, fr, de };

const STORAGE_KEY = 'transit-reachability-language';

function detectInitialLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && (LANGUAGES as readonly string[]).includes(stored)) {
    return stored as Language;
  }

  const browserLanguage = navigator.language.slice(0, 2).toLowerCase();
  return (LANGUAGES as readonly string[]).includes(browserLanguage)
    ? (browserLanguage as Language)
    : 'en';
}

let currentLanguage: Language = detectInitialLanguage();
const changeListeners = new Set<(language: Language) => void>();

export function getLanguage(): Language {
  return currentLanguage;
}

export function setLanguage(language: Language): void {
  if (language === currentLanguage) {
    return;
  }

  currentLanguage = language;
  localStorage.setItem(STORAGE_KEY, language);
  for (const listener of changeListeners) {
    listener(language);
  }
}

/** Runs `listener` immediately and again every time the language changes. */
export function onLanguageChange(listener: (language: Language) => void): void {
  changeListeners.add(listener);
}

/**
 * Translates one key in the current language, substituting `{name}`-style
 * placeholders.
 */
export function t(key: TranslationKey, params?: TranslationParams): string {
  const template = DICTIONARIES[currentLanguage][key];
  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

/**
 * Translates the change count with the right plural form — only ever 0 (the
 * empty string, direct connections say nothing about changes) or the "one"
 * versus "other" form English, French, and German all happen to share.
 */
export function tChangeCount(count: number): string {
  if (count <= 0) {
    return '';
  }

  return t(count === 1 ? 'journey.change.one' : 'journey.change.other', { count });
}
