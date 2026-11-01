alter table "ufit"."brand_settings" add column "commerce_policy_version" integer not null default 0;

-- Existing policy content and the other brand settings remain unchanged.
update "ufit"."brand_settings" set "commerce_policy_version" = 1
where "metadata" ? 'commercePolicy';

alter table "ufit"."brand_settings" add constraint "brand_commerce_policy_version_valid"
check ("commerce_policy_version" >= 0 and (("metadata" ? 'commercePolicy') = ("commerce_policy_version" > 0)));
