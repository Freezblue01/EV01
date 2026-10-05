// form.js — Formulaire : champs, validation, calcul du CO₂, envoi et file d'attente hors ligne.

import {
  CONFIG, TRANSPORT_MODES, MOTIFS, COLUMNS,
  modeById, motifById, computeCo2, formatKm, formatKg, formatMin,
} from './config.js';
import { addEntry, updateEntry } from './history.js';

const STORAGE = { pseudo: 'mobilite.pseudo', queue: 'mobilite.fileAttente' };

// Étape (mobile) à laquelle appartient chaque champ, pour y revenir en cas d'erreur.
const FIELD_STEP = {
  depart: 1, arrivee: 1, mode: 1, passagers: 1,
  utilisateur: 2, date: 2, heure: 2, distance: 2, duree: 2, motif: 2, commentaire: 2,
};
const STEP_FIELDS = { 1: ['depart', 'arrivee', 'mode', 'passagers'], 2: ['utilisateur', 'date', 'heure', 'distance', 'duree', 'motif', 'commentaire'], 3: [] };

const form = document.getElementById('trip-form');
const f = form.elements;
const $ = (id) => document.getElementById(id);

// Valeurs calculées par la carte (aller simple) et indicateurs « modifiée à la main ».
const auto = { distance: null, duree: null };
const modified = { distance: false, duree: false };

let deps = { getGeoData: () => null, resetMap() {}, onModeChange() {}, goToStep() {}, toast() {} };
let flushing = false;

/* ------------------------------------------------------------------ */
/* Initialisation                                                       */
/* ------------------------------------------------------------------ */

export function initForm(options) {
  deps = { ...deps, ...options };
  renderModeTiles();
  fillSelects();
  setDefaults();
  bindEvents();
  updateDerived();
  updateQueueHint();
}

function renderModeTiles() {
  const container = $('mode-tiles');
  container.innerHTML = TRANSPORT_MODES.map((m) => `
    <label class="tile">
      <input type="radio" name="mode" value="${m.id}">
      <span class="tile-icon" aria-hidden="true">${m.icon}</span>
      <span class="tile-label">${m.label}</span>
    </label>`).join('');
}

function fillSelects() {
  f.motif.insertAdjacentHTML('beforeend', MOTIFS.map((m) => `<option value="${m.id}">${m.label}</option>`).join(''));
  const freq = ['<option value="0">Ponctuel</option>'];
  for (let d = 1; d <= 7; d++) freq.push(`<option value="${d}">${d} jour${d > 1 ? 's' : ''} par semaine</option>`);
  f.frequence.innerHTML = freq.join('');
}

const pad = (n) => String(n).padStart(2, '0');
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function setDefaults() {
  f.utilisateur.value = readStorage(STORAGE.pseudo, '');
  f.date.value = todayIso();
  f.date.max = todayIso();
  const now = new Date();
  const minutes = Math.floor(now.getMinutes() / 5) * 5; // arrondi aux 5 minutes
  f.heure.value = `${pad(now.getHours())}:${pad(minutes)}`;
  f.passagers.value = 1;
  f.frequence.value = '0';
}

function bindEvents() {
  // Toute modification met à jour le récapitulatif et le CO₂.
  form.addEventListener('input', onAnyChange);
  form.addEventListener('change', onAnyChange);

  $('mode-tiles').addEventListener('change', onModeChange);

  document.querySelectorAll('[data-step-passengers]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = clampInt(Number(f.passagers.value) + Number(btn.dataset.stepPassengers), 1, 9);
      f.passagers.value = next;
      f.passagers.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  // Distance et durée : détection d'une saisie manuelle.
  for (const name of ['distance', 'duree']) {
    f[name].addEventListener('input', () => {
      const value = parseFloat(f[name].value);
      modified[name] = auto[name] == null ? f[name].value !== '' : Math.abs(value - auto[name]) > (name === 'distance' ? 0.05 : 0.5);
      updateModifiedBadges();
    });
    $(`${name}-reset`).addEventListener('click', () => {
      f[name].value = auto[name];
      modified[name] = false;
      updateModifiedBadges();
      onAnyChange({ target: f[name] });
      f[name].focus();
    });
  }

  f.commentaire.addEventListener('input', () => {
    $('commentaire-count').textContent = `${f.commentaire.value.length} / 500`;
  });

  form.addEventListener('submit', onSubmit);
}

function onAnyChange(e) {
  // Un champ en erreur est revalidé dès qu'il change.
  const name = e?.target?.name;
  if (name && FIELD_STEP[name] && document.getElementById(`${name}-error`)?.textContent) validateField(name);
  updateDerived();
}

function onModeChange() {
  const mode = modeById(getModeId());
  const shared = Boolean(mode?.shared);
  $('passagers-field').hidden = !shared;
  if (shared && mode.defaultPassengers && Number(f.passagers.value) < mode.defaultPassengers) {
    f.passagers.value = mode.defaultPassengers;
  }
  deps.onModeChange(mode?.id || null);
  updateDerived();
}

const getModeId = () => form.querySelector('input[name="mode"]:checked')?.value || '';
const isRoundTrip = () => form.querySelector('input[name="type_trajet"]:checked')?.value === 'aller_retour';
const clampInt = (n, min, max) => Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));

/* ------------------------------------------------------------------ */
/* Valeurs venant de la carte                                           */
/* ------------------------------------------------------------------ */

// Appelée par la carte à chaque nouvel itinéraire (ou null si le tracé est effacé).
export function setRouteValues(values) {
  auto.distance = values ? values.distanceKm : null;
  auto.duree = values ? values.durationMin : null;
  for (const name of ['distance', 'duree']) {
    if (!modified[name]) f[name].value = auto[name] ?? '';
    else if (auto[name] != null && Math.abs(parseFloat(f[name].value) - auto[name]) < 0.05) modified[name] = false;
  }
  updateModifiedBadges();
  if (values) {
    for (const name of ['distance', 'duree']) if ($(`${name}-error`).textContent) validateField(name);
  }
  updateDerived();
}

function updateModifiedBadges() {
  for (const name of ['distance', 'duree']) {
    const show = modified[name] && auto[name] != null;
    $(`${name}-modified`).hidden = !show;
    $(`${name}-reset`).hidden = !show;
  }
}

/* ------------------------------------------------------------------ */
/* Calculs dérivés : totaux, CO₂, récapitulatif                         */
/* ------------------------------------------------------------------ */

function getTotals() {
  const oneWayKm = parseFloat(f.distance.value);
  const oneWayMin = parseFloat(f.duree.value);
  const factor = isRoundTrip() ? 2 : 1;
  const modeId = getModeId();
  const persons = modeById(modeId)?.shared ? clampInt(Number(f.passagers.value), 1, 9) : null;
  const distanceKm = Number.isFinite(oneWayKm) ? Math.round(oneWayKm * factor * 10) / 10 : null;
  const durationMin = Number.isFinite(oneWayMin) ? Math.round(oneWayMin * factor) : null;
  const co2 = modeId && distanceKm != null ? computeCo2(modeId, distanceKm, persons || 1) : null;
  return { distanceKm, durationMin, persons, co2, factor };
}

function updateDerived() {
  const t = getTotals();
  const modeId = getModeId();
  const freq = Number(f.frequence.value) || 0;

  // Indication aller-retour
  const arHint = $('ar-hint');
  arHint.hidden = !(isRoundTrip() && t.distanceKm != null);
  if (!arHint.hidden) {
    arHint.textContent = `Total aller-retour : ${formatKm(t.distanceKm)}${t.durationMin != null ? ` · ${formatMin(t.durationMin)}` : ''}`;
  }

  // CO₂ dans l'étape 2 et la carte récapitulative
  let co2Text = '—';
  let co2Sub = '';
  if (!modeId) co2Sub = 'Choisissez un mode de transport.';
  else if (t.distanceKm == null) co2Sub = 'Indiquez la distance.';
  else if (t.co2 == null) co2Sub = 'Pas d’estimation pour le mode « Autre ».';
  else {
    co2Text = `${formatKg(t.co2)} CO₂`;
    const parts = [];
    if (t.persons > 1) parts.push(`part par personne (${t.persons} à bord)`);
    if (isRoundTrip()) parts.push('aller-retour');
    if (freq > 0) parts.push(`≈ ${formatKg(Math.round(t.co2 * freq * 100) / 100)} par semaine`);
    co2Sub = parts.join(' · ');
  }
  $('co2-value').textContent = co2Text;
  $('co2-sub').textContent = co2Sub;
  $('co2-inline').textContent = t.co2 != null ? `Émissions estimées : ${formatKg(t.co2)} CO₂` : '';

  renderRecap(t);
}

function renderRecap(t) {
  const geo = deps.getGeoData() || { etapes: [] };
  const mode = modeById(getModeId());
  const motif = motifById(f.motif.value);
  const freq = Number(f.frequence.value) || 0;
  const rows = [
    ['Utilisateur', f.utilisateur.value.trim()],
    ['Date', f.date.value ? `${new Date(`${f.date.value}T00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${f.heure.value ? ` à ${f.heure.value.replace(':', ' h ')}` : ''}` : ''],
    ['Départ', f.depart.value.trim()],
    ...geo.etapes.map((e, i) => [`Étape ${i + 1}`, e.adresse]),
    ['Arrivée', f.arrivee.value.trim()],
    ['Mode', mode ? `${mode.label}${t.persons ? ` · ${t.persons} pers.` : ''}` : ''],
    ['Distance', t.distanceKm != null ? `${formatKm(t.distanceKm)}${isRoundTrip() ? ' (aller-retour)' : ''}${modified.distance && auto.distance != null ? ' · modifiée' : ''}` : ''],
    ['Durée', t.durationMin != null ? formatMin(t.durationMin) : ''],
    ['Motif', motif?.label || ''],
    ['Fréquence', freq ? `${freq} j / semaine` : 'Ponctuel'],
  ];
  if (f.commentaire.value.trim()) rows.push(['Commentaire', f.commentaire.value.trim()]);

  const dl = $('recap');
  dl.replaceChildren();
  for (const [label, value] of rows) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value || '—';
    if (!value) dd.classList.add('is-missing');
    div.append(dt, dd);
    dl.append(div);
  }
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

const validators = {
  depart: () => (f.depart.value.trim() ? '' : 'Indiquez le point de départ.'),
  arrivee: () => (f.arrivee.value.trim() ? '' : 'Indiquez le point d’arrivée.'),
  mode: () => (getModeId() ? '' : 'Choisissez un mode de transport.'),
  passagers: () => {
    if (!modeById(getModeId())?.shared) return '';
    const n = Number(f.passagers.value);
    return Number.isInteger(n) && n >= 1 && n <= 9 ? '' : 'Indiquez entre 1 et 9 personnes.';
  },
  utilisateur: () => {
    const v = f.utilisateur.value.trim();
    if (!v) return 'Indiquez votre identifiant ou pseudo.';
    return v.length <= 60 ? '' : '60 caractères maximum.';
  },
  date: () => {
    const v = f.date.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Indiquez la date du trajet.';
    if (v > todayIso()) return 'La date ne peut pas être dans le futur.';
    return v < '2000-01-01' ? 'Date invalide.' : '';
  },
  heure: () => (/^\d{2}:\d{2}$/.test(f.heure.value) ? '' : 'Indiquez l’heure de départ.'),
  distance: () => {
    const n = parseFloat(f.distance.value);
    return Number.isFinite(n) && n >= 0.1 && n <= 2000 ? '' : 'Indiquez une distance entre 0,1 et 2 000 km.';
  },
  duree: () => {
    const n = parseFloat(f.duree.value);
    return Number.isFinite(n) && n >= 1 && n <= 1440 ? '' : 'Indiquez une durée entre 1 et 1 440 minutes.';
  },
  motif: () => (motifById(f.motif.value) ? '' : 'Choisissez un motif.'),
  commentaire: () => (f.commentaire.value.length <= 500 ? '' : '500 caractères maximum.'),
};

function setFieldError(name, message) {
  const errorEl = $(`${name}-error`);
  if (errorEl) errorEl.textContent = message;
  const target = name === 'mode' ? $('mode-fieldset') : f[name];
  if (target && target.setAttribute) {
    if (message) target.setAttribute('aria-invalid', 'true');
    else target.removeAttribute('aria-invalid');
  }
}

function validateField(name) {
  const message = validators[name]?.() || '';
  setFieldError(name, message);
  return !message;
}

// Valide une étape (mobile). Renvoie le nom du premier champ invalide, ou null.
export function validateStep(step) {
  let firstInvalid = null;
  for (const name of STEP_FIELDS[step] || []) {
    if (!validateField(name) && !firstInvalid) firstInvalid = name;
  }
  if (firstInvalid) focusField(firstInvalid);
  return firstInvalid;
}

function validateAll() {
  let firstInvalid = null;
  for (const name of Object.keys(validators)) {
    if (!validateField(name) && !firstInvalid) firstInvalid = name;
  }
  return firstInvalid;
}

function focusField(name) {
  const target = name === 'mode' ? form.querySelector('input[name="mode"]') : f[name];
  target?.focus({ preventScroll: false });
}

function clearErrors() {
  Object.keys(validators).forEach((name) => setFieldError(name, ''));
}

/* ------------------------------------------------------------------ */
/* Construction de la ligne envoyée                                     */
/* ------------------------------------------------------------------ */

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Repli pour les contextes non sécurisés (http://adresse-ip en test)
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function buildPayload() {
  const geo = deps.getGeoData();
  const t = getTotals();
  return {
    client_id: uuid(), // sert d'identifiant et évite les doublons lors des renvois
    utilisateur: f.utilisateur.value.trim(),
    date: f.date.value,
    heure_depart: f.heure.value,
    depart_adresse: geo.depart.adresse,
    depart_lat: geo.depart.lat,
    depart_lng: geo.depart.lng,
    arrivee_adresse: geo.arrivee.adresse,
    arrivee_lat: geo.arrivee.lat,
    arrivee_lng: geo.arrivee.lng,
    etapes: geo.etapes.map((e) => (e.lat !== '' ? `${e.adresse} (${e.lat}, ${e.lng})` : e.adresse)).join(' | '),
    mode_transport: getModeId(),
    passagers: t.persons ?? '',
    distance_km: t.distanceKm, // total : doublé en aller-retour
    duree_min: t.durationMin, // total : doublé en aller-retour
    distance_modifiee: auto.distance == null ? true : modified.distance,
    motif: f.motif.value,
    aller_retour: isRoundTrip(),
    frequence_jours_semaine: Number(f.frequence.value) || 0,
    co2_kg: t.co2 ?? '',
    commentaire: f.commentaire.value.trim(),
    polyline: geo.polyline,
  };
}

// Ligne d'historique : mêmes colonnes que le tableur + statut local.
function toHistoryEntry(payload, { id, horodatage = '', statut }) {
  const entry = {};
  for (const col of COLUMNS) entry[col] = payload[col] ?? '';
  entry.id = id;
  entry.horodatage = horodatage;
  entry.statut = statut;
  return entry;
}

/* ------------------------------------------------------------------ */
/* Envoi                                                                */
/* ------------------------------------------------------------------ */

async function onSubmit(e) {
  e.preventDefault();
  const invalid = validateAll();
  if (invalid) {
    deps.goToStep(FIELD_STEP[invalid] || 1, { focus: false });
    focusField(invalid);
    deps.toast('Certains champs sont à compléter ou à corriger.', 'error');
    return;
  }

  const payload = buildPayload();
  writeStorage(STORAGE.pseudo, payload.utilisateur);
  setSubmitting(true);
  const result = await sendTrip(payload);
  setSubmitting(false);

  if (result.ok) {
    addEntry(toHistoryEntry(payload, { id: result.id, horodatage: result.horodatage, statut: 'envoye' }));
    deps.toast('Trajet envoyé. Merci !', 'success');
    resetForm();
  } else if (result.retry) {
    // Échec réseau ou serveur momentanément indisponible : on garde le trajet pour plus tard.
    enqueue(payload);
    addEntry(toHistoryEntry(payload, { id: payload.client_id, statut: 'en_attente' }));
    deps.toast('Envoi impossible pour le moment : le trajet est en file d’attente et partira automatiquement.', 'warning', 7000);
    resetForm();
  } else {
    (result.details || []).forEach(({ field, message }) => {
      const name = { heure_depart: 'heure', distance_km: 'distance', duree_min: 'duree', mode_transport: 'mode', depart_adresse: 'depart', arrivee_adresse: 'arrivee' }[field] || field;
      if (validators[name]) setFieldError(name, message);
    });
    deps.toast(result.error || 'Le trajet a été refusé par le serveur.', 'error', 7000);
  }
}

// POST vers la Netlify Function. `retry: true` = l'envoi peut être retenté plus tard.
async function sendTrip(payload) {
  if (!navigator.onLine) return { ok: false, retry: true };
  try {
    const res = await fetch(CONFIG.SUBMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data = {};
    try { data = await res.json(); } catch { /* réponse non JSON */ }
    if (res.ok && data.ok) return { ok: true, id: data.id, horodatage: data.horodatage };
    if (res.status >= 500 || res.status === 404 || res.status === 429) return { ok: false, retry: true, error: data.error };
    return { ok: false, retry: false, error: data.error, details: data.details };
  } catch {
    return { ok: false, retry: true }; // réseau coupé, DNS, etc.
  }
}

function setSubmitting(on) {
  const btn = $('btn-submit');
  btn.disabled = on;
  btn.setAttribute('aria-busy', String(on));
  btn.querySelector('.spinner').hidden = !on;
  btn.querySelector('.btn-label').textContent = on ? 'Envoi en cours…' : 'Envoyer le trajet';
}

export function resetForm() {
  const pseudo = f.utilisateur.value;
  form.reset();
  setDefaults();
  f.utilisateur.value = pseudo;
  auto.distance = auto.duree = null;
  modified.distance = modified.duree = false;
  updateModifiedBadges();
  clearErrors();
  $('commentaire-count').textContent = '0 / 500';
  deps.resetMap();
  onModeChange();
  deps.goToStep(1); // retour en haut, focus sur le titre de l'étape 1
}

/* ------------------------------------------------------------------ */
/* File d'attente hors ligne                                            */
/* ------------------------------------------------------------------ */

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (key === STORAGE.pseudo ? raw : JSON.parse(raw));
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch { /* stockage plein ou désactivé */ }
}

const readQueue = () => readStorage(STORAGE.queue, []);

function enqueue(payload) {
  writeStorage(STORAGE.queue, [...readQueue(), payload]);
  updateQueueHint();
}

function removeFromQueue(clientId) {
  writeStorage(STORAGE.queue, readQueue().filter((p) => p.client_id !== clientId));
  updateQueueHint();
}

// Supprime un trajet de la file (appelé quand on le supprime de l'historique).
export function cancelQueued(id) {
  removeFromQueue(id);
}

export const queueLength = () => readQueue().length;

function updateQueueHint() {
  const n = readQueue().length;
  const hint = $('queue-hint');
  hint.hidden = n === 0;
  hint.textContent = n ? `${n} trajet${n > 1 ? 's' : ''} en attente d’envoi.` : '';
  $('btn-retry').hidden = n === 0;
}

// Renvoie les trajets en attente, un par un, en s'arrêtant au premier échec réseau.
export async function flushQueue({ manual = false } = {}) {
  if (flushing) return;
  const queue = readQueue();
  if (!queue.length) return;
  if (!navigator.onLine) {
    if (manual) deps.toast('Toujours hors ligne. Les trajets partiront au retour de la connexion.', 'warning');
    return;
  }
  flushing = true;
  let sent = 0;
  let failed = false;
  try {
    for (const payload of queue) {
      const result = await sendTrip(payload);
      if (result.ok) {
        removeFromQueue(payload.client_id);
        updateEntry(payload.client_id, { id: result.id, horodatage: result.horodatage, statut: 'envoye' });
        sent++;
      } else if (result.retry) {
        failed = true;
        break;
      } else {
        // Refus définitif (données invalides) : on le retire de la file et on le signale.
        removeFromQueue(payload.client_id);
        updateEntry(payload.client_id, { statut: 'erreur' });
      }
    }
  } finally {
    flushing = false;
  }
  if (sent) deps.toast(`${sent} trajet${sent > 1 ? 's' : ''} en attente ${sent > 1 ? 'ont été envoyés' : 'a été envoyé'}.`, 'success');
  else if (manual && failed) deps.toast('Le serveur ne répond pas encore. Nouvel essai automatique plus tard.', 'warning');
}
