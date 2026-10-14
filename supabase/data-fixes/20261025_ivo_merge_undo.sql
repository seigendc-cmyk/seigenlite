-- One-off DATA fix (no schema change): UNDO 20261025_ivo_merge.sql, only if
-- the owner decides IVO Dist should come back. Run only after the owner has
-- seen this file and said "apply":
--   node tools/db/run-data-fix.js apply supabase/data-fixes/20261025_ivo_merge_undo.sql
-- Takes the three archive labels off again (IVO Dist and its two device
-- rows). The merge moved and deleted nothing, so nothing else changes.
-- Checks itself first and raises (changing nothing) unless the three are
-- archived exactly as the merge left them.
-- Design: docs/billing/ivo-merge-design.md ("Undo").
begin;

do $$
declare
  v_dist constant uuid := 'c8d4116c-d88d-426e-aa25-b2aff24c33c7';   -- IVO Dist
  v_ven  constant uuid[] := array['faa5d2ea-a722-4e42-ab04-30ed8d3847df', 'e8e4438f-2e4b-444e-92a6-e1ee957272ae']::uuid[];
  c_mark constant text := 'IVO merge (owner, 2026-10-14):%';
begin
  if (select count(*) from cl_businesses where id = v_dist and archived_at is not null and archive_reason like c_mark) <> 1 then
    raise exception 'ivo_merge_undo aborted: IVO Dist isn''t archived by the IVO merge. Nothing was changed.';
  end if;
  if (select count(*) from cl_vendors where id = any(v_ven) and archived_at is not null and archive_reason like c_mark) <> 2 then
    raise exception 'ivo_merge_undo aborted: IVO Dist''s two device rows aren''t both archived by the IVO merge. Nothing was changed.';
  end if;

  perform set_config('cl.archive_note', 'Undo of the IVO merge (20261025_ivo_merge_undo)', true);   -- the unarchive log's reason
  update cl_businesses set archived_at = null, archived_by = null, archive_reason = null where id = v_dist;
  update cl_vendors set archived_at = null, archived_by = null, archive_reason = null where id = any(v_ven);
  perform set_config('cl.archive_note', '', true);
  raise notice 'AFTER: IVO Dist and its 2 device rows are no longer archived';
end $$;

commit;
