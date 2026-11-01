-- Adopt standalone covers into the ordered gallery before native editing.
-- Existing photo identities and publication states are retained; changed content
-- advances the revision so an already-open editor cannot overwrite the backfill.
with contract as (select 0 as first_position, 1 as version_step, ''::text as empty_image),
missing_gallery as (
  select o.id, o.cover_image_url
  from "ufit"."outfits" o, contract c
  where o.cover_image_url <> c.empty_image
    and not exists (select from "ufit"."outfit_images" i where i.outfit_id = o.id)
  for update of o
), inserted as (
  insert into "ufit"."outfit_images" (outfit_id, url, position)
  select m.id, m.cover_image_url, c.first_position from missing_gallery m, contract c
  returning outfit_id
)
update "ufit"."outfits" o
set version = o.version + c.version_step, updated_at = now()
from inserted i, contract c where o.id = i.outfit_id;

with contract as (select 1 as version_step), first_image as (
  select distinct on (outfit_id) outfit_id, url
  from "ufit"."outfit_images"
  order by outfit_id, position, id
)
update "ufit"."outfits" o
set cover_image_url = i.url, version = o.version + c.version_step, updated_at = now()
from first_image i, contract c
where o.id = i.outfit_id and o.cover_image_url is distinct from i.url;
