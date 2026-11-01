# UFit Backend - Etat des phases

Dernière mise à jour : 2026-11-01

## Point de passage iOS complète

L’application complète reste en cours de réalisation sur `codex/ios-complete`.
Les phases ci-dessous décrivent le socle MVP historique ; elles ne prouvent pas
la qualification de tous les parcours iPhone ni la mise en production Stripe.

Le cycle natif de publication/modération des tenues est qualifié à la portée du
journal Ufit (mobile4588853/Lab9a137dc), galerie publique et notes comprises
(mobilebf00fc3/Labeda3126). Les validations restent des preuves de développement,
sans livraison de toute l’application ni intégration à charlie.

Les conditions commerciales possèdent une lecture privée et une écriture versionnée
pour marque active/en pause ou administrateur autorisé. La lecture publique et le
contrat de devis restent inchangés. Migration0017 additive appliquée :18migrations
et checksums vérifiés ;189tests/39fichiers, build/types et qualificationAPI/SQL passent.
Concurrence, propriété, rôles/statuts actuels et rollback sont qualifiés ; données
financières existantes conservées. Formulaire propriétaire iOS250a52c/Lab401cac5
qualifié à la portée du journal (persistance, conflits/réseau et régressions).

Commandes marque : lectures privées paginées et projections sans identifiants de
paiement/commission, actions d’expédition versionnées et incidents résolubles.
Migration0018 appliquée,19migrations/checksums vérifiés ;203tests/40fichiers et
build/types passent. API/scopes/pagination,12scénariosSQL avecrollback et
5contrôlesd’annulation qualifiés. Deux commandes concurrentes201/409 : une seule
transition ; incident résolu, commande existante toujours en préparation.
Le parcours iPhone de traitement des commandes reste à construire.

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
