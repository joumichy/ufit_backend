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

## Notifications transactionnelles

Les nouveaux événements de candidature, paiement confirmé, expédition, annulation
et retour enregistrent un message et son envoi e-mail dans la transaction métier.
La migration `0024_notification_email_outbox.sql` ne crée aucun message historique.
L’expéditeur, le destinataire et le contenu d’une tentative sont conservés pour
réutiliser la même clé Resend après une réponse perdue. Les réservations expirées
sont reprises ; un accusé d’une ancienne réservation est ignoré. Un résultat
`accepted` signifie accepté par Resend, pas reçu dans une boîte destinataire.

`NOTIFICATION_EMAIL_ENABLED` vaut `false` par défaut. L’activer seulement avec
une clé Resend et une adresse sur un domaine associé à Ufit et vérifié chez le
fournisseur, `RESEND_FROM_NAME=Ufit`, l’origine officielle et le chemin `/emails`.
Le profil sélectionné reste propriétaire de ces valeurs ; aucun autre profil ni
domaine d’un autre projet ne doit être utilisé pour compléter sa configuration.
Le worker envoie au plus deux messages à la fois, avec un délai HTTP plafonné à
15 secondes. Après expiration de la fenêtre d’idempotence du fournisseur, une
réponse inconnue reste `uncertain` et ne provoque pas un nouvel envoi automatique.
Les envois vers une adresse changée ou un compte supprimé sont annulés avant
réservation d’une nouvelle tentative.

Les liens `ufit://notifications/<id>` portent uniquement l’identité du message.
`GET /notifications/:id` exige le compte destinataire et résout sa destination
sur la ressource actuelle : candidature créateur/marque, commande client/marque
ou retour client/marque. Une expédition ouvre sa vraie commande. Les droits de
marque sont revérifiés à l’ouverture ; aucun contenu n’est exposé à un autre
compte. La réponse déclare `Cache-Control: private, no-store` et l’app demande
une lecture fraîche avant le routage. L’ouverture iOS reprend après connexion
ou relancement ; les notifications ne dépendent pas de la première page d’une
liste. APNs et réception fournisseur restent à compléter avant une
livraison complète des notifications.

`GET /notifications/preferences/:userId` et `PUT` sur la même ressource sont
réservés au compte métier identifié par le jeton et par le chemin. Un changement
de compte pendant une requête ne réattribue pas les préférences à son nouveau
destinataire. `PUT` reçoit exactement `expectedVersion`, `emailEnabled` et
`pushEnabled`. La réponse porte `userId`, `version`, les deux choix et `updatedAt` ;
elle déclare aussi `Cache-Control: private, no-store`. Sans ligne enregistrée,
les canaux sont autorisés par défaut, `version` vaut 0 et `updatedAt` vaut null ;
`GET` ne crée aucune ligne. Une modification verrouille le compte, compare sa
version et renvoie 409 si elle a changé. La migration 0025 crée uniquement la table
de préférences, sans rejouer l’historique.

Désactiver l’e-mail annule les envois en attente ou à retenter de ce destinataire.
Une nouvelle notification désactivée conserve une enveloppe annulée ; chaque
réservation relit le choix courant. Les messages déjà en cours peuvent encore
arriver. Réactiver un canal ne remet pas les anciens messages en file.
`pushEnabled` est le choix de réception du compte ; il ne constitue ni une
autorisation iOS, ni un enregistrement d’appareil, ni une preuve de livraison.

Contrôles backend : `npm run build`, `npx tsc --noEmit`, `npm test -- --maxWorkers=2`.
Le script `scripts/verify-notification-emails.ts` est réservé à la qualification
sur le profil de développement port4014/Stripe TEST. Il vérifie les contrats SQL
et producteurs dans une transaction annulée, sans appel au fournisseur ; les
empreintes de toutes les tables préexistantes doivent rester identiques. Avant
application de0024, le lancer avec `--with-migration` pour examiner aussi le DDL
sans le conserver. Il ne constitue ni une preuve de réception e-mail, ni une
qualification du parcours iOS.

Après la migration 0025 et un build, `node dist/scripts/verify-notification-preferences.js`
vérifie les préférences et leur effet sur la file dans une transaction annulée,
sur le même profil de qualification. Il ne contacte aucun fournisseur.

Le transport `ApnsPushTransport` utilise HTTP/2, une clé ES256/P-256 et le topic
fixe `com.stellark.ufit`. Chaque instance est liée à un seul environnement et à
sa propre configuration Apple ; aucune clé de repli n’est sélectionnée. Les
connexions et le JWT sont réutilisés. Le payload contient une alerte Ufit générique
et le seul `notificationId`, destiné au lecteur privé existant après ouverture.
Le transport attend les réglages HTTP/2 du serveur ; une fenêtre sans flux ne
crée aucune requête. Un refus explicite avant traitement reste retentable, tandis
qu’un flux potentiellement traité conserve son résultat inconnu.

Une réponse APNs 200 vide avec l’identifiant exact signifie accepté, sans prouver
la réception. Une réponse perdue après soumission reste inconnue, sans second POST
automatique : `apns-id` assure la corrélation. Les 5xx explicites attendent au moins
15 minutes avant reprise ; les 410 conservent le timestamp fournisseur en
millisecondes pour le futur contrôle d’une inscription plus récente. Les tokens
ont une longueur variable. La fermeture libère aussi une connexion en préparation.

Ce transport est qualifié avec un serveur HTTP/2 local et des clés éphémères de
test ; les connexions TLS/h2 aux deux hôtes Apple ont été vérifiées sans POST.
L'outbox/worker push et leur activation sont décrits ci-dessous ; l'adaptateur
iOS reste à raccorder. Aucun envoi APNs n’est activé par la seule
présence de cette classe, et aucune réception réelle n’est encore qualifiée.

La migration 0026 ajoute le registre des installations, leurs associations de
session et les identifiants d’enregistrement consommés. Le serveur conserve
uniquement le SHA-256 de la preuve privée d’installation. Les routes suivantes
reçoivent cette preuve via `x-ufit-installation-key` :

- `GET /notifications/installations/:installationId`, authentifié : état privé,
  version et association courante ; absence virtuelle en version 0 sans écriture.
- `PUT /notifications/installations/:installationId/accounts/:userId`, authentifié
  par ce même compte métier : corps exact `expectedVersion`, `associationId`,
  `registrationId`, `deviceToken`, `environment`. Le token est de longueur variable.
- `DELETE /notifications/installations/:installationId/associations/:associationId`,
  corps exact `{}`, sans JWT : la preuve privée permet de finir ce détachement
  après expiration de la session. La cible est consommée même si son PUT n'est
  pas encore arrivé ; il sera refusé ensuite. Une ancienne cible est acquittée
  sans modifier une association plus récente.

Ces réponses sont privées et non mises en cache. Elles ne retournent ni preuve,
ni hash, ni token, ni identité d’un autre compte. Une association fermée ne peut
pas être rouverte ; une nouvelle session utilise un nouvel identifiant. Une
opération d’enregistrement déjà consommée ne peut pas changer de corps. Son replay
exact est sans effet tant qu’elle reste le dernier enregistrement actif. Une
collision d’endpoint APNs actif avec une autre installation renvoie un conflit.

L’invalidation interne utilise l’association et l’enregistrement réservés ; une
ancienne réponse APNs ne désactive pas un token réinscrit depuis. Le registre
serveur n’atteste pas l’autorisation iOS ni la réception. La file push est décrite
ci-dessous ; le client iOS reste à raccorder. Après un build,
`node dist/scripts/verify-notification-installations.js`
qualifie le contrat et les contraintes dans une transaction annulée sur le seul
profil de développement 4014/Stripe TEST, sans envoi fournisseur.


### File push et activation APNs

`0027_notification_push_deliveries.sql` ajoute la file persistante. Le producteur
crée les livraisons dans sa transaction, pour les associations actives du
nouveau message uniquement. Inscription d'un appareil et réactivation push ne
rejouent pas l'historique. Une livraison est liée à son installation, sa session
et son environnement ; sa durée de validité opérationnelle est de 24 heures.

`NOTIFICATION_PUSH_ENABLED=false` par défaut : le worker ne réserve rien et ne
construit aucune connexion APNs. Pour l'activer, fournir dans le seul profil Ufit
sélectionné `APNS_ENVIRONMENT=development` ou `production`, `APNS_KEY_ID`,
`APNS_TEAM_ID` et `APNS_PRIVATE_KEY` (clé privée P-256 PEM). `APNS_TIMEOUT_MS` est
facultatif ; le transport valide sa limite. Une configuration activée incomplète
fait échouer le démarrage avant réservation. L'environnement est explicite, sans
bascule automatique ; les origines Apple et le topic `com.stellark.ufit` restent
possédés par le transport. Ne pas réutiliser les clés d'un autre projet.

La réservation récupérable précède la tentative persistée avant POST. Le worker
recontrôle compte, association, préférences et droit d'ouvrir la ressource ; il
relit le token courant avant les tentatives sûres. Aucun verrou DB pendant le
réseau. Une réponse inconnue ou une lease de tentative expirée devient incertaine,
sans renvoi automatique. Seuls les refus explicitement non traités sont repris,
en respectant le délai du fournisseur et l'expiration. Un refus d'authentification
Apple attend au moins 15 minutes pour permettre la correction de la configuration,
sans renouveler l'historique ; l'UUID APNs reste stable,
sans promesse de réception exactement une fois. Un message déjà en vol peut
encore arriver après désactivation ou changement de compte ; son texte est
neutre et son ouverture reste autorisée séparément.

Désactiver push annule les réservations/attentes et interdit une future reprise
des tentatives en vol. Réactiver ne ressuscite pas ces livraisons. Une réponse
de token invalide ne désactive que son enregistrement toujours courant ; un
ancien 410 ne désactive pas une réinscription plus récente.

Après un build, `node dist/scripts/verify-notification-pushes.js` qualifie les
transactions/états sur PostgreSQL avec rollback. `--with-migration` valide 0027 en
transaction annulée avant son application supportée. Le script
`verify-notification-push-concurrency.js` est réservé au profil development 4014 /
Stripe TEST, envois désactivés : deux connexions conservent réellement leurs
réservations en concurrence, puis deux démarrages disputent la même réservation.
Il utilise le registre privé du propriétaire courant ; ses nouveaux messages de
qualification sont conservés, leurs envois annulés et son installation détachée.
Ces contrôles ne prouvent ni enregistrement OS d'un appareil ni réception APNs.


### Détachement avant une inscription en vol

`0028_notification_installation_detachments.sql` consomme les cibles de session
sous le verrou d'installation, même si un DELETE arrive avant leur PUT. Une
cible consommée ne peut plus être inscrite avec une version relue ou une nouvelle
opération ; une nouvelle session utilise une autre association. Deux UUID par
cible sont conservés, sans token ni identité de compte. Les contraintes SQL
interdisent leur réouverture et exigent la fermeture d'une association existante.

Pour une installation encore absente, le DELETE établit son identité privée en
`detached`, version 1, puis consomme la cible. Ce changement ne signifie pas qu'un
appareil s'est enregistré auprès d'APNs. GET reste sans écriture : son état
virtuel 0 n'existe que tant qu'aucune opération n'a créé l'installation. Le replay
d'un détachement ne change ni sa version ni celle d'une session suivante ; un
ancien DELETE n'empêche pas une autre association de continuer normalement.

`node dist/scripts/verify-notification-detachments.js` vérifie ces ordres et les
contraintes sur PostgreSQL en rollback, dans le seul profil development 4014 /
Stripe TEST avec envois désactivés. `--with-migration` précontrôle 0028 en transaction
annulée avant son application par le migrateur supporté. Aucun fournisseur n'est
contacté par ce script.

## Images de compte et de profils

Le module `media` possède l'upload privé et la sélection de la photo du compte,
du portrait créateur et du logo marque. `kind` vaut `account`, `creator` ou
`brand` ; `ownerId` est l'identité du compte ou du profil correspondant.

- `POST /media/profile-uploads` : multipart `kind`, `ownerId`, `requestId` et
  `file` JPEG, au plus 8 Mio. Renvoie `{kind, ownerId, id, url, displayUrl}`.
  La même requête réutilise son objet immuable ; des octets ou un propriétaire
  différents avec le même `requestId` sont refusés. L'upload ne publie rien.
- `GET /media/profile-images/:kind/:ownerId` : document propriétaire
  `{kind, ownerId, version, image}`. `image` est `null` ou `{id, url, displayUrl}`.
  `id` est explicitement `null` pour un avatar externe initial issu du fournisseur
  d'identité. `url` est la référence durable ; `displayUrl` sert au rendu immédiat.
- `PUT /media/profile-images/:kind/:ownerId` :
  `{requestId, expectedVersion, assetId}` ; `assetId: null` retire la photo.
  Renvoie uniquement `{requestId, version}`, reçu de la commande acceptée.
  Relire le document pour afficher la sélection actuelle : un ancien reçu
  rejoué reste identique, même après une autre sélection. Une version obsolète,
  une requête réutilisée avec un autre contenu ou un média étranger sont refusés
  avec409. Les champs omis et représentations par URL sont refusés avec400.
- `GET /media/profile-assets/:id/private` : lecture propriétaire d'un upload prêt,
  y compris avant sélection, avec nouvelle URL d'affichage signée.
- `GET /media/profile-assets/:id/image` : redirection publique seulement pour le
  portrait ou logo sélectionné d'un profil public actif. Les photos personnelles,
  médias non sélectionnés et portraits de créateurs dont le compte est suspendu
  n'ont pas de lecture publique. Une ancienne URL signée expire selon la durée
  du stockage (60 secondes) ; retirer la référence publique ne révoque pas une
  URL signée déjà émise.

L'utilisateur actif, son rôle actuel et la propriété créateur ou l'appartenance
active à la marque sont relus côté serveur. Les profils professionnels actifs
et en pause sont modifiables ; les profils suspendus ne le sont pas. Les PATCH
textuels `/me` et `/creators/me` ne permettent plus d'écrire `avatarUrl`.
Le logo public utilise `logoUrl` dans le profil marque, et `avatarUrl` dans la
projection générique d'auteur d'une tenue.

Migration additive `0031_profile_images.sql` : registre privé, reçus durables,
versions des trois propriétaires et logo marque. Le bucket `ufit-profile-media`
est privé, JPEG uniquement, limité à8Mio. La suppression du compte retire les
photos personnelles/créateur et les médias des marques sans propriétaire actif ;
une marque qui continue avec un autre propriétaire conserve son logo sélectionné.
L'effacement utilise le même marqueur immuable que les autres médias. Les
identifiants des anciens reçus subsistent après l'effacement de l'objet.

`npx tsx scripts/verify-profile-images.ts` vérifie les contrats et états sur
PostgreSQL dans une transaction annulée. Cette preuve backend, les tests et le
build ne qualifient pas la sélection Photos ni les parcours iOS.
