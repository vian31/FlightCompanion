# Hdv — règles de contribution

- Travailler directement sur `main`. Pas de branche, pas de PR.
- Avant tout push : vérifier que le JS d'index.html parse
  et que la page se charge sans erreur console.
- Incrémenter APP_VERSION à chaque commit poussé.
- Message de commit court, en français, décrivant l'effet
  visible pour l'utilisateur.
- Résumer le diff dans la conversation après le push.

# Contraintes du projet

- Fichier unique `index.html`, auto-contenu. Pas de dépendance
  externe au runtime, pas de fetch() vers un fichier local.
- Données embarquées via <script type="text/plain">.
- Taille de police minimale : 16px partout.
- Cible : Android, usage en vol, hors ligne.
