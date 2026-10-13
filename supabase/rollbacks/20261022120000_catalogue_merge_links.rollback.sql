-- Rollback of 20261022120000_catalogue_merge_links.sql
-- (tools/db/apply-migration.js apply <migration> --rollback runs this and
-- deletes the schema_migrations row, in one transaction).
-- The three product keys go back to plain foreign keys (no ON UPDATE), as
-- 20261006120000 and 20261007120000 made them. A merge of a business whose
-- products have pictures or branch prices is then refused again.

begin;

alter table public.cl_catalogue_images drop constraint cl_catalogue_images_business_id_product_uid_fkey;
alter table public.cl_catalogue_images add constraint cl_catalogue_images_business_id_product_uid_fkey
  foreign key (business_id, product_uid) references public.cl_catalogue_products (business_id, product_uid);

alter table public.cl_branch_prices drop constraint cl_branch_prices_business_id_product_uid_fkey;
alter table public.cl_branch_prices add constraint cl_branch_prices_business_id_product_uid_fkey
  foreign key (business_id, product_uid) references public.cl_catalogue_products (business_id, product_uid);

alter table public.cl_branch_stock drop constraint cl_branch_stock_business_id_product_uid_fkey;
alter table public.cl_branch_stock add constraint cl_branch_stock_business_id_product_uid_fkey
  foreign key (business_id, product_uid) references public.cl_catalogue_products (business_id, product_uid);

commit;
