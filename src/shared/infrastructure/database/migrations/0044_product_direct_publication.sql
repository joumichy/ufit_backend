-- A pending or rejected product becomes a private draft for its owner to publish explicitly.
update ufit.products set status='draft', version=version+1, updated_at=now()
where status::text in ('under_review','rejected');
alter table ufit.products alter column status drop default;
alter type ufit.product_status rename to product_status_retired;
create type ufit.product_status as enum ('draft','active','archived');
alter table ufit.products alter column status type ufit.product_status using status::text::ufit.product_status;
alter table ufit.products alter column status set default 'draft'::ufit.product_status;
drop type ufit.product_status_retired;
-- Historical moderation columns are preserved, but are no longer returned or mutated by publication.
