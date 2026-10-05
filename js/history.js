// history.js — Historique local des trajets (localStorage) et export Excel avec SheetJS.

import { CONFIG, COLUMNS, modeById, motifById, formatKm, formatKg, formatMin } from './config.js';

const KEY = 'mobilite.historique';
const $ = (id) => document.getElementById(id);

let deps = { toast() {}, onDelete() {}, onRetry() {} };

export function initHistory(options) {
  deps = { ...deps, ...options };
  $('btn-export').addEventListener('click', exportExcel);
  $('btn-retry').addEventListener('click', () => deps.onRetry());
  // Délégation : un seul écouteur pour tous les boutons « Supprimer »
  $('history-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delete]');
    if (btn) deleteEntry(btn.dataset.delete);
  });
  renderHistory();
}

/* ------------------------------------------------------------------ */
/* Stockage                                                             */
/* ------------------------------------------------------------------ */

export function getHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    deps.toast('Impossible d’enregistrer l’historique sur cet appareil (stockage plein ou désactivé).', 'error');
  }
}

export function addEntry(entry) {
  save([entry, ...getHistory().filter((e) => e.id !== entry.id)]);
  renderHistory();
}

export function updateEntry(id, patch) {
  save(getHistory().map((e) => (e.id === id ? { ...e, ...patch } : e)));
  renderHistory();
}

function deleteEntry(id) {
  const entry = getHistory().find((e) => e.id === id);
  if (!entry) return;
  const pending = entry.statut === 'en_attente';
  const message = pending
    ? 'Ce trajet n’a pas encore été envoyé. Le supprimer annule son envoi. Continuer ?'
    : 'Supprimer ce trajet de l’historique de cet appareil ? (Il reste enregistré dans le tableur partagé.)';
  if (!window.confirm(message)) return;
  save(getHistory().filter((e) => e.id !== id));
  if (pending) deps.onDelete(id);
  renderHistory();
  deps.toast('Trajet supprimé de l’historique.', 'info');
  $('history-title').focus();
}

/* ------------------------------------------------------------------ */
/* Affichage                                                            */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Bornes de la semaine (du lundi au dimanche) et du mois en cours, au format AAAA-MM-JJ.
function periods() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { weekStart: iso(monday), weekEnd: iso(sunday), monthPrefix: iso(today).slice(0, 7) };
}

function sum(entries) {
  return entries.reduce(
    (acc, e) => ({ km: acc.km + (Number(e.distance_km) || 0), co2: acc.co2 + (Number(e.co2_kg) || 0) }),
    { km: 0, co2: 0 },
  );
}

const STATUS = {
  envoye: { label: 'Envoyé', cls: 'ok' },
  en_attente: { label: 'En attente', cls: 'pending' },
  erreur: { label: 'Refusé', cls: 'error' },
};

export function renderHistory() {
  const list = getHistory();
  const counted = list.filter((e) => e.statut !== 'erreur');
  const { weekStart, weekEnd, monthPrefix } = periods();
  const week = sum(counted.filter((e) => e.date >= weekStart && e.date <= weekEnd));
  const month = sum(counted.filter((e) => String(e.date).startsWith(monthPrefix)));

  $('stat-week-km').textContent = formatKm(week.km);
  $('stat-week-co2').textContent = `${formatKg(week.co2)} CO₂`;
  $('stat-month-km').textContent = formatKm(month.km);
  $('stat-month-co2').textContent = `${formatKg(month.co2)} CO₂`;

  const count = $('history-count');
  count.hidden = list.length === 0;
  count.textContent = String(list.length);

  $('history-empty').hidden = list.length > 0;
  $('btn-export').disabled = list.length === 0;

  // Tri : trajets les plus récents d'abord
  const sorted = [...list].sort((a, b) => `${b.date} ${b.heure_depart}`.localeCompare(`${a.date} ${a.heure_depart}`));
  const ul = $('history-list');
  ul.replaceChildren(...sorted.map(renderItem));
}

function renderItem(e) {
  const mode = modeById(e.mode_transport);
  const status = STATUS[e.statut] || STATUS.envoye;
  const li = document.createElement('li');
  li.className = 'history-item';

  const date = e.date
    ? new Date(`${e.date}T00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })
    : '';

  const head = document.createElement('div');
  head.className = 'hi-head';
  const icon = document.createElement('span');
  icon.className = 'hi-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = mode?.icon || '•';
  const when = document.createElement('span');
  when.className = 'hi-when';
  when.textContent = `${date} · ${e.heure_depart || ''}`;
  const badge = document.createElement('span');
  badge.className = `status status--${status.cls}`;
  badge.textContent = status.label;
  head.append(icon, when, badge);

  const route = document.createElement('p');
  route.className = 'hi-route';
  route.textContent = `${e.depart_adresse} → ${e.arrivee_adresse}`;

  const meta = document.createElement('p');
  meta.className = 'hi-meta';
  const parts = [
    mode?.label || e.mode_transport,
    formatKm(Number(e.distance_km) || 0) + (e.aller_retour === true ? ' (A/R)' : ''),
    formatMin(Number(e.duree_min)),
    e.co2_kg !== '' && e.co2_kg != null ? `${formatKg(Number(e.co2_kg))} CO₂` : null,
    motifById(e.motif)?.label,
  ].filter(Boolean);
  meta.textContent = parts.join(' · ');

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn-icon btn-delete';
  del.dataset.delete = e.id;
  del.setAttribute('aria-label', `Supprimer le trajet du ${date} de l'historique`);
  del.title = 'Supprimer';
  del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';

  li.append(head, route, meta, del);
  return li;
}

/* ------------------------------------------------------------------ */
/* Export Excel                                                         */
/* ------------------------------------------------------------------ */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error(`Échec du chargement : ${src}`)); };
    document.head.append(s);
  });
}

// SheetJS n'est chargé qu'au premier export, pour alléger la page.
async function loadXlsx() {
  if (window.XLSX) return window.XLSX;
  for (const src of CONFIG.XLSX_SOURCES) {
    try {
      await loadScript(src);
      if (window.XLSX) return window.XLSX;
    } catch (err) {
      console.warn(err);
    }
  }
  throw new Error('Bibliothèque Excel indisponible');
}

async function exportExcel() {
  const list = getHistory();
  if (!list.length) return;
  const btn = $('btn-export');
  btn.disabled = true;
  btn.querySelector('.spinner').hidden = false;
  try {
    const XLSX = await loadXlsx();
    // Ordre chronologique, mêmes colonnes que le tableur partagé.
    const sorted = [...list].sort((a, b) => `${a.date} ${a.heure_depart}`.localeCompare(`${b.date} ${b.heure_depart}`));
    const rows = sorted.map((e) => COLUMNS.map((col) => (e[col] == null ? '' : e[col])));
    const ws = XLSX.utils.aoa_to_sheet([COLUMNS, ...rows]);

    // En-têtes en gras (pris en compte par xlsx-js-style ; ignoré sans risque par SheetJS standard)
    COLUMNS.forEach((_, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      if (cell) {
        cell.s = {
          font: { bold: true, color: { rgb: '0B3D38' } },
          fill: { patternType: 'solid', fgColor: { rgb: 'D9F0EC' } },
          border: { bottom: { style: 'thin', color: { rgb: '7FB8AF' } } },
        };
      }
    });

    // Largeur de chaque colonne ajustée à son contenu le plus long (bornée)
    ws['!cols'] = COLUMNS.map((col, c) => {
      const longest = Math.max(col.length, ...rows.map((r) => String(r[c]).length));
      const max = col === 'polyline' ? 30 : 50;
      return { wch: Math.min(max, longest + 2) };
    });
    ws['!autofilter'] = { ref: ws['!ref'] };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Trajets');
    XLSX.writeFile(wb, `mes-trajets-${iso(new Date())}.xlsx`);
    deps.toast('Fichier Excel généré.', 'success');
  } catch (err) {
    console.error(err);
    deps.toast('L’export Excel a échoué. Vérifiez votre connexion et réessayez.', 'error');
  } finally {
    btn.disabled = false;
    btn.querySelector('.spinner').hidden = true;
  }
}
