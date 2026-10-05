// config.js — Paramètres du site. Seule la clé Google Maps est à renseigner.
// Tout le reste (facteurs d'émission, listes de choix) peut être ajusté ici sans toucher au code.

export const CONFIG = {
  // Clé Google Maps JavaScript API. Elle est publique par nature : la sécurité vient de la
  // restriction par référent HTTP configurée dans Google Cloud (voir README, étape 1).
  GOOGLE_MAPS_API_KEY: 'AIzaSyAhH84UJ8ODakVT05IczeJ9lMqjuqLaMMU',

  // Map ID, nécessaire aux marqueurs avancés (déplaçables). 'DEMO_MAP_ID' fonctionne pour démarrer ;
  // pour la production, créez votre propre Map ID dans Google Cloud > Google Maps Platform > Gestion des cartes.
  GOOGLE_MAPS_MAP_ID: 'DEMO_MAP_ID',

  // Pays par défaut pour l'autocomplétion (code ISO 3166-1 alpha-2, '' = monde entier).
  DEFAULT_COUNTRY: 'fr',
  DEFAULT_COUNTRY_LABEL: 'France',
  LANGUAGE: 'fr',

  // Vue initiale de la carte (centre de la France).
  DEFAULT_CENTER: { lat: 46.6034, lng: 1.8883 },
  DEFAULT_ZOOM: 6,

  MAX_WAYPOINTS: 3,

  // Point d'entrée de la Netlify Function.
  SUBMIT_URL: '/.netlify/functions/submit',

  // Bibliothèque d'export Excel, essayée dans l'ordre.
  // 1) xlsx-js-style : fork de SheetJS, même API, qui sait écrire les styles (en-têtes en gras).
  // 2) SheetJS officiel (édition communauté) : export identique, mais sans le gras.
  XLSX_SOURCES: [
    'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
    'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  ],
};

// Modes de transport : `travelMode` est le mode utilisé par Google pour calculer l'itinéraire.
// `shared: true` = véhicule partagé : les émissions sont divisées par le nombre de personnes à bord.
export const TRANSPORT_MODES = [
  { id: 'marche', label: 'Marche', icon: '🚶', travelMode: 'WALKING' },
  { id: 'velo', label: 'Vélo', icon: '🚲', travelMode: 'BICYCLING' },
  { id: 'velo_electrique', label: 'Vélo électrique', icon: '⚡', travelMode: 'BICYCLING' },
  { id: 'trottinette', label: 'Trottinette', icon: '🛴', travelMode: 'BICYCLING' },
  { id: 'moto', label: 'Moto / scooter', icon: '🛵', travelMode: 'DRIVING' },
  { id: 'voiture_thermique', label: 'Voiture thermique', icon: '🚗', travelMode: 'DRIVING', shared: true },
  { id: 'voiture_electrique', label: 'Voiture électrique / hybride', icon: '🔋', travelMode: 'DRIVING', shared: true },
  { id: 'covoiturage', label: 'Covoiturage', icon: '👥', travelMode: 'DRIVING', shared: true, defaultPassengers: 2 },
  { id: 'bus', label: 'Bus', icon: '🚌', travelMode: 'TRANSIT' },
  { id: 'tram', label: 'Tram', icon: '🚊', travelMode: 'TRANSIT' },
  { id: 'train', label: 'Train / TER', icon: '🚆', travelMode: 'TRANSIT' },
  { id: 'autre', label: 'Autre', icon: '➕', travelMode: 'DRIVING' },
];

// Facteurs d'émission en kg CO₂e par km.
// - Modes partagés (voitures, covoiturage) : par km parcouru par le véhicule, puis divisé par le nombre de personnes.
// - Autres modes : déjà par voyageur·km.
// Ordres de grandeur issus de la Base Empreinte ADEME / impactco2.fr (fabrication incluse).
// Vérifiez et mettez à jour ces valeurs sur https://impactco2.fr/outils/transport avant une étude officielle.
// `null` = pas d'estimation (le champ co2_kg reste vide).
export const EMISSION_FACTORS = {
  marche: 0,
  velo: 0,
  velo_electrique: 0.0109,
  trottinette: 0.0249,
  moto: 0.191, // moto thermique (un scooter thermique est autour de 0,076)
  voiture_thermique: 0.218,
  voiture_electrique: 0.103, // voiture électrique (une hybride se situe entre les deux)
  covoiturage: 0.218, // voiture thermique, divisée ensuite par les occupants
  bus: 0.113, // bus thermique
  tram: 0.0043,
  train: 0.0296, // TER
  autre: null,
};

export const MOTIFS = [
  { id: 'domicile_travail', label: 'Domicile – travail' },
  { id: 'domicile_etudes', label: 'Domicile – études' },
  { id: 'courses', label: 'Courses' },
  { id: 'loisirs', label: 'Loisirs' },
  { id: 'professionnel', label: 'Professionnel' },
  { id: 'autre', label: 'Autre' },
];

// Colonnes du tableur, dans l'ordre. Les mêmes listes existent dans submit.js et Code.gs.
export const COLUMNS = [
  'id', 'horodatage', 'utilisateur', 'date', 'heure_depart',
  'depart_adresse', 'depart_lat', 'depart_lng',
  'arrivee_adresse', 'arrivee_lat', 'arrivee_lng',
  'etapes', 'mode_transport', 'passagers', 'distance_km', 'duree_min', 'distance_modifiee',
  'motif', 'aller_retour', 'frequence_jours_semaine', 'co2_kg', 'commentaire', 'polyline',
];

export const modeById = (id) => TRANSPORT_MODES.find((m) => m.id === id) || null;
export const motifById = (id) => MOTIFS.find((m) => m.id === id) || null;

// Calcule les émissions d'un trajet (kg CO₂e, 2 décimales), ou null si le mode n'a pas de facteur.
export function computeCo2(modeId, distanceKm, persons = 1) {
  const factor = EMISSION_FACTORS[modeId];
  if (factor == null || !Number.isFinite(distanceKm) || distanceKm < 0) return null;
  const divisor = modeById(modeId)?.shared ? Math.max(1, persons || 1) : 1;
  return Math.round(((factor * distanceKm) / divisor) * 100) / 100;
}

// Formatage français.
const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
export const formatKm = (km) => `${nf1.format(km)} km`;
export const formatKg = (kg) => `${nf2.format(kg)} kg`;
export function formatMin(min) {
  if (!Number.isFinite(min)) return '—';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}
