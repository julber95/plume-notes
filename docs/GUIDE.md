# Mettre Plume en service

Ce guide s'adresse à quelqu'un qui ne programme pas. Il y a trois étapes, à faire
une seule fois, dans cet ordre :

1. mettre Plume en ligne (gratuit, avec GitHub) ;
2. autoriser Plume à accéder à votre OneDrive (gratuit, chez Microsoft) ;
3. installer Plume sur la tablette.

Comptez environ une demi-heure. Tant que l'étape 2 n'est pas faite, Plume
fonctionne déjà, mais les notes restent uniquement sur l'appareil.

---

## Étape 1 — Mettre Plume en ligne

Plume est une application web : elle doit être accessible à une adresse
`https://…` pour pouvoir être installée sur la tablette. GitHub héberge ce genre
de site gratuitement.

1. Créez un compte sur <https://github.com> si vous n'en avez pas.
2. Créez un dépôt : bouton **New repository**, nom `plume`, visibilité
   **Public**, sans rien cocher d'autre. (L'hébergement gratuit exige un dépôt
   public. Le code ne contient aucun mot de passe ni aucune de vos notes.)
3. Envoyez le code de ce dossier vers ce dépôt. Le plus simple est de le demander
   à Claude (« pousse Plume sur mon dépôt GitHub `moncompte/plume` ») : il vous
   guidera pour la connexion à GitHub. À la main, depuis ce dossier :

   ```
   git remote add origin https://github.com/MONCOMPTE/plume.git
   git push -u origin main
   ```
4. Dans le dépôt, ouvrez **Settings → Pages** et, sous **Build and deployment**,
   choisissez **Source : GitHub Actions**.
5. Ouvrez l'onglet **Actions** : une tâche « Mise en ligne » tourne. Quand elle
   est verte (2 à 3 minutes), Plume est en ligne à l'adresse :

   **`https://MONCOMPTE.github.io/plume/`**

   Notez cette adresse exactement, avec la barre oblique finale : elle sert à
   l'étape 2.

Par la suite, chaque modification du code envoyée sur GitHub met le site à jour
toute seule, et la tablette récupère la nouvelle version à l'ouverture suivante.

---

## Étape 2 — Autoriser l'accès à OneDrive

Pour qu'une application puisse lire et écrire dans un OneDrive, Microsoft demande
qu'elle soit « enregistrée ». L'enregistrement est gratuit et donne un
**identifiant client** : une suite de lettres et de chiffres, qui n'est pas un
secret, à coller dans Plume.

### 2a. Obtenir l'accès au portail Microsoft

Depuis quelques années, un compte Microsoft personnel seul ne suffit plus pour
enregistrer une application : il faut un compte Azure (le service en ligne de
Microsoft pour les développeurs). Deux possibilités, gratuites toutes les deux :

- **Azure for Students** (le plus simple si vous êtes étudiante) :
  <https://azure.microsoft.com/free/students>. Inscription avec l'adresse e-mail
  de votre établissement, **sans carte bancaire**.
- **Compte Azure gratuit** : <https://azure.microsoft.com/free>. Microsoft y
  demande habituellement une carte bancaire pour vérifier l'identité ;
  l'enregistrement d'une application ne coûte rien.

Le compte Azure et le OneDrive n'ont pas besoin d'être le même compte : Azure sert
seulement à déclarer l'application ; vos notes iront dans le OneDrive personnel
avec lequel vous vous connecterez dans Plume.

### 2b. Enregistrer l'application

Les libellés ci-dessous sont ceux de l'interface en anglais ; si le portail
s'affiche en français, ils sont traduits mais placés au même endroit.

1. Ouvrez <https://entra.microsoft.com> et connectez-vous avec le compte Azure.
2. Dans le menu de gauche : **Entra ID → App registrations**, puis
   **New registration**.
3. **Name** : `Plume`.
4. **Supported account types** : choisissez **Personal accounts only**
   (« comptes personnels uniquement »). C'est important : avec un autre choix, la
   connexion depuis Plume sera refusée.
5. Cliquez sur **Register**.
6. Sur la page qui s'affiche, copiez la valeur **Application (client) ID**
   (de la forme `12345678-abcd-…`).
7. Dans le menu de l'application : **Manage → Authentication**, puis
   **Add Redirect URI**.
8. Choisissez la tuile **Single-page application**, puis saisissez l'adresse de
   Plume obtenue à l'étape 1, exactement, barre oblique finale comprise :
   `https://MONCOMPTE.github.io/plume/`
9. Cliquez sur **Configure**.

Il n'y a rien d'autre à régler : pas de secret, pas de permission à ajouter.

### 2c. Donner l'identifiant à Plume

Ouvrez le fichier `src/config.ts` et collez l'identifiant entre les apostrophes
de la ligne :

```ts
const CLIENT_ID = ''
```

ce qui donne par exemple `const CLIENT_ID = '12345678-abcd-…'`. Envoyez ensuite la
modification sur GitHub (ou demandez à Claude de le faire : « mets cet identifiant
client dans Plume et publie »). Deux à trois minutes plus tard, le site est à
jour.

### 2d. Se connecter

Ouvrez Plume, touchez l'indicateur **Connexion requise** en haut à droite, puis
**Se connecter à OneDrive**. Microsoft affiche une page de connexion, puis demande
votre accord pour que Plume ait « un accès complet à vos fichiers » : c'est la
permission la plus étroite que Microsoft propose pour pouvoir créer le dossier
`Plume` à la racine de OneDrive. Plume ne touche qu'à ce dossier.

L'indicateur passe à **À jour** et un dossier `Plume` apparaît dans votre
OneDrive.

À savoir : pour une application web, Microsoft limite la durée d'une session à
24 heures. Plume se reconnecte toute seule à l'ouverture quand c'est possible ;
sinon l'indicateur affiche « Connexion requise » et un appui suffit. Dans tous les
cas, ce que vous écrivez est enregistré sur la tablette et part vers OneDrive dès
la reconnexion.

### En cas d'erreur à la connexion

- **« redirect URI … does not match »** (code AADSTS50011) : l'adresse saisie au
  point 8 n'est pas exactement celle de Plume. Vérifiez le `https`, le nom du
  compte, `/plume/` et la barre oblique finale.
- **« unauthorized_client »** ou **« not enabled for consumers »** : le type de
  comptes choisi au point 4 n'est pas « Personal accounts only ». Le plus simple
  est de supprimer l'enregistrement et de le refaire.

---

## Étape 3 — Installer Plume sur la tablette

1. Sur la tablette, ouvrez l'adresse de Plume dans **Chrome**.
2. Menu **⋮** de Chrome → **Ajouter à l'écran d'accueil** → **Installer**.
3. Lancez Plume depuis son icône : elle s'ouvre en plein écran, comme une
   application, et fonctionne aussi sans réseau.
4. Connectez-vous à OneDrive (étape 2d) si ce n'est pas déjà fait.

Sur l'ordinateur, il suffit d'ouvrir la même adresse dans un navigateur et de se
connecter : les blocs-notes apparaissent et restent modifiables. Et dans tous les
cas, chaque bloc-notes est un PDF ordinaire dans le dossier `Plume` de OneDrive.

---

## Contrôles à faire sur la tablette

Ces points n'ont pas pu être vérifiés sans la tablette. Dix minutes suffisent.

| À vérifier | Comment | Résultat attendu |
| --- | --- | --- |
| Rejet de la paume | Écrire plusieurs lignes, la main posée sur l'écran | Aucun trait parasite, la page ne bouge pas |
| Pression | Écrire en appuyant plus ou moins fort | Le trait s'épaissit avec la pression |
| Fluidité de l'écriture | Écrire vite, puis sur une page déjà bien remplie | Le trait suit la pointe sans retard gênant |
| Défilement et zoom | Faire défiler à un doigt, pincer pour zoomer | Mouvement fluide, image nette à l'arrêt |
| Bouton du stylet | Maintenir le bouton latéral en traçant | Le stylet gomme tant que le bouton est enfoncé |
| Hors ligne | Mode avion, écrire, fermer puis rouvrir Plume | Tout est là ; l'indicateur affiche « Hors ligne » |
| Retour du réseau | Désactiver le mode avion | L'indicateur passe à « À jour » en moins d'une minute |
| PDF dans OneDrive | Ouvrir OneDrive sur l'ordinateur | Le PDF du bloc-notes est dans `Plume/…`, à jour |
| Dossiers | Créer, renommer, déplacer un dossier dans Plume | Le même changement apparaît dans OneDrive |

Si l'un de ces points ne donne pas le résultat attendu, notez lequel et dans
quelles conditions : c'est ce qu'il faudra ajuster.

---

## Bon à savoir

- **Chaque trait est enregistré sur l'appareil au moment où il est tracé.** La
  synchronisation OneDrive vient en plus : à la fermeture d'un bloc-notes, quand
  vous quittez l'application, et toutes les 5 minutes pendant l'écriture (durée
  réglable dans les réglages, icône en haut à droite de la bibliothèque).
- **Quand vous quittez l'application**, l'envoi démarre mais Android peut
  l'interrompre s'il est long. Il reprend alors à l'ouverture suivante. Pour être
  certaine que le PDF est parti, attendez « À jour » avant de quitter.
- **Ne supprimez pas les données de navigation de Chrome** pour le site de Plume
  tant que l'indicateur n'est pas « À jour » : c'est là que sont rangées les
  notes pas encore envoyées.
- **Un PDF modifié avec un autre logiciel** (annotations ajoutées dans un lecteur
  PDF, par exemple) : Plume rouvrira ses propres traits, pas ces ajouts.
- **Un seul appareil à la fois.** Si un même bloc-notes est modifié à deux
  endroits avant d'avoir été synchronisé, Plume ne choisit pas à votre place : il
  garde les deux versions (l'une est renommée « … (conflit date heure) ») et
  affiche un avis dans la bibliothèque.
- **Suppression** : un élément supprimé dans Plume part dans la corbeille de
  OneDrive, où il reste récupérable pendant 30 jours.
