# UFit Backend

Fondation backend MVP pour UFit.

## Stack

- NestJS
- Drizzle
- Supabase PostgreSQL
- Stripe Checkout en environnement test
- REST API

## Environnement

Le backend charge les variables depuis :

1. `code/UFit_backend/.env`
2. `code/UFit_backend/.env.local`
3. `code/.env`
4. `code/.env.local`

Le projet utilise actuellement `code/.env`.

Variables minimales :

```txt
API_PORT=4000
UFIT_DB_SCHEMA=ufit
SUPABASE_URL=...
SUPABASE_DIRECT_CONNECTION_DB_URL=...
SUPABASE_DB_SSL=true
SUPABASE_DB_TLS_REJECT_UNAUTHORIZED=false
STRIPE_SECRET_KEY=sk_test_...
STRIPE_CHECKOUT_SUCCESS_URL=...
STRIPE_CHECKOUT_CANCEL_URL=...
```

## Commandes

```bash
npm install
npm run db:migrate
npm run db:verify
npm run build
npm test
npm run dev
```

## Health check

```txt
GET /health
```

Le health check confirme la connexion PostgreSQL et l'existence du schema configure, sans exposer de secret.

## Photos produit

Appliquer la migration `0013_product_media.sql` avec `npm run db:migrate`.
Dans le projet Supabase du profil sélectionné, créer le bucket
`ufit-product-media` en privé, avec `fileSizeLimit: 8388608` et
`allowedMimeTypes: ["image/jpeg"]`. Les uploads passent par le backend ; aucune
politique de stockage ouverte aux utilisateurs n’est nécessaire.

Configurer `SUPABASE_SECRET_KEY` côté backend et `MEDIA_PUBLIC_API_ORIGIN` avec
l’origine de l’API accessible par l’application (HTTPS pour un hébergement).
Cette origine identifie les photos persistées et doit rester stable.

`POST /media/product-uploads` reçoit le multipart `brandId`, `requestId` UUID
et le fichier `file`. iOS normalise les photos en JPEG. Une même clé/contenu
retrouve le même asset ; un contenu différent est refusé. La réponse porte
`id`, `brandId`, `url` stable et `displayUrl` temporaire.

`GET /media/assets/:id/private` renouvelle cette même projection pour un asset prêt
et un membre actif de sa marque non suspendue, même avant création d’un produit.
Une reprise native dont la création est définitivement refusée peut ainsi retrouver
ses photos et corriger le formulaire. Cette route ne donne pas d’accès public à
l’asset ; les administrateurs sans membership de cette marque n’y ont pas accès.

Les réponses privées du catalogue distinguent également `url` et `displayUrl`.
Seule `url` est envoyée dans les écritures produit et conservée dans les snapshots.
Les liens de lecture expirent après60 secondes et se renouvellent à la relecture
du catalogue. `GET /media/assets/:id/image` autorise le téléchargement public si
le produit et la marque sont actifs, ou si une commande ayant atteint `paid`
conserve cette image dans son snapshot. Le bucket demeure privé.


## Gestion des tenues

Les écritures exigent un créateur propriétaire ou une adhésion active à la marque
propriétaire. Un rôle administrateur autorise la lecture et la modération, sans
accorder l’édition du contenu privé d’un autre auteur. Le serveur identifie l’acteur.

- `GET /outfits/metadata` : catégories de pièces, statuts et registre de tags.
- `GET /outfits/managed?creatorId=<uuid>` ou `?brandId=<uuid>` : pages privées ;
  les administrateurs peuvent omettre l’auteur. Filtres `status`, `limit`, `cursor`.
- `GET /outfits/:id/private` : contenu géré avec version, propriétaire, pièces,
  images identifiées, tags et éventuel motif de refus.
- `POST /outfits` : `requestId`, exactement un `creatorId` ou `brandId`, `title`,
  `description`, `genderTarget` facultatif, `tagIds`, `items`, `images`. La photo de
  couverture vient de la première image selon `position` ; aucun champ parallèle
  `coverImageUrl` dans la requête. La même clé et le même contenu retrouvent la même
  tenue ; un contenu différent avec cette clé reçoit un conflit.
- `GET /outfits/creation-requests/:requestId?creatorId=<uuid>` ou `?brandId=<uuid>` :
  récupération d’une création dont la réponse a été perdue.
- `PUT /outfits/:id` : contenu complet et `expectedVersion`, avec les identifiants
  des pièces/images retenues. L’enregistrement remet en brouillon privé et retire
  les informations de décision précédentes.
- `PATCH /outfits/:id/submit`, `/archive`, `/restore` : `expectedVersion` obligatoire.
- `PATCH /outfits/:id/review` : administrateur, `expectedVersion`, décision
  `published` ou `rejected` et motif obligatoire en cas de refus.

La création et les mutations de l’agrégat sont transactionnelles. Un profil actif,
une description, au moins une photo et une pièce cohérente sont requis avant
soumission/publication. Une pièce est soit un produit actif d’une marque active,
soit une inspiration portant un libellé sans `productId`. Les prix sont calculés
par le serveur et présentés par devise. Les mutations rejettent les versions
périmées et les identifiants de pièces/images appartenant à une autre tenue.
La migration additive `0014` ajoute les versions, clés de création, contraintes
et un premier registre de tags ; elle ne change aucune tenue existante.

Les endpoints publics `GET /outfits` et `GET /outfits/:id` restent distincts des
lectures privées et conservent leur projection publique.


`GET /products/selection` fournit à l’outil de composition des pages de produits
actifs de marques actives. Accès créateur, membre de marque ou administrateur ;
paramètres `brandId`, `search` (nom littéral), `limit`, `cursor`. La projection
publique inclut le nom de marque, les prix par devise, photos et variantes,
sans SKU ni données de revue privées. Une marque en pause n’y apparaît pas.


## Photos de tenues

`POST /media/outfit-uploads` reçoit un multipart `file` JPEG, `requestId` et
exactement un `creatorId` ou `brandId`. Le serveur vérifie le rôle et l’accès au
profil avant réservation et après stockage. La même requête et les mêmes octets
retrouvent le même asset ; une reprise vérifie un objet déjà accepté par Supabase.

La réponse fournit `id`, `creatorId`, `brandId`, `url` stable et `displayUrl` privé
à durée courte. `GET /media/outfit-assets/:id/private` renouvelle le lien pour le
propriétaire. Les images des détails privés de tenue incluent aussi `displayUrl`.
Une URL interne doit correspondre à un asset prêt, de la bonne famille et du même
propriétaire ; les URL externes HTTP(S) du contrat existant restent distinctes.

`GET /media/outfit-assets/:id/image` ne redirige vers le stockage que lorsqu’une
tenue publiée et publique référence la photo sous le même propriétaire actif.
Les fichiers restent dans le bucket privé `ufit-outfit-media`, JPEG seulement,
limite8MiB. La migration0015 ajoute cette famille et son index de références ;
les données/objets produit restent dans leur famille existante.
