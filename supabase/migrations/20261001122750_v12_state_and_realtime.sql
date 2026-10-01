create or replace function public.bv_state()
returns jsonb language sql stable security invoker set search_path=''
as $$
 select jsonb_build_object(
   'server_time',clock_timestamp(),
   'profiles',coalesce((select jsonb_agg(x order by x.name) from public.bv_profiles x),'[]'::jsonb),
   'tasks',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_tasks x where x.deleted_at is null),'[]'::jsonb),
   'archived_tasks',coalesce((select jsonb_agg(x order by x.deleted_at desc) from public.bv_tasks x where x.deleted_at is not null),'[]'::jsonb),
   'assignments',coalesce((select jsonb_agg(x) from public.bv_assignments x),'[]'::jsonb),
   'task_stages',coalesce((select jsonb_agg(x order by x.task_id,x.sort_order) from public.bv_task_stages x),'[]'::jsonb),
   'quality_flags',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_task_quality_flags x),'[]'::jsonb),
   'revisions',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_task_revisions x),'[]'::jsonb),
   'point_ledger',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_point_ledger x),'[]'::jsonb),
   'requests',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_requests x where x.deleted_at is null),'[]'::jsonb),
   'activity',coalesce((select jsonb_agg(x order by x.created_at desc) from (select * from public.bv_activity order by created_at desc limit 1500) x),'[]'::jsonb)
 )
$$;
revoke all on function public.bv_state() from public,anon;
grant execute on function public.bv_state() to authenticated;

do $$ begin alter publication supabase_realtime add table public.bv_point_ledger; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bv_task_stages; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bv_task_quality_flags; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bv_task_revisions; exception when duplicate_object then null; end $$;
alter table public.bv_point_ledger replica identity full;
alter table public.bv_task_stages replica identity full;
alter table public.bv_task_quality_flags replica identity full;
alter table public.bv_task_revisions replica identity full;
