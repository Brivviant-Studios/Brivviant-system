-- Read-only verification queries for the live project.
select username,name,role,active,must_change from public.bv_profiles order by role,name;

select schemaname,tablename
from pg_publication_tables
where pubname='supabase_realtime' and schemaname='public' and tablename like 'bv_%'
order by tablename;

select schemaname,tablename,policyname,roles,cmd
from pg_policies
where schemaname='public' and tablename like 'bv_%'
order by tablename,policyname;

select t.title,t.round,p.name as assignee,a.status,a.elapsed_ms,a.running_since,a.started_at,a.submitted_at
from public.bv_tasks t
left join public.bv_assignments a on a.task_id=t.id and a.active
left join public.bv_profiles p on p.id=a.user_id
order by t.created_at desc,p.name;
