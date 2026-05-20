create unique index if not exists "payments_provider_intent_unique"
  on "ufit"."payments" ("provider", "provider_payment_intent_id")
  where "provider_payment_intent_id" is not null;
