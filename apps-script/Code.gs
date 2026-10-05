/**
 * Code.gs — Réception des trajets dans Google Sheets.
 *
 * Installation (détails dans le README) :
 *  1. Dans le Google Sheet : Extensions > Apps Script, collez ce fichier.
 *  2. Paramètres du projet (roue dentée) > Propriétés du script > ajoutez SHEET_SECRET = votre jeton.
 *  3. Déployer > Nouveau déploiement > Application Web
 *     - Exécuter en tant que : Moi
 *     - Qui a accès : Tout le monde
 *  4. Copiez l'URL (…/exec) dans la variable Netlify SHEET_WEBHOOK_URL.
 *
 * Le jeton n'est jamais exposé au navigateur : seule la Netlify Function le connaît.
 */

// Ordre des colonnes (identique à js/config.js et netlify/functions/submit.js)
var HEADERS = [
  'id', 'horodatage', 'utilisateur', 'date', 'heure_depart',
  'depart_adresse', 'depart_lat', 'depart_lng',
  'arrivee_adresse', 'arrivee_lat', 'arrivee_lng',
  'etapes', 'mode_transport', 'passagers', 'distance_km', 'duree_min', 'distance_modifiee',
  'motif', 'aller_retour', 'frequence_jours_semaine', 'co2_kg', 'commentaire', 'polyline'
];

// Nom de l'onglet qui reçoit les données (créé s'il n'existe pas)
var SHEET_NAME = 'Trajets';

/**
 * Point d'entrée POST. Corps attendu : { "secret": "...", "row": { colonne: valeur, ... } }
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ ok: false, error: 'Requête vide' });
    }

    var body = JSON.parse(e.postData.contents);
    var expected = PropertiesService.getScriptProperties().getProperty('SHEET_SECRET');
    if (!expected) {
      return jsonResponse_({ ok: false, error: 'SHEET_SECRET non défini dans les propriétés du script' });
    }
    if (!body || body.secret !== expected) {
      return jsonResponse_({ ok: false, error: 'Jeton invalide' });
    }

    var row = body.row;
    if (!row || typeof row !== 'object' || !row.id) {
      return jsonResponse_({ ok: false, error: 'Ligne manquante' });
    }

    // Verrou : deux envois simultanés ne peuvent pas écrire sur la même ligne.
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var sheet = getSheet_();

      // Feuille vide : on crée la ligne d'en-tête.
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(HEADERS);
        sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#d9f0ec');
        sheet.setFrozenRows(1);
      }

      // Anti-doublon : un trajet renvoyé après une coupure réseau garde le même id.
      if (sheet.getLastRow() > 1) {
        var found = sheet
          .getRange(2, 1, sheet.getLastRow() - 1, 1)
          .createTextFinder(String(row.id))
          .matchEntireCell(true)
          .findNext();
        if (found) {
          return jsonResponse_({ ok: true, id: row.id, duplicate: true });
        }
      }

      var values = HEADERS.map(function (key) {
        var v = row[key];
        return v === undefined || v === null ? '' : v;
      });
      sheet.appendRow(values);
    } finally {
      lock.releaseLock();
    }

    return jsonResponse_({ ok: true, id: row.id });
  } catch (err) {
    console.error(err);
    return jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * GET : simple test de disponibilité (ouvrez l'URL /exec dans un navigateur).
 */
function doGet() {
  return jsonResponse_({ ok: true, service: 'collecte-mobilite' });
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Facultatif : exécutez cette fonction une fois depuis l'éditeur pour tester l'écriture
 * (Exécuter > testerEcriture). Elle ajoute une ligne factice, à supprimer ensuite.
 */
function testerEcriture() {
  var secret = PropertiesService.getScriptProperties().getProperty('SHEET_SECRET');
  var fake = {
    postData: {
      contents: JSON.stringify({
        secret: secret,
        row: {
          id: Utilities.getUuid(),
          horodatage: new Date().toISOString(),
          utilisateur: 'test',
          date: '2026-01-01',
          heure_depart: '08:00',
          depart_adresse: 'Test départ',
          arrivee_adresse: 'Test arrivée',
          mode_transport: 'velo',
          distance_km: 1.5,
          duree_min: 6,
          motif: 'loisirs',
          aller_retour: false,
          frequence_jours_semaine: 0,
          co2_kg: 0
        }
      })
    }
  };
  Logger.log(doPost(fake).getContent());
}
