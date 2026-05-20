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
