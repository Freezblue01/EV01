// app.js — Point d'entrée : onglets, navigation entre étapes (mobile), notifications et liaisons entre modules.

import { initMap, setTransportMode, getGeoData, resetMap } from './map.js';
import { initForm, setRouteValues, validateStep, flushQueue, cancelQueued } from './form.js';
import { initHistory, renderHistory } from './history.js';

const $ = (id) => document.getElementById(id);
const desktop = window.matchMedia('(min-width: 900px)');
const STEP_NAMES = { 1: 'Trajet', 2: 'Détails', 3: 'Envoi' };
let currentStep = 1;

/* ------------------------------------------------------------------ */
/* Notifications (toasts)                                               */
/* ------------------------------------------------------------------ */

export function toast(message, type = 'info', timeout = 4500) {
  const region = $('toasts');
  const item = document.createElement('div');
  item.className = `toast toast--${type}`;
  item.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Fermer la notification');
  close.textContent = '✕';
  const dismiss = () => {
    item.classList.add('is-leaving');
    setTimeout(() => item.remove(), 200);
  };
  close.addEventListener('click', dismiss);
  item.append(text, close);
  region.append(item);
  setTimeout(dismiss, timeout);
}

function showBanner(message) {
  const banner = $('banner');
  banner.textContent = message;
  banner.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Étapes (mobile) — sur bureau, tout est visible sur un seul écran     */
/* ------------------------------------------------------------------ */

function goToStep(step, { focus = true } = {}) {
  currentStep = Math.min(3, Math.max(1, step));
  $('layout').dataset.step = String(currentStep);

  const progress = $('progress');
  progress.setAttribute('aria-valuenow', String(currentStep));
  progress.setAttribute('aria-valuetext', `Étape ${currentStep} sur 3 : ${STEP_NAMES[currentStep]}`);
  $('progress-fill').style.width = `${(currentStep / 3) * 100}%`;
  progress.querySelectorAll('li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('is-current', n === currentStep);
    li.classList.toggle('is-done', n < currentStep);
    if (n === currentStep) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });

  $('btn-prev').hidden = currentStep === 1;
  $('btn-next').hidden = currentStep === 3;

  const heading = $(`step${currentStep}-title`);
  if (desktop.matches) {
    if (focus) heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    window.scrollTo({ top: 0 });
    $('panel').scrollTop = 0;
  }
  if (focus) heading.focus({ preventScroll: true }); // le défilement est déjà géré ci-dessus
}

function initSteps() {
  $('btn-next').addEventListener('click', () => {
    if (validateStep(currentStep)) return; // le premier champ en erreur reçoit le focus
    goToStep(currentStep + 1);
  });
  $('btn-prev').addEventListener('click', () => goToStep(currentStep - 1));
  goToStep(1, { focus: false });
}

/* ------------------------------------------------------------------ */
/* Onglets « Déclarer » / « Mes trajets »                               */
/* ------------------------------------------------------------------ */

function initTabs() {
  const tabs = [$('tab-declare'), $('tab-history')];
  const select = (tab, { focus = false } = {}) => {
    tabs.forEach((t) => {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !selected;
    });
    const view = tab.id === 'tab-history' ? 'history' : 'declare';
    document.body.dataset.view = view;
    if (view === 'history') renderHistory();
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    // Flèches gauche/droite entre onglets (motif ARIA « tabs »)
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      select(next, { focus: true });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                            */
/* ------------------------------------------------------------------ */

async function start() {
  initTabs();

  initHistory({
    toast,
    onDelete: (id) => cancelQueued(id),
    onRetry: () => flushQueue({ manual: true }),
  });

  initForm({
    toast,
    getGeoData,
    resetMap,
    goToStep,
    onModeChange: (modeId) => setTransportMode(modeId),
  });

  initSteps();

  // Renvoi automatique des trajets en attente : au retour du réseau, au retour sur l'onglet, et toutes les minutes.
  window.addEventListener('online', () => flushQueue());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flushQueue(); });
  setInterval(() => flushQueue(), 60_000);
  flushQueue();

  // Le passage mobile ↔ bureau réaffiche la bonne étape
  desktop.addEventListener('change', () => goToStep(currentStep, { focus: false }));

  const result = await initMap({
    toast,
    onRouteChange: setRouteValues,
    onAuthFailure: () => showBanner(
      'La clé Google Maps est invalide ou n’est pas autorisée pour ce site. La carte est désactivée : saisissez les adresses, la distance et la durée à la main.',
    ),
  });
  if (!result.ok && result.reason === 'missing-key') {
    showBanner('Clé Google Maps non configurée (js/config.js). Vous pouvez tout de même déclarer un trajet en saisissant la distance et la durée.');
  } else if (!result.ok) {
    showBanner('Google Maps n’a pas pu être chargé (connexion ou bloqueur ?). Saisissez la distance et la durée à la main.');
  }
}

start();
