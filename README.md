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

Les réponses privées du catalogue distinguent également `url` et `displayUrl`.
Seule `url` est envoyée dans les écritures produit et conservée dans les snapshots.
Les liens de lecture expirent après60 secondes et se renouvellent à la relecture
du catalogue. `GET /media/assets/:id/image` autorise le téléchargement public si
le produit et la marque sont actifs, ou si une commande ayant atteint `paid`
conserve cette image dans son snapshot. Le bucket demeure privé.
