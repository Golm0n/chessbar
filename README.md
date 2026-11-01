# Échecs · barre d'évaluation

Partie d'échecs à deux, en ligne, où l'on ne voit que la barre d'évaluation (comme sur Lichess), sans meilleur coup ni chiffres.

- Site 100 % statique, aucune API Lichess : Stockfish tourne dans le navigateur (WASM, version lite, ~1,8 Mo).
- La barre ne bouge qu'à partir de la profondeur 14 et continue jusqu'à 17 si on attend (réglable en haut de `app.js` : `MIN_DEPTH`, `MAX_DEPTH`).
- Rooms par code (5 caractères) en WebRTC via PeerJS, lien d'invitation `?room=CODE`.

## Tester en local
Ne pas ouvrir `index.html` en double-cliquant : en `file://`, le navigateur bloque les modules ES et le Worker Stockfish.
```
python -m http.server
```
Puis ouvrir `http://localhost:8000`.

## Déployer sur GitHub Pages
1. Mets tout ce dossier à la racine d'un dépôt GitHub.
2. Settings → Pages → Source : branche `main`, dossier `/ (root)`.
3. Le site est dispo sur `https://<ton-pseudo>.github.io/<depot>/`.

## Licence
Stockfish.js et chessground sont sous GPLv3, donc ce projet doit rester sous GPLv3 (garde les fichiers de licence dans `vendor/`).
