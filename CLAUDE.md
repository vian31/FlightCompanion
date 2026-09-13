# Hdv — règles de contribution

- Travailler directement sur `main`. Pas de branche, pas de PR.
  Si la session est ouverte sur une autre branche, la ramener sur
  `main` avant de pousser.
- Avant tout push : vérifier que le JS parse (`node --check` sur le
  bloc <script> extrait) et que la page se charge sans erreur console
  (Chromium en 412x900, la taille d'un téléphone).
- Incrémenter APP_VERSION à chaque commit qui touche `index.html`,
  `preview.html`, ou un de leurs fichiers annexes.
- Message de commit court, en français, décrivant l'effet
  visible pour l'utilisateur.
- Résumer le diff dans la conversation après le push, captures
  d'écran à l'appui pour tout changement visuel.

# Grosses modifs : passer par preview.html

Pour une refonte (nouvel onglet, nouvelle fonction), ne pas toucher
`index.html` directement :

1. Copier `index.html` en `preview.html` et y faire tout le travail
   — y compris, si besoin, des fichiers annexes same-origin ajoutés
   à côté (voir « Contraintes du projet » : plusieurs fichiers sont
   permis).
2. Pousser `preview.html` (et ses fichiers annexes) sur `main` pour
   un essai sur le téléphone.
3. Une fois validé, reporter dans `index.html` et supprimer
   `preview.html` dans le même commit ; les fichiers annexes de
   `preview.html` deviennent alors ceux d'`index.html`.

`preview.html` est un fichier de passage : il n'en existe jamais
deux, et il ne survit pas à la validation.

# Contraintes du projet

- L'app peut être répartie sur plusieurs fichiers (styles, scripts,
  données…) du moment qu'ils restent en local, servis à côté
  d'`index.html` — same-origin, jamais de CDN, de bibliothèque ou
  de police distante : l'app tourne hors ligne, en vol.
- `sw.js` reste par exemple un fichier à part : un service worker
  ne peut pas être chargé depuis un blob: ni un data:, il lui faut
  un vrai fichier same-origin.
- Données embarquées via <script type="text/plain">, ou dans un
  fichier séparé same-origin si c'est plus lisible.
- Taille de police minimale : 16px partout.
- Cible : Android, usage en vol, hors ligne.

# Hors ligne et mises à jour

- `sw.js` applique « réseau d'abord, cache de secours » : avec du
  réseau la page vient toujours du serveur, sans réseau la
  dernière version chargée est resservie. Au-delà de 6 s d'attente
  le cache prend le relais.
- Le document est redemandé avec `cache: 'no-store'` : sans cela le
  cache HTTP du navigateur masque la version qui vient d'être
  publiée.
- Les appels météo (avwx.rest) ne sont jamais interceptés ni mis en
  cache : une observation périmée servie de mémoire serait
  dangereuse.
- Le manifeste PWA est un **vrai fichier**, `manifest.webmanifest`,
  avec ses icônes (`icon-192.png`, `icon-512.png`) à côté. Surtout
  pas un `blob:` : Chrome relit le manifeste en tâche de fond pour
  mettre à jour l'app déjà installée (couleur de barre, mode
  d'affichage, icône), et un `blob:` n'est lisible que depuis la
  page qui l'a créé — les changements ne seraient jamais repris.
- `display: "fullscreen"` : sur Android, une PWA installée ne sait
  pas dessiner sous les barres système (limite Chromium connue), et
  `standalone` laisse donc des bandes noires en haut et en bas.
  Le plein écran les supprime ; les barres restent accessibles au
  glissement depuis le bord.
- Reste alors la **découpe caméra**, qu'Android laisse en noir hors
  de la page : sa couleur n'est pas accessible au CSS. Chromium ne
  tient compte de `viewport-fit=cover` pour la découpe que si la page
  passe en plein écran par l'**API Fullscreen** — d'où la demande au
  premier toucher (réglage « Découpe caméra »), l'API exigeant un
  geste. Sans effet en onglet, où on ne la déclenche pas.
- Un changement de manifeste n'arrive pas tout de suite sur l'app
  installée : Chrome la met à jour au mieux une fois par jour. Pour
  forcer, désinstaller puis réinstaller l'icône (ou `about://webapks`
  → bouton « Update »).
- Les réglages proposent « Recharger la dernière version » : c'est
  le seul moyen de rafraîchir une app installée, qui n'a ni barre
  d'adresse ni tirer-pour-rafraîchir.

# Stockage

- Tout passe par `store` / `load` / `drop` : localStorage, avec
  repli cookie **uniquement** si localStorage est refusé — un
  cookie plafonne à 4 Ko et repart vers le serveur à chaque
  requête. Ajouter toute nouvelle clé à `STORE_KEYS`.

# Structure de l'app

- Trois onglets glissants, masquables et réordonnables dans les
  réglages : **Checklist**, **Mes derniers vols**, **Météo**
  (catalogue `TAB_DEFS`).
- Checklist : blocs repliables, un seul ouvert à la fois. « Avant le
  vol » en tête, « Après le vol » en bas, puis le bouton
  « Clôturer le vol ».
- Mes derniers vols : les 5 derniers vols clôturés, plus récent en
  tête, en blocs repliables — un seul ouvert à la fois. Pas de récap
  du vol en cours : le temps de vol n'apparaît qu'une fois clôturé.
- Clôturer un vol demande le trajet (5 caractères alphanumériques
  en majuscules) et fige le vol ; la checklist n'est pas remise à
  zéro, c'est le rôle du bouton ↻.
- Modules : `HDV` (heures et horamètres), `RAPPELS` (blocs Avant /
  Après le vol et carburant), `FLIGHTS` (clôture et carnet). Les deux
  premiers exposent un `snapshot()` que la clôture recopie — ne pas
  relire le DOM pour récupérer ces valeurs.
- Stockage navigateur (helpers `store` / `load` / `drop`, avec repli
  cookie puis mémoire) : `app-settings`, `current-tab`,
  `checklist-state`, `rappels-state`, `hdv-entries`, `hdv-flights`
  (5 vols maximum), `avwx-token`.
