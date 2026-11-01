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

## Conditions commerciales des marques

`GET /brands/commerce-policy/metadata` fournit les pays ISO et les devises avec
leur nombre de décimales, depuis les mêmes autorités que candidatures/catalogue.
Les lectures/écritures privées exigent un membre actif de la marque avec rôle
marque, ou un administrateur ; utilisateur actif et marque active/en pause.

- `GET /brands/:id/commerce-policy` : `{brandId, version, policy}` ; une politique
  non configurée porte `version: 0` et `policy: null`.
- `PUT /brands/:id/commerce-policy` : corps unique `{expectedVersion, policy}`,
  retour du même document privé avec la nouvelle version. Un ancien corps sans
  version est refusé. Une modification concurrente reçoit409 avec
  `brand_policy_version_changed`, sans écrasement de la politique courante.
- `GET /public/brands/:id/commerce-policy` conserve la politique seule, nullable,
  pour une marque publique active ; aucune révision ni donnée privée ajoutée.

La politique contient `returnWindowDays`, `returnPolicy`, `pricesIncludeTaxes`,
`taxNotice`, `customsNotice`, et `shippingRates`. Chaque tarif porte `country`,
`currency`, `amount` en unités mineures, `taxBasisPoints` et `taxOnShipping`.
Les couples pays/devise sont uniques ; les valeurs et règles sont saisies par la
marque, sans délai ni taux imposé. Le devis serveur fige les conditions acceptées
dans la commande ; une nouvelle politique ne réécrit pas les commandes existantes.

La migration additive0017 initialise la révision des politiques déjà présentes
sans modifier leur contenu. Les écritures conservent les autres settings/métadonnées.

## Commandes et expéditions des marques

`GET /brands/:brandId/orders?limit=20&cursor=<UUID>&status=preparing` retourne
`{items, nextCursor}`. Les résumés sont ordonnés par date puis identifiant
décroissants ; limite1–50, filtre facultatif parmi les statuts de commande hors
`pending_payment`. Les résumés ne contiennent pas d’adresse.

`GET /brands/:brandId/orders/:id` retourne les lignes et montants historiques,
l’adresse de livraison, l’expédition et les actions actuellement autorisées.
Ces lectures exigent le compte actif, la marque active/en pause et une adhésion
active avec rôle marque, ou le rôle administrateur actuel. Une commande d’une
autre marque n’est pas lisible. Aucun identifiant de paiement/client, empreinte
de checkout ou règle de commission n’est exposé dans cette projection.

`POST /shipping/shipments/:id/actions` reçoit un corps strict :

```json
{"action":"ship","expectedVersion":2,"carrier":"Transporteur","trackingNumber":"NUMERO","trackingUrl":null}
```

Les actions sont `prepare`, `ship`, `deliver`, `report_incident`,
`resolve_incident` et `update_tracking`. `ship` et `update_tracking` exigent
transporteur et numéro ; le lien facultatif est HTTPS ou null. `report_incident`
exige `incidentReason`. Les autres actions n’acceptent que leur nom et
`expectedVersion`. La réponse201 contient `{shipment, orderStatus, actions}` ;
la révision commence à1 et augmente à chaque action acceptée. Une version
périmée reçoit409 `shipment_version_changed` sans nouvelle écriture. L’ancienne
routePATCH`/shipping/shipments/:id/status` et le corps `nextStatus` sont retirés.

La préparation verrouille la même commande que l’annulation client : une
commande en préparation ne peut plus être annulée. Les états commande et
expédition changent dans la même transaction. Un incident interrompt l’expédition
sans avancer l’étape de la commande ; sa résolution reprend cette étape et
conserve le suivi ainsi que le dernier motif/date d’incident. Une correction du
suivi ne réécrit pas la date d’expédition. Livré et annulé sont terminaux.

La migration additive0018 ajoute version et motif/date d’incident, vérifie leur
cohérence et crée l’index de pagination par marque/date/identifiant. Les comptes,
rôles et adhésions sont relus depuis la base dans la transaction d’écriture.
Ces contrats ne constituent pas à eux seuls une qualification du parcours iOS.

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


## Retours après livraison

Les retours utilisent les prix, quantités, devise et délai conservés dans la
commande. Le devis porte `refundPolicyCode`, également figé dans son snapshot.
La règle `proportional_tax_full_shipping_v1` rembourse les pièces retournées,
alloue les taxes ajoutées en unités mineures de façon cumulative et rembourse
la livraison initiale lorsque toutes les unités ont été retournées. Les frais
externes de renvoi ou de douane ne sont pas ajoutés au montant encaissé par Ufit.

- `GET /orders/:orderId/returns/options` : conditions, délai, quantités restantes
  et éventuel dossier actif. Un seul dossier non résolu par commande.
- `POST /orders/:orderId/returns/preview` : `{items: [{orderItemId, quantity}]}` ;
  retourne les montants serveur et leur `fingerprint`.
- `POST /orders/:orderId/returns` : ces mêmes lignes, `requestId`, `reason` et
  `quoteFingerprint`. Une même clé et un même contenu retrouvent le dossier ;
  un contenu différent ou un montant périmé reçoit409.
- `GET /orders/:orderId/returns`, `/brands/:brandId/returns`, `/admin/returns` :
  listes privées paginées, `limit`1–50, `cursor` UUID et `status` facultatif.
  Ajouter `/:id` pour le détail. Les portées et rôles actuels sont vérifiés.
- `POST <route-du-dossier>/actions` : `action` et `expectedVersion` requis.
  Les actions autorisées viennent du détail serveur ; aucun statut libre ni
  montant de remboursement fourni par le client n’est accepté.

La marque accepte avec `instructions` ou refuse avec `reason`. Le client peut
retirer sa demande avant envoi, contester un refus et renseigner le transporteur,
le numéro et un lien HTTPS facultatif. Il peut ensuite corriger le suivi sans
réécrire la date d’envoi. L’admin arbitre une contestation avec une raison visible,
et des instructions en cas d’acceptation ; les décisions précédentes restent
consultables. Les noms d’actions sont `approve`, `reject`, `withdraw`, `dispute`,
`send`, `update_tracking`, `arbitrate_approve`, `arbitrate_reject`, `receive` et
`retry_refund`.

`receive` exige toutes les lignes demandées avec un `restockQuantity` explicite
entre zéro et la quantité retournée. Réception, stock choisi et tentative de
remboursement sont enregistrés dans une transaction. Le worker reprend les
tentatives durables hors requête HTTP, avec lease et clé Stripe stable par
tentative. La recherche paginée des métadonnées retrouve une réponse perdue ;
plusieurs refunds pour une même tentative sont refusés. Un état fournisseur
`pending` ou `requires_action` ne devient pas un succès local. Un échec terminal
permet une nouvelle tentative explicite par la marque ou l’admin.

Après confirmation Stripe, les ajustements de commission conservent les montants
d’origine. Un retour partiel garde la commande livrée ; le dernier remboursement
complet clôt la commande en `refunded`. Les créances sur commissions déjà payées
restent distinctes d’un renversement de transfert Connect, encore à raccorder.
Les anciennes métriques Workspace doivent également intégrer les ajustements et
séparer les devises avant la livraison complète des dashboards.

Migration0019 : dossiers, lignes, tentatives et ajustements avec contraintes et
index. Le rollout pré-lancement ajoute uniquement le code explicite de règle aux
snapshots existants ; les montants et autres conditions sont conservés.
`npx tsx scripts/verify-order-returns.ts` qualifie le parcours en PostgreSQL avec
rollback intégral et sans appel Stripe, depuis le profil development4014 TEST et
le registre privé de qualification. La file de remboursements doit être vide.

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
