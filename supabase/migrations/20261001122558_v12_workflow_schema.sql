create schema if not exists bv_private;

alter table public.bv_profiles drop constraint if exists bv_profiles_role_check;
alter table public.bv_profiles add constraint bv_profiles_role_check check (role in ('ceo','team_leader','coordinator','employee')) not valid;
alter table public.bv_profiles validate constraint bv_profiles_role_check;

alter table public.bv_tasks add column if not exists deleted_at timestamptz;
alter table public.bv_tasks add column if not exists deleted_by uuid references public.bv_profiles(id);
alter table public.bv_tasks add column if not exists owner_user_id uuid references public.bv_profiles(id);
alter table public.bv_tasks add column if not exists workflow_required boolean not null default false;
alter table public.bv_tasks add column if not exists final_approved_by uuid references public.bv_profiles(id);
alter table public.bv_tasks add column if not exists final_approval_note text not null default '';
alter table public.bv_tasks add column if not exists approval_snapshot jsonb;
create index if not exists bv_tasks_deleted_at on public.bv_tasks(deleted_at);
create index if not exists bv_tasks_owner on public.bv_tasks(owner_user_id);

alter table public.bv_assignments add column if not exists deadline_at timestamptz;
alter table public.bv_assignments add column if not exists points_awarded integer not null default 0;
alter table public.bv_assignments add column if not exists points_reason text not null default '';
alter table public.bv_assignments add column if not exists points_calculated_at timestamptz;
update public.bv_assignments a set deadline_at=t.due_at from public.bv_tasks t where a.task_id=t.id and a.deadline_at is null;

alter table public.bv_requests add column if not exists deleted_at timestamptz;
alter table public.bv_requests add column if not exists deleted_by uuid references public.bv_profiles(id);
alter table public.bv_requests add column if not exists execution_due_at timestamptz;
alter table public.bv_requests add column if not exists approved_at timestamptz;
alter table public.bv_requests add column if not exists approved_by uuid references public.bv_profiles(id);
alter table public.bv_requests add column if not exists previous_request_id uuid references public.bv_requests(id);
alter table public.bv_requests add column if not exists attempt_no integer not null default 1;
alter table public.bv_requests add column if not exists escalation_required boolean not null default false;
alter table public.bv_requests add column if not exists rejected_at timestamptz;
alter table public.bv_requests add column if not exists rejected_by uuid references public.bv_profiles(id);
alter table public.bv_requests add column if not exists rejection_reason text;
alter table public.bv_requests add column if not exists leave_from date;
alter table public.bv_requests add column if not exists leave_to date;

alter table public.bv_requests drop constraint if exists bv_requests_kind_check;
alter table public.bv_requests add constraint bv_requests_kind_check check (kind in ('equipment','fault','complaint','leave','other')) not valid;
alter table public.bv_requests validate constraint bv_requests_kind_check;
alter table public.bv_requests drop constraint if exists bv_requests_status_check;
alter table public.bv_requests add constraint bv_requests_status_check check (status in ('open','progress','done','rejected')) not valid;
alter table public.bv_requests validate constraint bv_requests_status_check;

create index if not exists bv_requests_previous on public.bv_requests(previous_request_id);
create index if not exists bv_requests_escalated on public.bv_requests(escalation_required,status,created_at desc) where deleted_at is null;
create index if not exists bv_requests_leave_dates on public.bv_requests(created_by,leave_from,leave_to) where kind='leave';

create table if not exists public.bv_point_ledger (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.bv_profiles(id),
 points integer not null check(points between -10000 and 10000 and points<>0),
 kind text not null,
 task_id uuid references public.bv_tasks(id),
 assignment_id uuid references public.bv_assignments(id),
 reason text not null,
 created_by uuid not null references public.bv_profiles(id),
 created_at timestamptz not null default clock_timestamp()
);
alter table public.bv_point_ledger drop constraint if exists bv_point_ledger_kind_check;
alter table public.bv_point_ledger add constraint bv_point_ledger_kind_check check(kind in ('submission','manual_adjustment','project_score')) not valid;
alter table public.bv_point_ledger validate constraint bv_point_ledger_kind_check;
create unique index if not exists bv_point_ledger_assignment_once on public.bv_point_ledger(assignment_id) where kind='submission' and assignment_id is not null;
create unique index if not exists bv_point_ledger_project_once on public.bv_point_ledger(task_id,user_id) where kind='project_score' and task_id is not null;
create index if not exists bv_point_ledger_user_month on public.bv_point_ledger(user_id,created_at desc);
create index if not exists bv_point_ledger_task on public.bv_point_ledger(task_id);
alter table public.bv_point_ledger enable row level security;
revoke all on public.bv_point_ledger from anon,authenticated;
grant select on public.bv_point_ledger to authenticated;

create table if not exists public.bv_task_stages (
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references public.bv_tasks(id) on delete cascade,
 stage_key text not null,
 title_ar text not null,
 title_en text not null,
 sort_order integer not null check(sort_order between 1 and 50),
 planned_hours numeric(7,2) not null check(planned_hours>0 and planned_hours<=999),
 assigned_user_id uuid not null references public.bv_profiles(id),
 status text not null default 'pending' check(status in ('pending','working','paused','submitted','approved')),
 elapsed_ms bigint not null default 0 check(elapsed_ms>=0),
 running_since timestamptz,
 started_at timestamptz,
 submitted_at timestamptz,
 approved_at timestamptz,
 approved_by uuid references public.bv_profiles(id),
 note text not null default '',
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(task_id,sort_order)
);
create index if not exists bv_task_stages_task on public.bv_task_stages(task_id,sort_order);
create index if not exists bv_task_stages_user on public.bv_task_stages(assigned_user_id,status);
alter table public.bv_task_stages enable row level security;
revoke all on public.bv_task_stages from anon,authenticated;
grant select on public.bv_task_stages to authenticated;

create table if not exists public.bv_task_quality_flags (
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references public.bv_tasks(id) on delete cascade,
 stage_id uuid references public.bv_task_stages(id) on delete set null,
 user_id uuid not null references public.bv_profiles(id),
 kind text not null check(kind in ('error_revision','negligent_pause')),
 note text not null,
 created_by uuid not null references public.bv_profiles(id),
 created_at timestamptz not null default clock_timestamp()
);
create index if not exists bv_quality_task_user on public.bv_task_quality_flags(task_id,user_id,created_at desc);
alter table public.bv_task_quality_flags enable row level security;
revoke all on public.bv_task_quality_flags from anon,authenticated;
grant select on public.bv_task_quality_flags to authenticated;

create table if not exists public.bv_task_revisions (
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references public.bv_tasks(id) on delete cascade,
 round integer not null,
 note text not null,
 due_at timestamptz,
 is_error boolean not null default false,
 responsible_user_id uuid references public.bv_profiles(id),
 created_by uuid not null references public.bv_profiles(id),
 created_at timestamptz not null default clock_timestamp()
);
create index if not exists bv_revisions_task on public.bv_task_revisions(task_id,created_at desc);
alter table public.bv_task_revisions enable row level security;
revoke all on public.bv_task_revisions from anon,authenticated;
grant select on public.bv_task_revisions to authenticated;

alter table public.bv_activity add column if not exists stage_id uuid references public.bv_task_stages(id) on delete set null;

create table if not exists public.bv_push_subscriptions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.bv_profiles(id) on delete cascade,
 endpoint text not null,
 p256dh text not null,
 auth text not null,
 user_agent text not null default '',
 active boolean not null default true,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(user_id,endpoint)
);
alter table public.bv_push_subscriptions enable row level security;
revoke all on public.bv_push_subscriptions from anon,authenticated;

create table if not exists bv_private.push_config (
 id integer primary key check(id=1),
 vapid_public text,
 vapid_private text,
 internal_secret text not null default(gen_random_uuid()::text||gen_random_uuid()::text),
 updated_at timestamptz not null default clock_timestamp()
);
insert into bv_private.push_config(id) values(1) on conflict(id) do nothing;
revoke all on bv_private.push_config from public,anon,authenticated;

create or replace function bv_private.can_read_task(t uuid)
returns boolean language sql stable security definer set search_path=''
as $$
 select auth.uid() is not null and (
  (select bv_private.member_role()) in ('ceo','team_leader','coordinator')
  or exists(select 1 from public.bv_assignments a where a.task_id=t and a.user_id=(select auth.uid()))
  or exists(select 1 from public.bv_task_stages s where s.task_id=t and s.assigned_user_id=(select auth.uid()))
 )
$$;
revoke all on function bv_private.can_read_task(uuid) from public,anon;
grant execute on function bv_private.can_read_task(uuid) to authenticated;

drop policy if exists bv_task_read on public.bv_tasks;
create policy bv_task_read on public.bv_tasks for select to authenticated using(bv_private.can_read_task(id));
drop policy if exists bv_assignment_read on public.bv_assignments;
create policy bv_assignment_read on public.bv_assignments for select to authenticated using(bv_private.can_read_task(task_id));
drop policy if exists bv_request_read on public.bv_requests;
create policy bv_request_read on public.bv_requests for select to authenticated using((select bv_private.member_role()) in ('ceo','team_leader') or created_by=(select auth.uid()));
drop policy if exists bv_activity_read on public.bv_activity;
create policy bv_activity_read on public.bv_activity for select to authenticated using((select bv_private.member_role()) in ('ceo','team_leader') or (task_id is not null and bv_private.can_read_task(task_id)));
drop policy if exists bv_point_ledger_read on public.bv_point_ledger;
create policy bv_point_ledger_read on public.bv_point_ledger for select to authenticated using(user_id=(select auth.uid()) or (select bv_private.member_role()) in ('ceo','team_leader'));
drop policy if exists bv_stage_read on public.bv_task_stages;
create policy bv_stage_read on public.bv_task_stages for select to authenticated using(bv_private.can_read_task(task_id));
drop policy if exists bv_quality_read on public.bv_task_quality_flags;
create policy bv_quality_read on public.bv_task_quality_flags for select to authenticated using((select bv_private.member_role()) in ('ceo','team_leader') or user_id=(select auth.uid()));
drop policy if exists bv_revision_read on public.bv_task_revisions;
create policy bv_revision_read on public.bv_task_revisions for select to authenticated using(bv_private.can_read_task(task_id));
