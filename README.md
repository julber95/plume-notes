# Plume

Prise de notes manuscrites, synchronisée avec OneDrive. Chaque bloc-notes est un
PDF rangé dans le dossier `Plume` de OneDrive, lisible partout, et reste
modifiable trait par trait dans l'application.

Application web installable (PWA) : tablette Android avec stylet, et tout
navigateur récent sur ordinateur.

**Mise en service (sans programmer) : voir [docs/GUIDE.md](docs/GUIDE.md).**

## Ce que fait la version 1

- Bibliothèque de dossiers et de blocs-notes, reproduite à l'identique dans
  OneDrive (création, renommage, déplacement, suppression, dans les deux sens).
- Pages A4, portrait ou paysage, fonds blanc, ligné, quadrillé, pointillé, Seyès.
- Stylo sensible à la pression, surligneur (sous l'encre), gomme (trait entier ou
  précise), trait droit, annuler / rétablir.
- Gestion des pages : ajouter, dupliquer, déplacer, supprimer, changer le fond.
- Rejet de la paume ; défilement et zoom aux doigts ; souris sur ordinateur.
- Enregistrement local immédiat de chaque trait ; fonctionnement hors ligne.
- Export PDF automatique vers OneDrive, avec indicateur d'état.
- En cas de modification à deux endroits : les deux versions sont conservées.

Prévu pour la version 2 : formes et repère, lasso, import de PDF et d'images,
vignettes des pages, stylos favoris.

## Développement

```
npm install
npm run dev        # application en local sur http://localhost:5173
npm test           # tests automatisés (export PDF, synchronisation, connexion)
npm run test:e2e   # application pilotée dans Chromium face à un faux OneDrive
npm run build      # version de production dans dist/
```

`npm run test:e2e` demande Chromium : `npx playwright install chromium`.

## Organisation du code

| Dossier | Rôle |
| --- | --- |
| `src/model.ts`, `src/db.ts` | Types et stockage local (IndexedDB) |
| `src/geometry.ts`, `src/backgrounds.ts` | Forme des traits et fonds, communs à l'écran et au PDF |
| `src/pdf/` | Fabrication et relecture des PDF (dans un worker) |
| `src/sync/` | Connexion Microsoft, client OneDrive, moteur de synchronisation |
| `src/ui/` | Bibliothèque, écran d'écriture, moteur de tracé |
| `tests/` | Tests, dont un faux OneDrive en mémoire |

Les données modifiables voyagent dans le PDF lui-même (dictionnaires `PieceInfo`,
le mécanisme prévu par le format PDF pour les données privées d'une application) :
un seul fichier par bloc-notes, que l'on peut déplacer ou renommer librement.

Pour mesurer les temps de rendu : `localStorage['plume.debug'] = '1'`, puis onglet
Performance du navigateur (mesures `plume-scene` et `plume-live`).
