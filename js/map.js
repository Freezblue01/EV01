// map.js — Google Maps : chargement de l'API, carte, autocomplétion, marqueurs et itinéraires.
//
// Le site utilise les API Google actuelles :
//   - Routes : google.maps.routes.Route.computeRoutes()  (remplace DirectionsService, classé « legacy » depuis 2025)
//   - Places : AutocompleteSuggestion (Places API New), avec une liste de suggestions accessible faite maison
// Sans clé valide, tout reste utilisable en saisie manuelle (adresses + distance + durée).

import { CONFIG, modeById } from './config.js';

const $ = (id) => document.getElementById(id);

const state = {
  ready: false, // API chargée et clé acceptée
  map: null,
  libs: {}, // classes Google chargées via importLibrary
  geocoder: null,
  modeId: null,
  restrictCountry: true,
  origin: { lat: null, lng: null }, // coordonnées du départ (le texte est dans l'input)
  destination: { lat: null, lng: null },
  waypoints: [], // [{ uid, input, row, lat, lng }]
  markers: new Map(), // clé ('origin', 'destination', uid) -> AdvancedMarkerElement
  routes: [], // résultats de computeRoutes
  selected: 0,
  polylines: [],
  requestId: 0, // permet d'ignorer les réponses arrivées trop tard
};

let callbacks = { onRouteChange() {}, onAuthFailure() {}, toast() {} };
let waypointSeq = 0;

const el = {
  depart: $('depart'),
  arrivee: $('arrivee'),
  waypoints: $('waypoints'),
  addWaypoint: $('btn-add-waypoint'),
  locate: $('btn-locate'),
  swap: $('btn-swap'),
  clear: $('btn-clear-route'),
  restrict: $('restrict-country'),
  status: $('route-status'),
  routesFieldset: $('routes-fieldset'),
  routesList: $('routes-list'),
  loading: $('map-loading'),
  fallback: $('map-fallback'),
  hint: $('map-hint'),
  pane: $('map-pane'),
};

/* ------------------------------------------------------------------ */
/* Initialisation                                                       */
/* ------------------------------------------------------------------ */

export async function initMap(options) {
  callbacks = { ...callbacks, ...options };
  bindInputs();

  const key = CONFIG.GOOGLE_MAPS_API_KEY;
  if (!key || key.startsWith('VOTRE_')) {
    showFallback();
    return { ok: false, reason: 'missing-key' };
  }

  try {
    await loadGoogleMaps(key);
    const [mapsLib, markerLib, routesLib, placesLib, geocodingLib] = await Promise.all([
      google.maps.importLibrary('maps'),
      google.maps.importLibrary('marker'),
      google.maps.importLibrary('routes'),
      google.maps.importLibrary('places'),
      google.maps.importLibrary('geocoding'),
    ]);
    state.libs = {
      Map: mapsLib.Map,
      Polyline: mapsLib.Polyline,
      AdvancedMarkerElement: markerLib.AdvancedMarkerElement,
      Route: routesLib.Route,
      AutocompleteSuggestion: placesLib.AutocompleteSuggestion,
      AutocompleteSessionToken: placesLib.AutocompleteSessionToken,
    };
    state.geocoder = new geocodingLib.Geocoder();
  } catch (err) {
    console.error(err);
    showFallback();
    return { ok: false, reason: 'load-error' };
  }

  state.map = new state.libs.Map($('map'), {
    center: CONFIG.DEFAULT_CENTER,
    zoom: CONFIG.DEFAULT_ZOOM,
    mapId: CONFIG.GOOGLE_MAPS_MAP_ID,
    colorScheme: 'FOLLOW_SYSTEM', // suit le mode sombre du système
    gestureHandling: 'greedy', // un seul doigt suffit pour déplacer la carte
    clickableIcons: false, // un appui sur un lieu place un point au lieu d'ouvrir une fiche
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });
  state.map.addListener('click', (e) => onMapClick(e.latLng));
  state.ready = true;
  return { ok: true };
}

// Charge le script Maps une seule fois. `gm_authFailure` est appelé par Google si la clé est refusée.
function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps?.importLibrary) return resolve();
    window.__onGoogleMapsLoaded = () => resolve();
    window.gm_authFailure = () => {
      state.ready = false;
      clearRoute();
      showFallback();
      callbacks.onAuthFailure();
    };
    const params = new URLSearchParams({
      key,
      v: 'weekly',
      loading: 'async',
      language: CONFIG.LANGUAGE,
      callback: '__onGoogleMapsLoaded',
    });
    if (CONFIG.DEFAULT_COUNTRY) params.set('region', CONFIG.DEFAULT_COUNTRY.toUpperCase());
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => reject(new Error('Le script Google Maps n’a pas pu être chargé.'));
    document.head.append(script);
  });
}

function showFallback() {
  el.fallback.hidden = false;
  el.hint.hidden = true;
  el.pane.classList.add('is-fallback');
}

export const isMapReady = () => state.ready;

/* ------------------------------------------------------------------ */
/* Champs d'adresse                                                     */
/* ------------------------------------------------------------------ */

function bindInputs() {
  attachAutocomplete(el.depart, 'origin');
  attachAutocomplete(el.arrivee, 'destination');

  el.addWaypoint.addEventListener('click', () => {
    const wp = addWaypoint();
    wp?.input.focus();
  });
  el.locate.addEventListener('click', locateUser);
  el.swap.addEventListener('click', swapEndpoints);
  el.clear.addEventListener('click', () => {
    resetMap();
    el.depart.focus();
  });

  el.restrict.checked = Boolean(CONFIG.DEFAULT_COUNTRY);
  el.restrict.closest('label').hidden = !CONFIG.DEFAULT_COUNTRY;
  $('restrict-country-label').textContent = `Rechercher en ${CONFIG.DEFAULT_COUNTRY_LABEL} uniquement`;
  el.restrict.addEventListener('change', () => { state.restrictCountry = el.restrict.checked; });
  state.restrictCountry = el.restrict.checked;
}

// Renvoie l'objet coordonnées associé à une « clé » de point.
function pointOf(key) {
  if (key === 'origin') return state.origin;
  if (key === 'destination') return state.destination;
  return state.waypoints.find((w) => w.uid === key) || null;
}

function inputOf(key) {
  if (key === 'origin') return el.depart;
  if (key === 'destination') return el.arrivee;
  return pointOf(key)?.input || null;
}

function setPoint(key, { address, lat, lng }) {
  const point = pointOf(key);
  if (!point) return;
  point.lat = lat;
  point.lng = lng;
  const input = inputOf(key);
  if (address != null) input.value = address;
  input.dispatchEvent(new Event('change', { bubbles: true })); // met à jour le récapitulatif
  syncMarkers();
}

/**
 * Autocomplétion accessible (motif « combobox » ARIA) basée sur AutocompleteSuggestion.
 * - Saisie libre conservée si l'API est indisponible.
 * - Les coordonnées sont effacées dès que le texte change : l'itinéraire utilisera alors le texte.
 */
function attachAutocomplete(input, key) {
  const wrapper = input.closest('.ac');
  const list = document.createElement('ul');
  list.className = 'ac-list';
  list.id = `${input.id}-listbox`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Suggestions d’adresses');
  list.hidden = true;
  wrapper.append(list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);

  let predictions = [];
  let active = -1;
  let timer = null;
  let token = null; // jeton de session Places (facturation groupée saisie + sélection)
  let seq = 0;
  let dirty = false; // texte modifié depuis la dernière sélection

  const close = () => {
    list.hidden = true;
    list.replaceChildren();
    predictions = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, idx) => li.setAttribute('aria-selected', String(idx === i)));
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', list.children[i].id);
      list.children[i].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const render = () => {
    list.replaceChildren();
    predictions.forEach((p, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const main = document.createElement('span');
      main.className = 'ac-main';
      main.textContent = (p.mainText || p.text).toString();
      const sub = document.createElement('span');
      sub.className = 'ac-sub';
      sub.textContent = p.secondaryText ? p.secondaryText.toString() : '';
      li.append(main, sub);
      // mousedown + preventDefault : évite que le blur de l'input ferme la liste avant le clic
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => choose(i));
      list.append(li);
    });
    const open = predictions.length > 0;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
  };

  const choose = async (i) => {
    const prediction = predictions[i];
    if (!prediction) return;
    const label = prediction.text.toString();
    close();
    input.value = label;
    dirty = false;
    try {
      const place = prediction.toPlace();
      await place.fetchFields({ fields: ['location'] });
      token = null; // la session se termine avec fetchFields
      setPoint(key, { address: label, lat: place.location.lat(), lng: place.location.lng() });
      focusMapOn(key);
      computeRoute();
    } catch (err) {
      console.warn('fetchFields', err);
      callbacks.toast('Impossible de localiser ce lieu, réessayez.', 'error');
    }
  };

  input.addEventListener('input', () => {
    const point = pointOf(key);
    if (point) { point.lat = null; point.lng = null; }
    dirty = true;
    clearTimeout(timer);
    const query = input.value.trim();
    if (!state.ready || query.length < 3) { close(); return; }
    timer = setTimeout(async () => {
      const current = ++seq;
      token ||= new state.libs.AutocompleteSessionToken();
      const request = { input: query, sessionToken: token, language: CONFIG.LANGUAGE };
      if (state.restrictCountry && CONFIG.DEFAULT_COUNTRY) request.includedRegionCodes = [CONFIG.DEFAULT_COUNTRY];
      const bounds = state.map?.getBounds();
      if (bounds) request.locationBias = bounds;
      try {
        const { suggestions } = await state.libs.AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
        if (current !== seq) return; // une saisie plus récente est en cours
        predictions = suggestions.map((s) => s.placePrediction).filter(Boolean).slice(0, 5);
        render();
      } catch (err) {
        console.warn('Autocomplétion indisponible', err);
        close();
      }
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % predictions.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active <= 0 ? predictions.length - 1 : active - 1); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  // Texte libre validé sans choisir de suggestion : l'itinéraire est calculé à partir du texte.
  input.addEventListener('blur', () => {
    setTimeout(close, 120);
    if (dirty) {
      dirty = false;
      syncMarkers();
      computeRoute();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Étapes intermédiaires                                                */
/* ------------------------------------------------------------------ */

function addWaypoint() {
  if (state.waypoints.length >= CONFIG.MAX_WAYPOINTS) return null;
  const uid = `wp${++waypointSeq}`;
  const row = document.createElement('div');
  row.className = 'field waypoint';
  row.innerHTML = `
    <label for="etape-${uid}"></label>
    <div class="input-row">
      <div class="ac"><input id="etape-${uid}" type="text" autocomplete="off" maxlength="300" placeholder="Adresse de l'étape"></div>
      <button type="button" class="btn-icon" data-remove>✕</button>
    </div>`;
  el.waypoints.append(row);
  const input = row.querySelector('input');
  const wp = { uid, row, input, lat: null, lng: null };
  state.waypoints.push(wp);
  attachAutocomplete(input, uid);
  row.querySelector('[data-remove]').addEventListener('click', () => {
    removeWaypoint(uid);
    el.addWaypoint.focus();
  });
  renumberWaypoints();
  return wp;
}

function removeWaypoint(uid) {
  const wp = pointOf(uid);
  if (!wp) return;
  wp.row.remove();
  state.waypoints = state.waypoints.filter((w) => w.uid !== uid);
  renumberWaypoints();
  syncMarkers();
  computeRoute();
}

function renumberWaypoints() {
  state.waypoints.forEach((wp, i) => {
    wp.row.querySelector('label').textContent = `Étape ${i + 1}`;
    wp.row.querySelector('[data-remove]').setAttribute('aria-label', `Supprimer l'étape ${i + 1}`);
  });
  el.addWaypoint.hidden = state.waypoints.length >= CONFIG.MAX_WAYPOINTS;
  el.depart.dispatchEvent(new Event('change', { bubbles: true }));
}

/* ------------------------------------------------------------------ */
/* Carte : clics, marqueurs, géolocalisation                            */
/* ------------------------------------------------------------------ */

// Un appui place le départ, puis l'arrivée, puis les étapes encore vides.
async function onMapClick(latLng) {
  const lat = latLng.lat();
  const lng = latLng.lng();
  const hasCoords = (p) => p.lat != null;
  let key = null;
  if (!hasCoords(state.origin) && !el.depart.value.trim()) key = 'origin';
  else if (!hasCoords(state.destination) && !el.arrivee.value.trim()) key = 'destination';
  else key = state.waypoints.find((w) => !hasCoords(w) && !w.input.value.trim())?.uid || null;

  if (!key) {
    callbacks.toast('Faites glisser les marqueurs pour modifier le trajet.', 'info');
    return;
  }
  setPoint(key, { address: 'Recherche de l’adresse…', lat, lng });
  setPoint(key, { address: await reverseGeocode(lat, lng), lat, lng });
  el.hint.textContent = key === 'origin'
    ? 'Touchez la carte pour placer l’arrivée.'
    : 'Faites glisser les marqueurs pour ajuster.';
  computeRoute();
}

async function reverseGeocode(lat, lng) {
  const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  if (!state.geocoder) return fallback;
  try {
    const { results } = await state.geocoder.geocode({ location: { lat, lng }, language: CONFIG.LANGUAGE });
    return results?.[0]?.formatted_address || fallback;
  } catch {
    return fallback; // API Geocoding non activée ou quota : on garde les coordonnées
  }
}

// Crée, déplace ou supprime les marqueurs pour refléter l'état courant.
function syncMarkers() {
  if (!state.ready) return;
  const wanted = new Map();
  if (state.origin.lat != null) wanted.set('origin', { ...state.origin, label: 'A', kind: 'origin', title: 'Départ' });
  state.waypoints.forEach((w, i) => {
    if (w.lat != null) wanted.set(w.uid, { lat: w.lat, lng: w.lng, label: String(i + 1), kind: 'waypoint', title: `Étape ${i + 1}` });
  });
  if (state.destination.lat != null) wanted.set('destination', { ...state.destination, label: 'B', kind: 'destination', title: 'Arrivée' });

  for (const [key, marker] of state.markers) {
    if (!wanted.has(key)) { marker.map = null; state.markers.delete(key); }
  }
  for (const [key, p] of wanted) {
    let marker = state.markers.get(key);
    if (!marker) {
      const content = document.createElement('div');
      marker = new state.libs.AdvancedMarkerElement({ map: state.map, content, gmpDraggable: true });
      marker.addListener('dragend', async () => {
        const { lat, lng } = toLiteral(marker.position);
        setPoint(key, { address: await reverseGeocode(lat, lng), lat, lng });
        computeRoute();
      });
      state.markers.set(key, marker);
    }
    marker.position = { lat: p.lat, lng: p.lng };
    marker.title = `${p.title} (déplaçable)`;
    marker.content.className = `pin pin--${p.kind}`;
    marker.content.textContent = p.label;
  }
}

function focusMapOn(key) {
  const p = pointOf(key);
  if (!state.ready || p?.lat == null) return;
  if (!state.routes.length) {
    state.map.panTo({ lat: p.lat, lng: p.lng });
    if (state.map.getZoom() < 13) state.map.setZoom(13);
  }
}

export function locateUser() {
  if (!('geolocation' in navigator)) {
    callbacks.toast('La géolocalisation n’est pas disponible sur cet appareil.', 'error');
    return;
  }
  el.locate.disabled = true;
  el.locate.classList.add('is-busy');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      setPoint('origin', { address: await reverseGeocode(lat, lng), lat, lng });
      focusMapOn('origin');
      computeRoute();
      el.locate.disabled = false;
      el.locate.classList.remove('is-busy');
    },
    (err) => {
      const messages = {
        1: 'Géolocalisation refusée. Autorisez l’accès à votre position dans le navigateur, ou saisissez l’adresse.',
        2: 'Position introuvable pour le moment. Saisissez l’adresse de départ.',
        3: 'La géolocalisation a pris trop de temps. Réessayez ou saisissez l’adresse.',
      };
      callbacks.toast(messages[err.code] || messages[2], 'error');
      el.locate.disabled = false;
      el.locate.classList.remove('is-busy');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
}

function swapEndpoints() {
  [el.depart.value, el.arrivee.value] = [el.arrivee.value, el.depart.value];
  [state.origin, state.destination] = [state.destination, state.origin];
  // Les étapes sont parcourues dans l'autre sens
  state.waypoints.reverse().forEach((w) => el.waypoints.append(w.row));
  renumberWaypoints();
  syncMarkers();
  computeRoute();
}

/* ------------------------------------------------------------------ */
/* Itinéraires                                                          */
/* ------------------------------------------------------------------ */

export function setTransportMode(modeId) {
  if (state.modeId === modeId) return;
  state.modeId = modeId;
  computeRoute();
}

// Lieu transmis à computeRoutes : coordonnées si connues, sinon le texte saisi.
function routeLocation(key) {
  const p = pointOf(key);
  if (p?.lat != null) return { lat: p.lat, lng: p.lng };
  const text = inputOf(key)?.value.trim();
  return text || null;
}

async function requestRoutes(travelMode) {
  const origin = routeLocation('origin');
  const destination = routeLocation('destination');
  const intermediates = state.waypoints
    .map((w) => routeLocation(w.uid))
    .filter(Boolean)
    .map((location) => ({ location }));

  const request = {
    origin,
    destination,
    travelMode,
    fields: ['distanceMeters', 'durationMillis', 'path', 'viewport', 'description'],
    language: CONFIG.LANGUAGE,
    polylineQuality: 'OVERVIEW',
  };
  if (CONFIG.DEFAULT_COUNTRY) request.region = CONFIG.DEFAULT_COUNTRY;
  // Google ne calcule pas d'alternatives quand il y a des étapes intermédiaires.
  if (intermediates.length) request.intermediates = intermediates;
  else request.computeAlternativeRoutes = true;

  try {
    const { routes } = await state.libs.Route.computeRoutes(request);
    return (routes || []).filter((r) => r.path?.length);
  } catch (err) {
    console.warn(`computeRoutes (${travelMode})`, err);
    return [];
  }
}

export async function computeRoute() {
  if (!state.ready) return;
  const origin = routeLocation('origin');
  const destination = routeLocation('destination');
  if (!origin || !destination) { clearRoute(); return; }

  const mode = modeById(state.modeId);
  const wanted = mode?.travelMode || 'DRIVING';
  const requestId = ++state.requestId;
  setLoading(true);
  setStatus('');

  let routes = await requestRoutes(wanted);
  let fellBack = false;
  if (!routes.length && wanted !== 'DRIVING') {
    // Mode non disponible dans la zone (ex. pas de transports en commun) : on se rabat sur la voiture.
    routes = await requestRoutes('DRIVING');
    fellBack = routes.length > 0;
  }
  if (requestId !== state.requestId) return; // un calcul plus récent a été lancé
  setLoading(false);

  if (!routes.length) {
    clearRoute();
    setStatus('Aucun itinéraire trouvé entre ces points. Vérifiez les adresses, ou saisissez la distance à la main.', 'error');
    return;
  }

  state.routes = routes;
  state.selected = 0;

  // Les points saisis en texte libre récupèrent leurs coordonnées depuis le tracé.
  const path = routes[0].path.map(toLiteral);
  if (state.origin.lat == null) Object.assign(state.origin, path[0]);
  if (state.destination.lat == null) Object.assign(state.destination, path[path.length - 1]);
  syncMarkers();

  if (fellBack) {
    setStatus(`Le mode « ${mode.label} » n’est pas disponible pour ce trajet : itinéraire calculé en voiture. Vérifiez la distance et la durée.`, 'warning');
  } else if (mode && wanted === 'TRANSIT') {
    setStatus('Itinéraire en transports en commun (marche comprise). Ajustez si besoin.', 'info');
  } else if (!mode) {
    setStatus('Itinéraire calculé en voiture. Choisissez votre mode de transport pour l’affiner.', 'info');
  }

  drawRoutes();
  renderRouteCards();
  fitToRoute(routes[0]);
  emitRoute();
}

function drawRoutes() {
  state.polylines.forEach((p) => p.setMap(null));
  state.polylines = state.routes.map((route, i) => {
    const polyline = new state.libs.Polyline({
      map: state.map,
      path: route.path.map(toLiteral),
      clickable: true,
    });
    polyline.addListener('click', () => selectRoute(i));
    return polyline;
  });
  styleRoutes();
}

// L'itinéraire sélectionné est mis en évidence, les autres sont grisés.
function styleRoutes() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  state.polylines.forEach((p, i) => {
    const selected = i === state.selected;
    p.setOptions({
      strokeColor: selected ? (dark ? '#2dd4bf' : '#0f766e') : (dark ? '#8a9a94' : '#7b8a85'),
      strokeOpacity: selected ? 0.95 : 0.6,
      strokeWeight: selected ? 7 : 5,
      zIndex: selected ? 10 : 1,
    });
  });
}

function renderRouteCards() {
  const list = el.routesList;
  list.replaceChildren();
  el.routesFieldset.hidden = state.routes.length === 0;
  el.routesFieldset.querySelector('legend').textContent = state.routes.length > 1
    ? 'Itinéraire réellement emprunté'
    : 'Itinéraire';

  state.routes.forEach((route, i) => {
    const label = document.createElement('label');
    label.className = 'route-card';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'route_choice';
    radio.value = String(i);
    radio.checked = i === state.selected;
    radio.addEventListener('change', () => selectRoute(i));
    const title = document.createElement('span');
    title.className = 'route-title';
    title.textContent = route.description ? `Via ${route.description}` : `Itinéraire ${i + 1}`;
    const meta = document.createElement('span');
    meta.className = 'route-meta';
    const km = (route.distanceMeters || 0) / 1000;
    const min = (route.durationMillis || 0) / 60000;
    meta.textContent = `${km.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km · ${formatDuration(min)}`;
    label.append(radio, title, meta);
    list.append(label);
  });
}

function selectRoute(i) {
  if (!state.routes[i]) return;
  state.selected = i;
  styleRoutes();
  el.routesList.querySelectorAll('input').forEach((r, idx) => { r.checked = idx === i; });
  emitRoute();
}

function emitRoute() {
  const route = state.routes[state.selected];
  if (!route) { callbacks.onRouteChange(null); return; }
  callbacks.onRouteChange({
    distanceKm: Math.round((route.distanceMeters || 0) / 100) / 10, // 1 décimale
    durationMin: Math.max(1, Math.round((route.durationMillis || 0) / 60000)),
  });
}

function fitToRoute(route) {
  if (route.viewport) {
    state.map.fitBounds(route.viewport, 40);
  } else {
    const bounds = new google.maps.LatLngBounds();
    route.path.forEach((p) => bounds.extend(toLiteral(p)));
    state.map.fitBounds(bounds, 40);
  }
}

function clearRoute() {
  state.requestId++;
  state.routes = [];
  state.selected = 0;
  state.polylines.forEach((p) => p.setMap(null));
  state.polylines = [];
  el.routesList.replaceChildren();
  el.routesFieldset.hidden = true;
  setLoading(false);
  callbacks.onRouteChange(null);
}

function setLoading(on) {
  el.loading.hidden = !on;
  el.pane.setAttribute('aria-busy', String(on));
}

function setStatus(message, type = 'info') {
  el.status.textContent = message;
  el.status.dataset.type = type;
  el.status.hidden = !message;
}

/* ------------------------------------------------------------------ */
/* Données exposées au formulaire                                       */
/* ------------------------------------------------------------------ */

export function getGeoData() {
  const round = (v) => (v == null ? '' : Math.round(v * 1e6) / 1e6);
  const route = state.routes[state.selected];
  return {
    depart: { adresse: el.depart.value.trim(), lat: round(state.origin.lat), lng: round(state.origin.lng) },
    arrivee: { adresse: el.arrivee.value.trim(), lat: round(state.destination.lat), lng: round(state.destination.lng) },
    etapes: state.waypoints
      .filter((w) => w.input.value.trim())
      .map((w) => ({ adresse: w.input.value.trim(), lat: round(w.lat), lng: round(w.lng) })),
    polyline: route ? encodePath(route.path.map(toLiteral)) : '',
  };
}

export function resetMap() {
  el.depart.value = '';
  el.arrivee.value = '';
  state.origin = { lat: null, lng: null };
  state.destination = { lat: null, lng: null };
  state.waypoints.forEach((w) => w.row.remove());
  state.waypoints = [];
  renumberWaypoints();
  syncMarkers();
  clearRoute();
  setStatus('');
  if (state.ready) {
    el.hint.textContent = 'Touchez la carte pour placer le départ, puis l’arrivée.';
    state.map.setCenter(CONFIG.DEFAULT_CENTER);
    state.map.setZoom(CONFIG.DEFAULT_ZOOM);
  }
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                          */
/* ------------------------------------------------------------------ */

// Accepte LatLng (méthodes), LatLngAltitude ou littéral (propriétés).
function toLiteral(p) {
  return typeof p.lat === 'function' ? { lat: p.lat(), lng: p.lng() } : { lat: p.lat, lng: p.lng };
}

function formatDuration(min) {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

/**
 * Encode un tracé au format « Encoded Polyline » de Google (précision 1e-5).
 * Le résultat est limité à 30 000 caractères (une cellule Excel en accepte 32 767) :
 * au-delà, on garde un point sur deux, jusqu'à passer sous la limite.
 */
export function encodePath(points, maxLength = 30000) {
  let pts = points;
  let encoded = encode(pts);
  while (encoded.length > maxLength && pts.length > 2) {
    pts = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
    encoded = encode(pts);
  }
  return encoded;

  function encode(list) {
    let prevLat = 0;
    let prevLng = 0;
    let out = '';
    for (const { lat, lng } of list) {
      const iLat = Math.round(lat * 1e5);
      const iLng = Math.round(lng * 1e5);
      out += encodeSigned(iLat - prevLat) + encodeSigned(iLng - prevLng);
      prevLat = iLat;
      prevLng = iLng;
    }
    return out;
  }
  function encodeSigned(value) {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return out + String.fromCharCode(v + 63);
  }
}
