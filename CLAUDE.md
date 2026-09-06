# Hdv — règles de contribution

- Travailler directement sur `main`. Pas de branche, pas de PR.
  Si la session est ouverte sur une autre branche, la ramener sur
  `main` avant de pousser.
- Avant tout push : vérifier que le JS parse (`node --check` sur le
  bloc <script> extrait) et que la page se charge sans erreur console
  (Chromium en 412x900, la taille d'un téléphone).
- Incrémenter APP_VERSION à chaque commit qui touche `index.html`
  ou `preview.html`.
- Message de commit court, en français, décrivant l'effet
  visible pour l'utilisateur.
- Résumer le diff dans la conversation après le push, captures
  d'écran à l'appui pour tout changement visuel.

# Grosses modifs : passer par preview.html

Pour une refonte (nouvel onglet, nouvelle fonction), ne pas toucher
`index.html` directement :

1. Copier `index.html` en `preview.html` et y faire tout le travail.
2. Pousser `preview.html` sur `main` pour un essai sur le téléphone.
3. Une fois validé, reporter dans `index.html` et supprimer
   `preview.html` dans le même commit.

`preview.html` est un fichier de passage : il n'en existe jamais
deux, et il ne survit pas à la validation.

# Contraintes du projet

- Fichier unique `index.html`, auto-contenu. Pas de dépendance
  externe au runtime, pas de fetch() vers un fichier local.
- Données embarquées via <script type="text/plain">.
- Taille de police minimale : 16px partout.
- Cible : Android, usage en vol, hors ligne.

# Structure de l'app

- Trois onglets glissants, masquables et réordonnables dans les
  réglages : **Checklist**, **Mes derniers vols**, **Météo**
  (catalogue `TAB_DEFS`).
- Checklist : blocs repliables, un seul ouvert à la fois. « Avant le
  vol » en tête, « Après le vol » en bas, puis le bouton
  « Clôturer le vol ».
- Mes derniers vols : le bloc « Vol en cours » (récap horamètre et
  temps de vol, alimenté en direct par `HDV`), puis les 5 derniers
  vols clôturés, plus récent en tête, mêmes blocs repliables.
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
