# UFit Backend - Etat des phases

Dernière mise à jour : 2026-11-02

## État actif : recherche de tenues

Travail courant mobile/backend sur `charlie`. GET `outfits` recherche et filtre
avant pagination UUID : `q`, `scope`, `styleId`, `occasionId`, `itemType`.
GET `outfits/discovery` expose les styles/occasions du registre et les types de
pièce canoniques. Les auteurs et articles non publics ne servent pas de résultat
indirect. Aucun changement de schéma :32migrations/checksums et65tables.
Build/types et531tests backend passent ;23scénarios PostgreSQL avec rollback
et13cas HTTP réels qualifient les contrats. Parcours natifs et limites dans la
[checklist Ufit](../../docs/ufit_ios_complete_checklist.md) et le journal découverte.
Aucune livraison globale ni qualification Stripe de production déduite de ce lot.

## Socle images de profils

Travail courant mobile/backend sur `charlie`. Le socle des images de compte,
portrait créateur et logo marque est raccordé au module média : upload privé,
sélection versionnée/idempotente, diffusion publique limitée et intégration de
l'effacement du compte. Migration0031 appliquée ;32checksums,65tables. Les preuves
PostgreSQL/HTTP sont consignées dans le journal Ufit du lot profile-images.
Le suivi du raccordement Photos et de sa qualification iOS est possédé par la
[checklist Ufit](../../docs/ufit_ios_complete_checklist.md) et son journal natif.
Aucune livraison globale ni transaction Stripe de production n’est déduite du
socle serveur.

## Historique du premier point de passage iOS complète

L’application complète reste en cours de réalisation sur `codex/ios-complete`.
Les phases ci-dessous décrivent le socle MVP historique ; elles ne prouvent pas
la qualification de tous les parcours iPhone ni la mise en production Stripe.

Le cycle natif de publication/modération des tenues est qualifié à la portée du
journal Ufit (mobile4588853/Lab9a137dc), galerie publique et notes comprises
(mobilebf00fc3/Labeda3126). Les validations restent des preuves de développement,
sans livraison de toute l’application ni intégration à charlie.

Les conditions commerciales possèdent une lecture privée et une écriture versionnée
pour marque active/en pause ou administrateur autorisé. La lecture publique est
conservée ; le devis porte désormais le code de remboursement décrit ci-dessous.
Migration0017 additive appliquée :18migrations
et checksums vérifiés ;189tests/39fichiers, build/types et qualificationAPI/SQL passent.
Concurrence, propriété, rôles/statuts actuels et rollback sont qualifiés ; données
financières existantes conservées. Formulaire propriétaire iOS250a52c/Lab401cac5
qualifié à la portée du journal (persistance, conflits/réseau et régressions).

Commandes marque : lectures privées paginées et projections sans identifiants de
paiement/commission, actions d’expédition versionnées et incidents résolubles.
Migration0018 appliquée,19migrations/checksums vérifiés ;203tests/40fichiers et
build/types passent. API/scopes/pagination,12scénariosSQL avecrollback et
5contrôlesd’annulation qualifiés. Deux commandes concurrentes201/409 : une seule
transition. Le cycle natif marque/client est maintenant qualifié à la portée du
journal : expédition, incident, résolution, correction du suivi et livraison
persistante (mobile791a7e8/Lab b15586e). Préparation native depuis un achat neuf,
pagination native>20 et accessibilité globale restent ouvertes.

Retours : options/prévisualisation serveur, création idempotente avec fingerprint,
décisions versionnées, scopes client/marque/admin, réception/stock/tentative
atomiques et worker de remboursement sont raccordés. Migration0019 appliquée :
20 migrations/checksums vérifiés, montants historiques conservés ;238tests dans
43fichiers et build/types passent. SQL réel :13cas avec rollback ; vérificateur
maintenu :9scénarios, trois retours avec taxes cumulatives et livraison finale,
aucune ligne persistée ni appel Stripe.

API réelle et Stripe TEST : refus marque, contestation et arbitrage admin, puis
réception concurrente201/409 ; un seul remboursement partiel de12990CHF confirmé
par le worker et Stripe, stock+1 une fois, commission d’origine conservée avec
ajustement. Une unité de la commande reste pour le parcours natif. Écrans de
retour SwiftUI/Lab et remboursement final13790CHF à qualifier. Dashboards par
devise, créances sur commissions payées et transferts/réversions Connect restent
ouverts ; aucune production ni application complète livrée n’est revendiquée.

## Socle MVP historique

| Phase | Statut | Etat |
|---:|---|---|
| 0 | Complete | Plan d'action, regles Codex UFit et direction produit integres. |
| 1 | Complete | Fondation NestJS, Drizzle, Supabase schema `ufit`, health check et migration `0000`. |
| 2 | Complete | Identity, Supabase JWT, roles, guards et endpoints `/me`. |
| 3 | Complete | Candidatures createurs/marques, review admin et provisioning des profils. |
| 4 | Complete | Profils createurs/marques, slugs, membership marque et controles de statut. |
| 5 | Complete | Produits, variantes, images et workflow de validation admin. |
| 6 | Complete | Outfits, pieces, images, validation produits actifs et calculs serveur. |
| 7 | Complete | Feed public, detail outfit et collections editoriales. |
| 8 | Complete | Save/unsave outfits, follow/unfollow createurs et liste `GET /me/saved-outfits` persistants. |
| 9 | Complete | Panier mono-marque persistant avec recalcul catalogue cote serveur. |
| 10 | Complete | Checkout Stripe test via Checkout Sessions, raw webhook, signature optionnelle et idempotence `stripe_event_id`. |
| 11 | Complete | Commandes `pending_payment`, confirmation webhook, decrement stock atomique et shipment `pending`. |
| 12 | Complete | Commissions `pending`, regles par marque/produit/grade et bonus grade createur. |
| 13 | Complete | Endpoints admin summaries/queues, audit Drizzle et protections roles admin. |
| 14 | A faire | Integration iOS principale. |
| 15 | Complete backend | Endpoints backend createur/marque, projections dashboard, listes scopees et tests. |
| 16 | A faire | Jobs, notifications et observabilite. |
| 17 | Partiel | Build, tests, audit production, migrations et smoke health OK; revue production finale restante. |
| 18 | A faire | Evolutions post-MVP. |

## Validations

| Date | Commande | Resultat |
|---|---|---|
| 2026-05-20 | `npm run db:migrate` | `0005` et `0006` appliques, migrations precedentes deja tracees. |
| 2026-05-20 | `npm run db:verify` | Schema `ufit` present, 7 migrations tracees. |
| 2026-05-20 | `npm run build` | OK. |
| 2026-05-20 | `npm test` | 24 fichiers, 83 tests OK. |
| 2026-05-20 | `npm audit --omit=dev` | 0 vulnerabilite production. |
| 2026-05-20 | `API_PORT=4013 npm start` + `GET /health` | App compilee demarree, `status: ok`, schema `ufit`. |
| 2026-05-20 | `npm test -- test/workspaces/workspaces.service.test.ts test/security.e2e.test.ts` | Projections createur/marque et scopes OK. |
| 2026-05-20 | `API_PORT=4015 npm start` + `GET /health` | App compilee demarree avec routes workspace, `status: ok`. |
