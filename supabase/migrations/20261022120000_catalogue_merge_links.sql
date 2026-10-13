-- =====================================================================
-- A merged product keeps its picture, branch prices and branch stock
-- (owner, 2026-10-13: "apply chipo merge" was refused by the database,
-- nothing changed). Applied live only after the owner has seen this file
-- and said "apply".
-- Rollback: supabase/rollbacks/20261022120000_catalogue_merge_links.rollback.sql
-- Tested in PGlite: supabase/tests/billing-b-test.js,
-- supabase/tests/chipo-merge-fix-test.js
--
-- cl_business_merge_core (20261021120000) moves the duplicate's catalogue
-- products to the kept business by changing their business_id. Three
-- tables point at a product by (business_id, product_uid) with plain
-- foreign keys, so a product that has a picture (Sothleapark's Kids
-- Sneaker 3-5 Years on live) can't move:
--   "update or delete on table cl_catalogue_products violates foreign key
--    constraint cl_catalogue_images_business_id_product_uid_fkey"
-- The three keys now follow the product (ON UPDATE CASCADE). Nothing else
-- changes: deleting a product is still refused while anything points at it
-- (ON DELETE stays NO ACTION), and no other code changes a product's
-- business_id (only the merge, and its undo data fix).
-- =====================================================================

begin;

-- 0. Preflight: the three keys exist exactly as 20261006/20261007 made them
do $$
declare n int;
begin
  select count(*) into n from pg_constraint
   where contype = 'f' and confrelid = 'public.cl_catalogue_products'::regclass
     and conname in ('cl_catalogue_images_business_id_product_uid_fkey', 'cl_branch_prices_business_id_product_uid_fkey', 'cl_branch_stock_business_id_product_uid_fkey')
     and confupdtype = 'a' and confdeltype = 'a';
  if n <> 3 then
    raise exception 'catalogue_merge_links aborted: expected the 3 product keys without ON UPDATE (found %). Nothing was changed.', n;
  end if;
end $$;

-- 1. The keys follow the product ----------------------------------------
alter table public.cl_catalogue_images drop constraint cl_catalogue_images_business_id_product_uid_fkey;
alter table public.cl_catalogue_images add constraint cl_catalogue_images_business_id_product_uid_fkey
  foreign key (business_id, product_uid) references public.cl_catalogue_products (business_id, product_uid) on update cascade;

alter table public.cl_branch_prices drop constraint cl_branch_prices_business_id_product_uid_fkey;
alter table public.cl_branch_prices add constraint cl_branch_prices_business_id_product_uid_fkey
  foreign key (business_id, product_uid) references public.cl_catalogue_products (business_id, product_uid) on update cascade;

alter table public.cl_branch_stock drop constraint cl_branch_stock_business_id_product_uid_fkey;
alter table public.cl_branch_stock add constraint cl_branch_stock_business_id_product_uid_fkey
  foreign key (business_id, product_uid) references public.cl_catalogue_products (business_id, product_uid) on update cascade;

commit;
