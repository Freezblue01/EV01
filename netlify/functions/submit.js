// netlify/functions/submit.js — Reçoit un trajet, le valide, puis le transmet au Google Apps Script.
// Node 18+ (fetch natif). Variables d'environnement Netlify requises :
//   SHEET_WEBHOOK_URL : URL de l'application Web Apps Script (…/exec)
//   SHEET_SECRET      : jeton partagé, identique à la propriété de script SHEET_SECRET

const { randomUUID } = require('node:crypto');

// Ordre des colonnes du tableur (identique à js/config.js et apps-script/Code.gs)
const COLUMNS = [
  'id', 'horodatage', 'utilisateur', 'date', 'heure_depart',
  'depart_adresse', 'depart_lat', 'depart_lng',
  'arrivee_adresse', 'arrivee_lat', 'arrivee_lng',
  'etapes', 'mode_transport', 'passagers', 'distance_km', 'duree_min', 'distance_modifiee',
  'motif', 'aller_retour', 'frequence_jours_semaine', 'co2_kg', 'commentaire', 'polyline',
];

const MODES = [
  'marche', 'velo', 'velo_electrique', 'trottinette', 'moto', 'voiture_thermique',
  'voiture_electrique', 'covoiturage', 'bus', 'tram', 'train', 'autre',
];
const SHARED_MODES = ['voiture_thermique', 'voiture_electrique', 'covoiturage'];
const MOTIFS = ['domicile_travail', 'domicile_etudes', 'courses', 'loisirs', 'professionnel', 'autre'];

const MAX_BODY = 100 * 1024; // 100 Ko
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Méthode non autorisée.' }, { Allow: 'POST' });
  }

  const { SHEET_WEBHOOK_URL, SHEET_SECRET } = process.env;
  if (!SHEET_WEBHOOK_URL || !SHEET_SECRET) {
    console.error('SHEET_WEBHOOK_URL ou SHEET_SECRET manquant dans les variables d’environnement.');
    return json(500, { ok: false, error: 'Le serveur n’est pas encore configuré.' });
  }

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Requête trop volumineuse.' });

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: 'Corps de requête JSON invalide.' });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return json(400, { ok: false, error: 'Corps de requête invalide.' });
  }

  const { errors, row } = validate(data);
  if (errors.length) {
    return json(422, { ok: false, error: 'Certaines données sont invalides.', details: errors });
  }

  // Identifiant : celui du client s'il s'agit d'un UUID v4 (évite les doublons lors des renvois
  // hors ligne), sinon un nouveau. Horodatage : toujours celui du serveur.
  row.id = typeof data.client_id === 'string' && UUID_RE.test(data.client_id) ? data.client_id.toLowerCase() : randomUUID();
  row.horodatage = new Date().toISOString();

  // Apps Script peut être lent au premier appel : on coupe à 9 s (limite Netlify par défaut : 10 s).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SHEET_SECRET, row: protectForSheet(row) }),
      redirect: 'follow', // Apps Script répond via une redirection 302 vers googleusercontent.com
      signal: controller.signal,
    });
    const text = await res.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      console.error('Réponse Apps Script non JSON', res.status, text.slice(0, 300));
      return json(502, { ok: false, error: 'Le tableur n’a pas répondu correctement.' });
    }
    if (!res.ok || !result.ok) {
      console.error('Erreur Apps Script', res.status, result);
      return json(502, { ok: false, error: 'Le tableur a refusé l’enregistrement.' });
    }
    return json(200, { ok: true, id: row.id, horodatage: row.horodatage, duplicate: Boolean(result.duplicate) });
  } catch (err) {
    const timeout = err.name === 'AbortError';
    console.error('Échec de l’appel Apps Script', err);
    return json(timeout ? 504 : 502, {
      ok: false,
      error: timeout ? 'Le tableur met trop de temps à répondre.' : 'Impossible de joindre le tableur.',
    });
  } finally {
    clearTimeout(timer);
  }
};

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

function validate(d) {
  const errors = [];
  const row = {};
  const fail = (field, message) => errors.push({ field, message });

  const str = (field, { required = false, max = 300 } = {}) => {
    const v = d[field] == null ? '' : String(d[field]).trim();
    if (required && !v) fail(field, 'Champ obligatoire.');
    else if (v.length > max) fail(field, `${max} caractères maximum.`);
    row[field] = v.slice(0, max);
  };

  const num = (field, { required = false, min, max, integer = false, decimals } = {}) => {
    const empty = d[field] === '' || d[field] == null;
    if (empty) {
      if (required) fail(field, 'Champ obligatoire.');
      row[field] = '';
      return;
    }
    const n = Number(d[field]);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      fail(field, `Valeur attendue entre ${min} et ${max}.`);
      row[field] = '';
      return;
    }
    row[field] = decimals != null ? Math.round(n * 10 ** decimals) / 10 ** decimals : n;
  };

  const bool = (field) => {
    row[field] = d[field] === true || d[field] === 'true';
  };

  str('utilisateur', { required: true, max: 60 });

  const date = String(d.date || '');
  const parsed = new Date(`${date}T00:00:00Z`);
  const tomorrow = new Date(Date.now() + 36 * 3600 * 1000); // marge pour les fuseaux horaires
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    fail('date', 'Date invalide (format AAAA-MM-JJ).');
  } else if (parsed > tomorrow || date < '2000-01-01') {
    fail('date', 'Date hors de la période acceptée.');
  }
  row.date = date;

  const heure = String(d.heure_depart || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(heure)) fail('heure_depart', 'Heure invalide (format HH:MM).');
  row.heure_depart = heure;

  str('depart_adresse', { required: true });
  num('depart_lat', { min: -90, max: 90, decimals: 6 });
  num('depart_lng', { min: -180, max: 180, decimals: 6 });
  str('arrivee_adresse', { required: true });
  num('arrivee_lat', { min: -90, max: 90, decimals: 6 });
  num('arrivee_lng', { min: -180, max: 180, decimals: 6 });
  str('etapes', { max: 1200 });

  const mode = String(d.mode_transport || '');
  if (!MODES.includes(mode)) fail('mode_transport', 'Mode de transport inconnu.');
  row.mode_transport = mode;

  if (SHARED_MODES.includes(mode)) num('passagers', { required: true, min: 1, max: 9, integer: true });
  else row.passagers = '';

  num('distance_km', { required: true, min: 0.1, max: 4000, decimals: 1 }); // 2 000 km × 2 en aller-retour
  num('duree_min', { required: true, min: 1, max: 2880, integer: true });
  bool('distance_modifiee');

  const motif = String(d.motif || '');
  if (!MOTIFS.includes(motif)) fail('motif', 'Motif inconnu.');
  row.motif = motif;

  bool('aller_retour');
  num('frequence_jours_semaine', { required: true, min: 0, max: 7, integer: true });
  num('co2_kg', { min: 0, max: 5000, decimals: 2 });
  str('commentaire', { max: 500 });

  const polyline = d.polyline == null ? '' : String(d.polyline);
  if (polyline.length > 30000 || /[^\x3f-\x7e]/.test(polyline)) fail('polyline', 'Tracé invalide.');
  row.polyline = polyline;

  // On ne garde que les colonnes connues, dans l'ordre
  const ordered = {};
  for (const col of COLUMNS) if (col in row) ordered[col] = row[col];
  return { errors, row: ordered };
}

// Empêche l'injection de formules dans le tableur : un texte commençant par = + - @
// est préfixé d'une apostrophe, que Google Sheets interprète comme « texte brut » (elle n'apparaît pas).
function protectForSheet(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  }
  return out;
}
