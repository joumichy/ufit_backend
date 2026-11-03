-- Retire content approval without publishing historical pending content.
update ufit.outfits set status='draft', visibility='private', scheduled_for=null,
  publication_time_zone=null, published_at=null, version=version+1, updated_at=now()
where status::text in ('submitted','under_review','rejected');
alter table ufit.outfits drop constraint outfits_scheduled_private;
drop index ufit.outfits_publication_due_idx;
alter table ufit.outfits alter column status drop default;
alter type ufit.outfit_status rename to outfit_status_retired;
create type ufit.outfit_status as enum ('draft','scheduled','published','archived');
alter table ufit.outfits alter column status type ufit.outfit_status using status::text::ufit.outfit_status;
alter table ufit.outfits alter column status set default 'draft'::ufit.outfit_status;
drop type ufit.outfit_status_retired;
alter table ufit.outfits add constraint outfits_scheduled_private check
  (status<>'scheduled' or (scheduled_for is not null and visibility='private' and published_at is null));
create index outfits_publication_due_idx on ufit.outfits(id) where status='scheduled';
-- reviewed_* and rejection_reason remain as historical storage, outside current API projections.
