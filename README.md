# Mes trajets : collecte de données de mobilité

Site web statique (HTML, CSS, JavaScript vanilla, **sans étape de build**) où chacun déclare ses trajets :

- l'itinéraire se trace sur une carte Google Maps ;
- la distance et la durée sont calculées automatiquement ;
- l'utilisateur précise le mode de transport, le motif et la fréquence ;
- le site estime les émissions de CO₂.

Chaque envoi ajoute une ligne dans un **Google Sheet**, que l'on peut télécharger en `.xlsx`. Chaque utilisateur peut aussi **exporter ses propres trajets** en Excel.

```
/
├── index.html
├── css/style.css
├── js/
│   ├── app.js          initialisation, onglets, navigation entre étapes, notifications
│   ├── map.js          Google Maps, autocomplétion, itinéraires, marqueurs
│   ├── form.js         validation, calcul CO₂, envoi, file d'attente hors ligne
│   ├── history.js      historique local + export Excel (SheetJS)
│   └── config.js       clé Maps, facteurs d'émission, pays par défaut, listes
├── icons/              icônes de l'application (SVG + PNG)
├── manifest.webmanifest
├── netlify/functions/submit.js
├── apps-script/Code.gs
├── netlify.toml
└── README.md
```

Comment circulent les données :

```
Navigateur ──POST JSON──▶ /.netlify/functions/submit ──POST + jeton──▶ Apps Script ──▶ Google Sheet
   │  (validation)              (validation, UUID, horodatage)              (vérifie le jeton)
   └─ si hors ligne : file d'attente localStorage, renvoyée automatiquement au retour du réseau
```

---

## 1. Google Cloud : activer les API et créer la clé Maps

1. Ouvrez <https://console.cloud.google.com/> et créez un projet (ou choisissez-en un). Associez-lui un **compte de facturation** : Google Maps l'exige, mais l'usage d'une petite enquête reste en général dans le quota gratuit mensuel.
2. Dans **API et services > Bibliothèque**, activez :
   - **Maps JavaScript API** : la carte ;
   - **Places API (New)** : l'autocomplétion des adresses ;
   - **Routes API** : le calcul des itinéraires et des alternatives ;
   - **Geocoding API** (recommandé) : elle donne une adresse lisible quand on touche la carte ou qu'on utilise « Ma position ». Sans elle, ce sont les coordonnées qui s'affichent.

   > **Pourquoi pas « Directions API » et l'ancienne « Places API » ?** Google les classe *legacy* depuis mars 2025 et déconseille de les activer sur un nouveau projet. Le site utilise donc leurs remplaçants dans la même bibliothèque JavaScript : `Route.computeRoutes()` (bibliothèque `routes`) à la place de `DirectionsService`, et `AutocompleteSuggestion` (bibliothèque `places`) à la place de `places.Autocomplete`. Les fonctionnalités sont les mêmes : itinéraires alternatifs, étapes, modes de déplacement, autocomplétion restreinte à un pays.

3. Dans **API et services > Identifiants**, choisissez **Créer des identifiants > Clé API**.
4. **Restreignez la clé** : c'est indispensable, car elle sera visible dans le code du site.
   - **Restrictions relatives aux applications** : choisissez **Sites Web (référents HTTP)** et ajoutez :
     ```
     https://VOTRE-SITE.netlify.app/*
     https://*--VOTRE-SITE.netlify.app/*
     http://localhost:8888/*
     ```
     La 2e ligne couvre les aperçus de déploiement Netlify. Si vous utilisez un nom de domaine personnalisé, ajoutez aussi `https://votre-domaine.fr/*`. Pour autoriser tous les sous-domaines Netlify, vous pouvez mettre `https://*.netlify.app/*`, mais c'est moins sûr : n'importe quel site Netlify pourrait alors utiliser votre clé.
   - **Restrictions relatives aux API** : choisissez **Restreindre la clé** et cochez uniquement les 4 API ci-dessus.
5. Collez la clé dans `js/config.js` :
   ```js
   GOOGLE_MAPS_API_KEY: 'AIza…',
   ```
6. *(Recommandé pour la production)* Dans **Google Maps Platform > Gestion des cartes**, créez un **Map ID** de type *JavaScript / Vectoriel* et remplacez `DEMO_MAP_ID` dans `js/config.js`. Un Map ID est nécessaire pour les marqueurs déplaçables ; `DEMO_MAP_ID` suffit pour les tests.

Autres réglages de `js/config.js` :

| Clé | Rôle |
| --- | --- |
| `DEFAULT_COUNTRY` / `DEFAULT_COUNTRY_LABEL` | Pays de l'autocomplétion (`'fr'` / `'France'`). Mettez `''` pour chercher dans le monde entier. L'utilisateur peut aussi décocher « Rechercher en France uniquement ». |
| `DEFAULT_CENTER`, `DEFAULT_ZOOM` | Vue initiale de la carte |
| `MAX_WAYPOINTS` | Nombre maximal d'étapes intermédiaires (3) |
| `EMISSION_FACTORS` | Facteurs d'émission en kg CO₂e/km par mode (voir plus bas) |
| `TRANSPORT_MODES`, `MOTIFS` | Listes proposées dans le formulaire |

## 2. Google Sheet et Apps Script

1. Créez un Google Sheet vide (par exemple « Enquête mobilité »).
2. Ouvrez **Extensions > Apps Script**. Supprimez le contenu de `Code.gs` et collez celui de [`apps-script/Code.gs`](apps-script/Code.gs). Enregistrez.
3. **Définissez le jeton secret** : dans l'éditeur Apps Script, ouvrez **Paramètres du projet** (roue dentée), puis **Propriétés du script > Ajouter une propriété**.
   - Propriété : `SHEET_SECRET`
   - Valeur : une longue chaîne aléatoire, par exemple obtenue avec cette commande PowerShell :
     ```powershell
     -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
     ```
4. *(Facultatif)* Testez : sélectionnez la fonction `testerEcriture` et cliquez sur **Exécuter**. Google demande les autorisations la première fois. Un onglet **Trajets** apparaît avec l'en-tête et une ligne de test, que vous pouvez supprimer ensuite.
5. **Déployez** : cliquez sur **Déployer > Nouveau déploiement**, puis l'icône engrenage > **Application Web**.
   - Description : « collecte mobilité »
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**
6. Cliquez sur **Déployer**, autorisez l'accès, puis **copiez l'URL de l'application Web** (elle se termine par `/exec`).

> L'URL est publique, mais sans le jeton aucune écriture n'est acceptée. Seule la Netlify Function connaît ce jeton : il n'apparaît jamais dans le navigateur.
>
> Si vous modifiez `Code.gs` plus tard, allez dans **Déployer > Gérer les déploiements**, cliquez sur le crayon puis choisissez **Version : Nouvelle version**. L'URL reste la même.

## 3. Déployer sur Netlify

> ⚠️ Le **glisser-déposer** (Netlify Drop) ne publie que les fichiers statiques : **la fonction `submit` ne serait pas déployée** et les envois resteraient en file d'attente. Utilisez GitHub ou la ligne de commande.

### Option A : via GitHub (recommandé)

1. Poussez ce dossier dans un dépôt GitHub.
2. Sur <https://app.netlify.com>, cliquez sur **Add new site > Import an existing project**, puis choisissez le dépôt.
3. Paramètres de build : laissez **Build command** vide et mettez `.` dans **Publish directory**. `netlify.toml` les renseigne déjà.
4. Cliquez sur **Deploy**.

### Option B : via la ligne de commande

Pré-requis : [Node.js 18 ou plus récent](https://nodejs.org/).

```bash
npm install -g netlify-cli
netlify login
netlify deploy --prod
```

À la première commande `deploy`, choisissez **Create & configure a new site**, et `.` comme dossier de publication.

### Variables d'environnement

Dans Netlify, ouvrez **Site configuration > Environment variables > Add a variable** :

| Nom | Valeur |
| --- | --- |
| `SHEET_WEBHOOK_URL` | l'URL `…/exec` de l'Apps Script |
| `SHEET_SECRET` | le même jeton que la propriété de script `SHEET_SECRET` |

Ensuite, **redéployez** le site (**Deploys > Trigger deploy > Deploy site**) : les fonctions ne lisent les variables qu'au déploiement.

Pensez enfin à ajouter l'adresse finale du site (`https://VOTRE-SITE.netlify.app/*`) dans les référents autorisés de la clé Maps (étape 1.4).

## 4. Tester en local avec `netlify dev`

```bash
npm install -g netlify-cli
netlify link   # relie le dossier au site Netlify (récupère les variables d'environnement)
netlify dev    # http://localhost:8888
```

Sans `netlify link`, créez à la racine un fichier `.env`. Il est déjà exclu de Git par `.gitignore`. Mettez-y :

```
SHEET_WEBHOOK_URL=https://script.google.com/macros/s/XXXX/exec
SHEET_SECRET=votre-jeton
```

Points à vérifier :
- La carte s'affiche, et taper « gare de Lyon » propose des suggestions.
- Toucher la carte place A puis B, et plusieurs itinéraires s'affichent.
- La distance et la durée se remplissent automatiquement.
- L'envoi ajoute une ligne dans le Google Sheet.
- Hors ligne : dans les DevTools, ouvrez **Network > Offline** et envoyez un trajet. Il passe « En attente », puis part tout seul quand vous revenez en ligne.

> `localhost:8888` doit figurer dans les référents autorisés de la clé Maps. Sans clé, le site reste utilisable : la carte est remplacée par un message, et la distance et la durée se saisissent à la main.

## 5. Récupérer les données en Excel

- **Toutes les réponses** : dans le Google Sheet, menu **Fichier > Télécharger > Microsoft Excel (.xlsx)**.
- **Ses propres trajets** : dans le site, onglet **Mes trajets > Exporter en Excel**. Cela génère `mes-trajets-AAAA-MM-JJ.xlsx`, avec les mêmes colonnes, les en-têtes en gras, un filtre et des colonnes à la bonne largeur.

---

## Référence

### Colonnes du tableur

| Colonne | Contenu |
| --- | --- |
| `id` | UUID du trajet. Il est créé sur l'appareil et réutilisé lors des renvois, pour éviter les doublons. |
| `horodatage` | Date et heure de réception par le serveur (ISO 8601, UTC) |
| `utilisateur` | Identifiant ou pseudo |
| `date`, `heure_depart` | `AAAA-MM-JJ`, `HH:MM` |
| `depart_*`, `arrivee_*` | Adresse saisie ou choisie, latitude, longitude. Les coordonnées sont vides si la carte n'était pas disponible. |
| `etapes` | Étapes séparées par ` \| `, au format `adresse (lat, lng)` |
| `mode_transport` | `marche`, `velo`, `velo_electrique`, `trottinette`, `moto`, `voiture_thermique`, `voiture_electrique`, `covoiturage`, `bus`, `tram`, `train`, `autre` |
| `passagers` | Personnes à bord, conducteur compris (modes voiture uniquement) |
| `distance_km`, `duree_min` | **Totaux du trajet déclaré** : ils sont doublés en aller-retour |
| `distance_modifiee` | `TRUE` si la distance a été corrigée à la main, ou saisie sans carte |
| `motif` | `domicile_travail`, `domicile_etudes`, `courses`, `loisirs`, `professionnel`, `autre` |
| `aller_retour` | `TRUE` / `FALSE` |
| `frequence_jours_semaine` | `0` = ponctuel, sinon de 1 à 7 |
| `co2_kg` | Estimation en kg CO₂e pour ce trajet (aller-retour compris), part par personne pour la voiture |
| `commentaire` | Texte libre (500 caractères max.) |
| `polyline` | Tracé de l'itinéraire choisi au format [Encoded Polyline](https://developers.google.com/maps/documentation/utilities/polylinealgorithm), 30 000 caractères max. |

### Facteurs d'émission

Ils sont regroupés dans `EMISSION_FACTORS` (`js/config.js`), en kg CO₂e par km. Ce sont des ordres de grandeur issus de la Base Empreinte de l'ADEME et d'[impactco2.fr](https://impactco2.fr/outils/transport). **Vérifiez-les avant toute exploitation officielle.**

- **Voitures et covoiturage** : le facteur s'applique au véhicule, puis il est **divisé par le nombre de personnes à bord**.
- **Autres modes** : le facteur est déjà exprimé par voyageur.
- **Mode `autre`** : il vaut `null`, donc aucune estimation n'est faite.

### Choix techniques

- **Pas de build** : modules ES natifs, servis tels quels.
- **Autocomplétion accessible** : une liste ARIA « combobox », utilisable au clavier (↑ ↓ Entrée Échap), construite sur `AutocompleteSuggestion`.
- **Itinéraires** : `travelMode` dépend du mode choisi :
  - voiture, moto, covoiturage, autre → `DRIVING` ;
  - vélo, vélo électrique, trottinette → `BICYCLING` ;
  - marche → `WALKING` ;
  - bus, tram, train → `TRANSIT`.

  Si Google ne trouve rien dans ce mode (pas de transports en commun, étapes en mode `TRANSIT`…), le calcul se refait en `DRIVING` et un message le signale. Google ne propose pas d'itinéraires alternatifs quand le trajet comporte des étapes.
- **Excel** : la bibliothèque est chargée au premier export seulement. Le site utilise [xlsx-js-style](https://github.com/gitbrent/xlsx-js-style), un fork de SheetJS à l'API identique : l'édition gratuite de SheetJS n'écrit pas les styles, donc pas le gras. Si ce CDN est indisponible, le site se rabat sur SheetJS officiel (`cdn.sheetjs.com`), sans le gras.
- **Sécurité** :
  - aucun secret dans le front ;
  - double validation, dans le navigateur et dans la fonction ;
  - protection contre l'injection de formules dans le tableur (`=`, `+`, `-`, `@`) ;
  - verrou d'écriture et anti-doublon côté Apps Script ;
  - en-têtes de sécurité et CSP compatible Google Maps (`netlify.toml`).
- **PWA légère** : `manifest.webmanifest` et icônes permettent l'ajout à l'écran d'accueil. Il n'y a pas de service worker, donc pas de cache hors ligne de l'application elle-même. Les trajets saisis hors ligne sont toutefois conservés et renvoyés.

### Données personnelles

Le site collecte un pseudo et des adresses de trajets, qui sont des données personnelles au sens du RGPD. Informez les participants : finalité, durée de conservation, contact. Proposez de préférence des pseudos plutôt que des noms réels. Côté appareil, l'historique et le pseudo restent dans le `localStorage` du navigateur, et l'utilisateur peut supprimer ses trajets de l'historique local.
