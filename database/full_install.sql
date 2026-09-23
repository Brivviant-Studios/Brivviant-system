-- BRIVVIANT STUDIO REALTIME TASK SYSTEM
-- Fresh-install reference. The live Studio project is already configured.
-- Run only on a NEW Supabase project, not on the current production project.

create extension if not exists pgcrypto;
create schema if not exists bv_private;
revoke all on schema bv_private from public, anon, authenticated;

create table if not exists public.bv_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9.]{3,40}$'),
  name text not null,
  role text not null check (role in ('ceo','coordinator','employee')),
  active boolean not null default true,
  must_change boolean not null default true,
  created_at timestamptz not null default now(),
  touched_at timestamptz not null default now()
);

create table if not exists public.bv_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 180),
  brief text not null,
  drive_url text not null check (drive_url ~ '^https://(drive|docs)\.google\.com/'),
  due_at timestamptz not null,
  round integer not null default 1,
  approved_at timestamptz,
  created_by uuid not null references public.bv_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table if not exists public.bv_assignments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.bv_tasks(id) on delete cascade,
  user_id uuid not null references public.bv_profiles(id),
  round integer not null,
  active boolean not null default true,
  status text not null default 'assigned' check (status in ('assigned','working','paused','submitted')),
  elapsed_ms bigint not null default 0 check (elapsed_ms >= 0),
  running_since timestamptz,
  started_at timestamptz,
  submitted_at timestamptz,
  submission_url text,
  delay_reason text,
  created_at timestamptz not null default now(),
  unique(task_id,user_id,round)
);
create index if not exists bv_assignment_task on public.bv_assignments(task_id,round);
create index if not exists bv_assignment_user on public.bv_assignments(user_id,task_id);

create table if not exists public.bv_requests (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.bv_profiles(id),
  kind text not null check (kind in ('equipment','fault','complaint','other')),
  title text not null,
  body text not null,
  status text not null default 'open' check (status in ('open','progress','done')),
  response text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bv_activity (
  id bigint generated always as identity primary key,
  task_id uuid references public.bv_tasks(id) on delete cascade,
  actor uuid not null references public.bv_profiles(id),
  action text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists bv_activity_task on public.bv_activity(task_id);
create index if not exists bv_activity_actor on public.bv_activity(actor);

alter table public.bv_profiles enable row level security;
alter table public.bv_tasks enable row level security;
alter table public.bv_assignments enable row level security;
alter table public.bv_requests enable row level security;
alter table public.bv_activity enable row level security;

create or replace function bv_private.member_role()
returns text language sql stable security definer set search_path=''
as $$ select role from public.bv_profiles where id=auth.uid() and active $$;
revoke all on function bv_private.member_role() from public, anon, authenticated;

create or replace function bv_private.can_read_task(t uuid)
returns boolean language sql stable security definer set search_path=''
as $$
 select auth.uid() is not null and (
  bv_private.member_role() in ('ceo','coordinator') or (
   bv_private.member_role()='employee' and exists(
    select 1 from public.bv_assignments where task_id=t and user_id=auth.uid() and active
   )
  )
 )
$$;
revoke all on function bv_private.can_read_task(uuid) from public, anon;
grant execute on function bv_private.can_read_task(uuid) to authenticated;

drop policy if exists bv_profile_read on public.bv_profiles;
create policy bv_profile_read on public.bv_profiles for select to authenticated
using (id=auth.uid() or bv_private.member_role() is not null);

drop policy if exists bv_task_read on public.bv_tasks;
create policy bv_task_read on public.bv_tasks for select to authenticated using (bv_private.can_read_task(id));

drop policy if exists bv_assignment_read on public.bv_assignments;
create policy bv_assignment_read on public.bv_assignments for select to authenticated using (bv_private.can_read_task(task_id));

drop policy if exists bv_request_read on public.bv_requests;
create policy bv_request_read on public.bv_requests for select to authenticated
using (bv_private.member_role()='ceo' or (bv_private.member_role() is not null and created_by=auth.uid()));

drop policy if exists bv_activity_read on public.bv_activity;
create policy bv_activity_read on public.bv_activity for select to authenticated using (bv_private.can_read_task(task_id));

grant select on public.bv_profiles,public.bv_tasks,public.bv_assignments,public.bv_requests,public.bv_activity to authenticated;

create or replace function bv_private.deactivate_previous_assignment_rounds()
returns trigger language plpgsql set search_path='' as $$
begin
  update public.bv_assignments
  set active=false,
      elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(clock_timestamp()-running_since))*1000))::bigint end,
      running_since=null,
      status=case when status='working' then 'paused' else status end
  where task_id=new.task_id and user_id=new.user_id and round<new.round and active=true;
  return new;
end $$;
revoke all on function bv_private.deactivate_previous_assignment_rounds() from public,anon,authenticated;
drop trigger if exists bv_deactivate_previous_assignment_rounds on public.bv_assignments;
create trigger bv_deactivate_previous_assignment_rounds
before insert on public.bv_assignments for each row
execute function bv_private.deactivate_previous_assignment_rounds();

create or replace function bv_private.action(p_action text,p jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 u uuid:=auth.uid(); r text; t public.bv_tasks; a public.bv_assignments; x uuid; ids uuid[];
 n timestamptz:=clock_timestamp(); out_id uuid; text_value text;
begin
 select role into r from public.bv_profiles where id=u and active and not must_change;
 if u is null or r is null then raise exception 'سجّل دخولك وغيّر كلمة المرور المؤقتة أولًا.'; end if;

 if p_action='create_task' then
  if r not in ('ceo','coordinator') then raise exception 'إضافة التاسكات للإدارة وإيمي فقط.'; end if;
  if coalesce(trim(p->>'brief'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'البريف وموعد التسليم القادم مطلوبان.'; end if;
  insert into public.bv_tasks(title,brief,drive_url,due_at,created_by)
  values(trim(p->>'title'),p->>'brief',p->>'drive_url',(p->>'due_at')::timestamptz,u) returning id into out_id;
  insert into public.bv_activity(task_id,actor,action) values(out_id,u,'إنشاء التاسك');

 elsif p_action='create_request' then
  if coalesce(trim(p->>'title'),'')='' or coalesce(trim(p->>'body'),'')='' then raise exception 'اكتب عنوان الطلب وتفاصيله.'; end if;
  insert into public.bv_requests(created_by,kind,title,body)
  values(u,p->>'kind',left(p->>'title',180),left(p->>'body',10000)) returning id into out_id;

 elsif p_action='update_request' then
  if r<>'ceo' then raise exception 'إدارة الطلبات للـCEO فقط.'; end if;
  update public.bv_requests set status=p->>'status',response=left(coalesce(p->>'response',''),10000),updated_at=n
  where id=(p->>'id')::uuid returning id into out_id;
  if out_id is null then raise exception 'الطلب غير موجود.'; end if;

 else
  select * into t from public.bv_tasks where id=(p->>'task_id')::uuid for update;
  if not found or not bv_private.can_read_task(t.id) then raise exception 'التاسك غير متاح.'; end if;
  if coalesce((p->>'version')::integer,-1)<>t.version then raise exception 'التاسك اتحدث من مستخدم آخر. حدّث الصفحة وحاول تاني.'; end if;
  if t.approved_at is not null and p_action not in ('revision','edit_task') then raise exception 'التاسك معتمد بالفعل.'; end if;
  out_id:=t.id;

  if p_action='assign' then
   if r<>'ceo' then raise exception 'توزيع التاسكات للـCEO فقط.'; end if;
   select array_agg(distinct value::uuid) into ids from jsonb_array_elements_text(p->'user_ids');
   if coalesce(cardinality(ids),0)=0 or exists(select 1 from unnest(ids) v where not exists(select 1 from public.bv_profiles where id=v and active and role='employee')) then
    raise exception 'اختر موظفًا واحدًا على الأقل.';
   end if;
   update public.bv_assignments set
    elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
    running_since=null,status=case when status='working' then 'paused' else status end,active=false
   where task_id=t.id and round=t.round and active and not(user_id=any(ids));
   foreach x in array ids loop
    insert into public.bv_assignments(task_id,user_id,round) values(t.id,x,t.round)
    on conflict(task_id,user_id,round) do update set active=true;
   end loop;

  elsif p_action in ('start','pause','resume','submit','delay') then
   select * into a from public.bv_assignments where id=(p->>'assignment_id')::uuid and task_id=t.id and round=t.round and active for update;
   if not found then raise exception 'التاسك غير مسند لهذا الموظف.'; end if;
   if p_action in ('pause','resume') then
    if r<>'ceo' then raise exception 'إيقاف واستكمال التايمر للـCEO فقط.'; end if;
   elsif a.user_id<>u then raise exception 'هذا الإجراء لصاحب التاسك فقط.'; end if;

   if p_action='start' then
    if a.status<>'assigned' then raise exception 'التاسك بدأ بالفعل.'; end if;
    update public.bv_assignments set status='working',running_since=n,started_at=coalesce(started_at,n) where id=a.id;
   elsif p_action='pause' then
    if a.status<>'working' then raise exception 'التايمر غير شغال.'; end if;
    update public.bv_assignments set status='paused',
      elapsed_ms=elapsed_ms+greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint,running_since=null where id=a.id;
   elsif p_action='resume' then
    if a.status<>'paused' then raise exception 'التايمر ليس متوقفًا.'; end if;
    update public.bv_assignments set status='working',running_since=n where id=a.id;
   elsif p_action='delay' then
    if coalesce(trim(p->>'delay_reason'),'')='' then raise exception 'سبب التأخير مطلوب.'; end if;
    update public.bv_assignments set delay_reason=left(p->>'delay_reason',3000) where id=a.id;
   else
    if a.status not in ('working','paused') then raise exception 'ابدأ التاسك قبل التسليم.'; end if;
    if not coalesce((p->>'submission_url') ~ '^https://(drive|docs)\.google\.com/',false) then raise exception 'لينك Drive للتسليم مطلوب.'; end if;
    if n>t.due_at and coalesce(trim(p->>'delay_reason'),trim(a.delay_reason),'')='' then raise exception 'سبب التأخير إجباري.'; end if;
    update public.bv_assignments set status='submitted',
      elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
      running_since=null,submitted_at=n,submission_url=p->>'submission_url',
      delay_reason=coalesce(nullif(trim(p->>'delay_reason'),''),delay_reason) where id=a.id;
   end if;

  elsif p_action='approve' then
   if r<>'ceo' then raise exception 'اعتماد التسليم للـCEO فقط.'; end if;
   if not exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active)
      or exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active and status<>'submitted')
   then raise exception 'لازم كل الموظفين يسلموا التاسك أولًا.'; end if;
   update public.bv_tasks set approved_at=n where id=t.id;

  elsif p_action='revision' then
   if r<>'ceo' then raise exception 'طلب التعديلات للـCEO فقط.'; end if;
   if coalesce(trim(p->>'note'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'وصف التعديل وموعد تسليمه مطلوبان.'; end if;
   if not exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active) then raise exception 'وزع التاسك أولًا.'; end if;
   update public.bv_assignments set
    elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
    running_since=null,status=case when status='working' then 'paused' else status end
   where task_id=t.id and round=t.round;
   insert into public.bv_assignments(task_id,user_id,round)
   select t.id,user_id,t.round+1 from public.bv_assignments where task_id=t.id and round=t.round and active;
   update public.bv_tasks set round=round+1,due_at=(p->>'due_at')::timestamptz,approved_at=null where id=t.id;

  elsif p_action='edit_task' then
   if r<>'ceo' then raise exception 'تعديل التاسك للـCEO فقط.'; end if;
   if coalesce(trim(p->>'brief'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'البريف وموعد التسليم مطلوبان.'; end if;
   update public.bv_tasks set title=trim(p->>'title'),brief=p->>'brief',drive_url=p->>'drive_url',due_at=(p->>'due_at')::timestamptz where id=t.id;
  else
   raise exception 'إجراء غير معروف.';
  end if;

  update public.bv_tasks set version=version+1,updated_at=n where id=t.id;
  text_value:=case p_action when 'assign' then 'توزيع التاسك' when 'start' then 'بدء الشغل'
    when 'pause' then 'إيقاف التايمر' when 'resume' then 'استكمال التايمر' when 'submit' then 'تسليم الشغل'
    when 'delay' then 'توضيح التأخير' when 'approve' then 'اعتماد التسليم' when 'revision' then 'طلب تعديل'
    else 'تعديل التاسك' end;
  insert into public.bv_activity(task_id,actor,action,detail)
  values(t.id,u,text_value,left(coalesce(p->>'note',p->>'delay_reason',''),10000));
 end if;

 update public.bv_profiles set touched_at=n where id=u;
 return jsonb_build_object('id',out_id,'ok',true,'server_time',n);
end $$;
revoke all on function bv_private.action(text,jsonb) from public,anon;
grant execute on function bv_private.action(text,jsonb) to authenticated;

create or replace function public.bv_action(p_action text,p jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select bv_private.action(p_action,p) $$;
revoke all on function public.bv_action(text,jsonb) from public,anon;
grant execute on function public.bv_action(text,jsonb) to authenticated;

create or replace function public.bv_state()
returns jsonb language sql stable security invoker set search_path=''
as $$
 select jsonb_build_object(
 'server_time',clock_timestamp(),
 'profiles',coalesce((select jsonb_agg(x) from public.bv_profiles x),'[]'::jsonb),
 'tasks',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_tasks x),'[]'::jsonb),
 'assignments',coalesce((select jsonb_agg(x) from public.bv_assignments x),'[]'::jsonb),
 'requests',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_requests x),'[]'::jsonb),
 'activity',coalesce((select jsonb_agg(x order by x.created_at desc) from (select * from public.bv_activity order by created_at desc limit 200) x),'[]'::jsonb)
 )
$$;
revoke all on function public.bv_state() from public,anon;
grant execute on function public.bv_state() to authenticated;

do $$ begin alter publication supabase_realtime add table public.bv_profiles; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bv_tasks; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bv_assignments; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bv_requests; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bv_activity; exception when duplicate_object then null; end $$;

alter table public.bv_profiles replica identity full;
alter table public.bv_tasks replica identity full;
alter table public.bv_assignments replica identity full;
alter table public.bv_requests replica identity full;
alter table public.bv_activity replica identity full;
