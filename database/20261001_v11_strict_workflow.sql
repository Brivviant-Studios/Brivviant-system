-- BRIVVIANT V11 — strict archive, durable points ledger, request escalation, management reporting.
-- Additive/idempotent migration for the live Studio project.

create schema if not exists bv_private;

-- ---------------------------------------------------------------------------
-- Roles / task archive compatibility
-- ---------------------------------------------------------------------------
alter table public.bv_profiles drop constraint if exists bv_profiles_role_check;
alter table public.bv_profiles
  add constraint bv_profiles_role_check
  check (role in ('ceo','team_leader','coordinator','employee')) not valid;
alter table public.bv_profiles validate constraint bv_profiles_role_check;

alter table public.bv_tasks add column if not exists deleted_at timestamptz;
alter table public.bv_tasks add column if not exists deleted_by uuid references public.bv_profiles(id);
create index if not exists bv_tasks_deleted_at on public.bv_tasks(deleted_at);

-- ---------------------------------------------------------------------------
-- Assignment score snapshot (automatic task score remains on the assignment)
-- ---------------------------------------------------------------------------
alter table public.bv_assignments add column if not exists deadline_at timestamptz;
alter table public.bv_assignments add column if not exists points_awarded integer not null default 0;
alter table public.bv_assignments add column if not exists points_reason text not null default '';
alter table public.bv_assignments add column if not exists points_calculated_at timestamptz;

update public.bv_assignments a
set deadline_at=t.due_at
from public.bv_tasks t
where a.task_id=t.id and a.deadline_at is null;

-- ---------------------------------------------------------------------------
-- Durable points ledger: task deletion/archive can never erase score history.
-- ---------------------------------------------------------------------------
create table if not exists public.bv_point_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.bv_profiles(id),
  points integer not null check (points between -10000 and 10000 and points <> 0),
  kind text not null check (kind in ('submission','manual_adjustment')),
  task_id uuid references public.bv_tasks(id),
  assignment_id uuid references public.bv_assignments(id),
  reason text not null,
  created_by uuid not null references public.bv_profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists bv_point_ledger_assignment_once
  on public.bv_point_ledger(assignment_id) where kind='submission' and assignment_id is not null;
create index if not exists bv_point_ledger_user_month on public.bv_point_ledger(user_id,created_at desc);
create index if not exists bv_point_ledger_task on public.bv_point_ledger(task_id);

alter table public.bv_point_ledger enable row level security;
revoke all on public.bv_point_ledger from anon, authenticated;
grant select on public.bv_point_ledger to authenticated;

drop policy if exists bv_point_ledger_read on public.bv_point_ledger;
create policy bv_point_ledger_read on public.bv_point_ledger for select to authenticated
using (
  user_id=(select auth.uid())
  or (select bv_private.member_role()) in ('ceo','team_leader')
);

-- Backfill historical automatic points exactly once. 0-point submissions need no ledger row.
insert into public.bv_point_ledger(user_id,points,kind,task_id,assignment_id,reason,created_by,created_at)
select a.user_id,a.points_awarded,'submission',a.task_id,a.id,
       coalesce(nullif(a.points_reason,''),'نقاط تسليم سابقة'),
       coalesce(t.created_by,a.user_id),coalesce(a.points_calculated_at,a.submitted_at,clock_timestamp())
from public.bv_assignments a
join public.bv_tasks t on t.id=a.task_id
where a.submitted_at is not null and coalesce(a.points_awarded,0)<>0
on conflict (assignment_id) where kind='submission' and assignment_id is not null do nothing;

-- ---------------------------------------------------------------------------
-- Requests: leave type, rejection history and automatic escalation on repeat.
-- ---------------------------------------------------------------------------
alter table public.bv_requests add column if not exists previous_request_id uuid references public.bv_requests(id);
alter table public.bv_requests add column if not exists attempt_no integer not null default 1;
alter table public.bv_requests add column if not exists escalation_required boolean not null default false;
alter table public.bv_requests add column if not exists rejected_at timestamptz;
alter table public.bv_requests add column if not exists rejected_by uuid references public.bv_profiles(id);
alter table public.bv_requests add column if not exists rejection_reason text;
alter table public.bv_requests add column if not exists leave_from date;
alter table public.bv_requests add column if not exists leave_to date;

alter table public.bv_requests drop constraint if exists bv_requests_kind_check;
alter table public.bv_requests
  add constraint bv_requests_kind_check
  check (kind in ('equipment','fault','complaint','leave','other')) not valid;
alter table public.bv_requests validate constraint bv_requests_kind_check;

alter table public.bv_requests drop constraint if exists bv_requests_status_check;
alter table public.bv_requests
  add constraint bv_requests_status_check
  check (status in ('open','progress','done','rejected')) not valid;
alter table public.bv_requests validate constraint bv_requests_status_check;

create index if not exists bv_requests_previous on public.bv_requests(previous_request_id);
create index if not exists bv_requests_escalated on public.bv_requests(escalation_required,status,created_at desc)
  where deleted_at is null;
create index if not exists bv_requests_leave_dates on public.bv_requests(created_by,leave_from,leave_to)
  where kind='leave' and deleted_at is null;

-- Management can see every request. Members see their own requests.
drop policy if exists bv_request_read on public.bv_requests;
create policy bv_request_read on public.bv_requests for select to authenticated
using (
  (select bv_private.member_role()) in ('ceo','team_leader')
  or ((select bv_private.member_role()) is not null and created_by=(select auth.uid()))
);

-- Management can see all task/history rows. Designers keep their own historical task visibility.
create or replace function bv_private.can_read_task(t uuid)
returns boolean language sql stable security definer set search_path=''
as $$
 select auth.uid() is not null and (
   (select bv_private.member_role()) in ('ceo','team_leader','coordinator')
   or exists(select 1 from public.bv_assignments a where a.task_id=t and a.user_id=(select auth.uid()))
 )
$$;
revoke all on function bv_private.can_read_task(uuid) from public, anon;
grant execute on function bv_private.can_read_task(uuid) to authenticated;

-- Full management audit log; members still see activity attached to tasks they can read.
drop policy if exists bv_activity_read on public.bv_activity;
create policy bv_activity_read on public.bv_activity for select to authenticated
using (
  (select bv_private.member_role()) in ('ceo','team_leader')
  or (task_id is not null and bv_private.can_read_task(task_id))
);

-- ---------------------------------------------------------------------------
-- Single mutation gateway.
-- ---------------------------------------------------------------------------
create or replace function bv_private.action(p_action text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
 u uuid:=auth.uid();
 r text;
 t public.bv_tasks;
 a public.bv_assignments;
 q public.bv_requests;
 previous_q public.bv_requests;
 x uuid;
 ids uuid[];
 n timestamptz:=clock_timestamp();
 out_id uuid;
 text_value text;
 request_due timestamptz;
 requested_status text;
 drive_value text;
 score integer;
 score_reason text;
 seconds_early numeric;
 amount integer;
 target_user uuid;
 request_kind text;
 request_title text;
 request_body text;
 leave_start date;
 leave_end date;
begin
 select role into r from public.bv_profiles where id=u and active and not must_change;
 if u is null or r is null then raise exception 'سجّل دخولك وغيّر كلمة المرور المؤقتة أولًا.'; end if;

 if p_action='create_task' then
  if r not in ('ceo','team_leader','coordinator') then raise exception 'إضافة التاسكات للإدارة والـProject Manager فقط.'; end if;
  if coalesce(trim(p->>'title'),'')='' or coalesce(trim(p->>'brief'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false)
   then raise exception 'اسم التاسك والبريف وموعد التسليم القادم مطلوبون.'; end if;
  drive_value:=trim(coalesce(p->>'drive_url',''));
  if drive_value='' and r in ('ceo','team_leader') then
   drive_value:='https://drive.google.com/drive/folders/TEST';
  end if;
  if not coalesce(drive_value ~ '^https://(drive|docs)\.google\.com/',false) then
   if r='coordinator' then raise exception 'الـProject Manager لازم يحط لينك Google Drive للبريف.'; end if;
   raise exception 'لينك Google Drive غير صحيح.';
  end if;
  insert into public.bv_tasks(title,brief,drive_url,due_at,created_by)
  values(left(trim(p->>'title'),180),left(p->>'brief',20000),drive_value,(p->>'due_at')::timestamptz,u)
  returning id into out_id;
  insert into public.bv_activity(task_id,actor,action,detail)
  values(out_id,u,'إنشاء التاسك',left(trim(p->>'title'),10000));

 elsif p_action='create_request' then
  request_kind:=coalesce(p->>'kind','');
  request_title:=left(trim(coalesce(p->>'title','')),180);
  request_body:=left(trim(coalesce(p->>'body','')),10000);
  if request_title='' or request_body='' then raise exception 'اكتب عنوان الطلب وتفاصيله.'; end if;
  if request_kind not in ('equipment','fault','complaint','leave','other') then raise exception 'نوع الطلب غير صحيح.'; end if;
  if request_kind='leave' then
   leave_start:=nullif(p->>'leave_from','')::date;
   leave_end:=nullif(p->>'leave_to','')::date;
   if leave_start is null or leave_end is null or leave_end<leave_start then raise exception 'حدد بداية ونهاية الإجازة بشكل صحيح.'; end if;
  end if;

  select * into previous_q
  from public.bv_requests old
  where old.created_by=u and old.kind=request_kind and old.status='rejected'
    and (
      (request_kind='leave' and old.leave_from=leave_start and old.leave_to=leave_end)
      or (request_kind<>'leave' and lower(regexp_replace(trim(old.title),'\s+',' ','g'))=lower(regexp_replace(request_title,'\s+',' ','g')))
    )
  order by old.created_at desc limit 1;

  insert into public.bv_requests(
    created_by,kind,title,body,leave_from,leave_to,previous_request_id,attempt_no,escalation_required
  ) values(
    u,request_kind,request_title,request_body,leave_start,leave_end,
    case when previous_q.id is null then null else previous_q.id end,
    case when previous_q.id is null then 1 else greatest(previous_q.attempt_no,1)+1 end,
    previous_q.id is not null
  ) returning id into out_id;
  insert into public.bv_activity(request_id,actor,action,detail)
  values(out_id,u,
    case when previous_q.id is null then 'إرسال طلب/شكوى' else 'إعادة تقديم طلب مرفوض سابقًا — تصعيد للإدارة' end,
    request_title);

 elsif p_action='resubmit_request' then
  select * into q from public.bv_requests where id=(p->>'id')::uuid and created_by=u and deleted_at is null for update;
  if not found or q.status<>'rejected' then raise exception 'إعادة التقديم متاحة للطلب المرفوض فقط.'; end if;
  insert into public.bv_requests(
    created_by,kind,title,body,leave_from,leave_to,previous_request_id,attempt_no,escalation_required
  ) values(
    u,q.kind,q.title,q.body,q.leave_from,q.leave_to,q.id,greatest(q.attempt_no,1)+1,true
  ) returning id into out_id;
  insert into public.bv_activity(request_id,actor,action,detail)
  values(out_id,u,'إعادة تقديم طلب مرفوض سابقًا — تصعيد للإدارة',left(q.title,10000));

 elsif p_action='update_request' then
  if r not in ('ceo','team_leader') then raise exception 'إدارة الطلبات للإدارة فقط.'; end if;
  select * into q from public.bv_requests where id=(p->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'الطلب غير موجود أو تم حذفه.'; end if;
  requested_status:=coalesce(p->>'status','open');
  if q.escalation_required and r='team_leader' and requested_status='rejected' then raise exception 'الطلب ده مرفوض سابقًا ومُصعّد للإدارة. الـTeam Leader يقدر يقبله أو يتابعه، لكن لا يقدر يرفضه مرة ثانية.'; end if;
  if requested_status not in ('open','progress','done','rejected') then raise exception 'حالة الطلب غير صحيحة.'; end if;
  request_due:=nullif(p->>'execution_due_at','')::timestamptz;
  if requested_status='progress' and request_due is null then raise exception 'حدد وقت التنفيذ عند الموافقة على الطلب.'; end if;
  if requested_status='progress' and request_due<=n then raise exception 'وقت التنفيذ لازم يكون في المستقبل.'; end if;
  if requested_status='rejected' and coalesce(trim(p->>'response'),'')='' then raise exception 'سبب الرفض مطلوب.'; end if;

  update public.bv_requests set
    status=requested_status,
    response=left(coalesce(p->>'response',''),10000),
    execution_due_at=case when requested_status='open' then null when requested_status='progress' then request_due else execution_due_at end,
    approved_at=case when requested_status in ('progress','done') then coalesce(approved_at,n) else null end,
    approved_by=case when requested_status in ('progress','done') then coalesce(approved_by,u) else null end,
    rejected_at=case when requested_status='rejected' then n else null end,
    rejected_by=case when requested_status='rejected' then u else null end,
    rejection_reason=case when requested_status='rejected' then left(trim(p->>'response'),10000) else null end,
    updated_at=n
  where id=q.id returning id into out_id;
  insert into public.bv_activity(request_id,actor,action,detail)
  values(q.id,u,
    case requested_status
      when 'open' then 'إعادة الطلب للمراجعة'
      when 'progress' then 'الموافقة على الطلب وتحديد التنفيذ'
      when 'rejected' then 'رفض الطلب'
      else 'إتمام الطلب/الشكوى'
    end,
    left(coalesce(nullif(trim(p->>'response'),''),q.title),10000));

 elsif p_action='delete_request' then
  if r not in ('ceo','team_leader') then raise exception 'حذف الطلبات والشكاوى للإدارة فقط.'; end if;
  select * into q from public.bv_requests where id=(p->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'الطلب غير موجود أو تم حذفه.'; end if;
  if q.escalation_required and r<>'ceo' then raise exception 'الطلب المُصعّد لا يقدر الـTeam Leader يحذفه.'; end if;
  update public.bv_requests set deleted_at=n,deleted_by=u,updated_at=n where id=q.id returning id into out_id;
  insert into public.bv_activity(request_id,actor,action,detail) values(q.id,u,'حذف طلب/شكوى',left(q.title,10000));

 elsif p_action='adjust_points' then
  if r not in ('ceo','team_leader') then raise exception 'تعديل النقاط للإدارة فقط.'; end if;
  target_user:=(p->>'user_id')::uuid;
  amount:=(p->>'points')::integer;
  if amount=0 or abs(amount)>10000 then raise exception 'قيمة النقاط لازم تكون بين -10000 و10000 ولا تساوي صفر.'; end if;
  if not exists(select 1 from public.bv_profiles where id=target_user and active) then raise exception 'الحساب غير موجود أو غير مفعّل.'; end if;
  if coalesce(trim(p->>'reason'),'')='' then raise exception 'سبب إضافة أو خصم النقاط مطلوب.'; end if;
  insert into public.bv_point_ledger(user_id,points,kind,reason,created_by)
  values(target_user,amount,'manual_adjustment',left(trim(p->>'reason'),1000),u)
  returning id into out_id;
  insert into public.bv_activity(actor,action,detail)
  values(u,case when amount>0 then 'إضافة نقاط يدوية' else 'خصم نقاط يدوي' end,
    left((select name from public.bv_profiles where id=target_user)||' · '||amount::text||' · '||trim(p->>'reason'),10000));

 else
  select * into t from public.bv_tasks where id=(p->>'task_id')::uuid and deleted_at is null for update;
  if not found or not bv_private.can_read_task(t.id) then raise exception 'التاسك غير متاح.'; end if;
  if coalesce((p->>'version')::integer,-1)<>t.version then raise exception 'التاسك اتحدث من مستخدم آخر. حدّث الصفحة وحاول تاني.'; end if;
  if t.approved_at is not null and p_action not in ('revision','edit_task','delete_task') then raise exception 'التاسك معتمد بالفعل.'; end if;
  out_id:=t.id;

  if p_action='delete_task' then
   if r not in ('ceo','team_leader') then raise exception 'نقل التاسك لتم التسليم متاح للإدارة فقط.'; end if;
   update public.bv_assignments set
     elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
     running_since=null,
     status=case when status='working' then 'paused' else status end
   where task_id=t.id;
   update public.bv_tasks set deleted_at=n,deleted_by=u,updated_at=n where id=t.id;

  elsif p_action='assign' then
   if r not in ('ceo','team_leader') then raise exception 'توزيع التاسكات للإدارة فقط.'; end if;
   select array_agg(distinct value::uuid) into ids from jsonb_array_elements_text(p->'user_ids');
   if coalesce(cardinality(ids),0)=0 or exists(
     select 1 from unnest(ids) v where not exists(select 1 from public.bv_profiles where id=v and active)
   ) then raise exception 'اختر عضوًا مفعّلًا واحدًا على الأقل.'; end if;
   update public.bv_assignments set
     elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
     running_since=null,status=case when status='working' then 'paused' else status end,active=false
   where task_id=t.id and round=t.round and active and not(user_id=any(ids));
   foreach x in array ids loop
    insert into public.bv_assignments(task_id,user_id,round,deadline_at)
    values(t.id,x,t.round,t.due_at)
    on conflict(task_id,user_id,round) do update set active=true,deadline_at=excluded.deadline_at;
   end loop;

  elsif p_action in ('start','pause','resume','submit','delay') then
   select * into a from public.bv_assignments
   where id=(p->>'assignment_id')::uuid and task_id=t.id and round=t.round and active for update;
   if not found then raise exception 'التاسك غير مسند لهذا العضو.'; end if;
   if a.user_id<>u then raise exception 'البدء والإيقاف والاستكمال والتسليم متاحين لصاحب التكليف فقط.'; end if;

   if p_action='start' then
    if a.status<>'assigned' then raise exception 'التاسك بدأ بالفعل.'; end if;
    update public.bv_assignments set status='working',running_since=n,started_at=coalesce(started_at,n),deadline_at=coalesce(deadline_at,t.due_at) where id=a.id;
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
    if n>coalesce(a.deadline_at,t.due_at) and coalesce(trim(p->>'delay_reason'),trim(a.delay_reason),'')='' then raise exception 'سبب التأخير إجباري.'; end if;

    seconds_early:=extract(epoch from(coalesce(a.deadline_at,t.due_at)-n);
    if seconds_early>=172800 then score:=100; score_reason:='تسليم قبل الموعد بـ48 ساعة أو أكثر';
    elsif seconds_early>=86400 then score:=80; score_reason:='تسليم قبل الموعد بـ24–48 ساعة';
    elsif seconds_early>=43200 then score:=60; score_reason:='تسليم قبل الموعد بـ12–24 ساعة';
    elsif seconds_early>=21600 then score:=40; score_reason:='تسليم قبل الموعد بـ6–12 ساعة';
    elsif seconds_early>=3600 then score:=25; score_reason:='تسليم قبل الموعد بـ1–6 ساعات';
    elsif seconds_early>=0 then score:=10; score_reason:='تسليم في آخر ساعة / في الموعد';
    else score:=0; score_reason:='تسليم متأخر'; end if;

    update public.bv_assignments set status='submitted',
      elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
      running_since=null,submitted_at=n,submission_url=p->>'submission_url',
      delay_reason=coalesce(nullif(trim(p->>'delay_reason'),''),delay_reason),
      deadline_at=coalesce(deadline_at,t.due_at),points_awarded=score,points_reason=score_reason,points_calculated_at=n
    where id=a.id;

    if score<>0 then
      insert into public.bv_point_ledger(user_id,points,kind,task_id,assignment_id,reason,created_by,created_at)
      values(a.user_id,score,'submission',t.id,a.id,score_reason,u,n)
      on conflict (assignment_id) where kind='submission' and assignment_id is not null
      do update set points=excluded.points,reason=excluded.reason,created_at=excluded.created_at;
    end if;
   end if;

  elsif p_action='approve' then
   if r not in ('ceo','team_leader') then raise exception 'اعتماد التسليم للإدارة فقط.'; end if;
   if not exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active)
      or exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active and status<>'submitted')
   then raise exception 'لازم كل الأعضاء يسلموا التاسك أولًا.'; end if;
   update public.bv_tasks set approved_at=n where id=t.id;

  elsif p_action='revision' then
   if r not in ('ceo','team_leader') then raise exception 'طلب التعديلات للإدارة فقط.'; end if;
   if coalesce(trim(p->>'note'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'وصف التعديل وموعد تسليمه مطلوبان.'; end if;
   if not exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active) then raise exception 'وزع التاسك أولًا.'; end if;
   update public.bv_assignments set
     elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
     running_since=null,status=case when status='working' then 'paused' else status end
   where task_id=t.id and round=t.round;
   insert into public.bv_assignments(task_id,user_id,round,deadline_at)
   select t.id,user_id,t.round+1,(p->>'due_at')::timestamptz
   from public.bv_assignments where task_id=t.id and round=t.round and active;
   update public.bv_tasks set round=round+1,due_at=(p->>'due_at')::timestamptz,approved_at=null where id=t.id;

  elsif p_action='edit_task' then
   if r not in ('ceo','team_leader') then raise exception 'تعديل التاسك للإدارة فقط.'; end if;
   if coalesce(trim(p->>'brief'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'البريف وموعد التسليم مطلوبان.'; end if;
   drive_value:=trim(coalesce(p->>'drive_url',''));
   if drive_value='' and r in ('ceo','team_leader') then drive_value:='https://drive.google.com/drive/folders/TEST'; end if;
   if not coalesce(drive_value ~ '^https://(drive|docs)\.google\.com/',false) then raise exception 'لينك Google Drive غير صحيح.'; end if;
   update public.bv_tasks set title=left(trim(p->>'title'),180),brief=left(p->>'brief',20000),drive_url=drive_value,due_at=(p->>'due_at')::timestamptz where id=t.id;
   update public.bv_assignments set deadline_at=(p->>'due_at')::timestamptz
   where task_id=t.id and round=t.round and active and status<>'submitted';
  else
   raise exception 'إجراء غير معروف.';
  end if;

  update public.bv_tasks set version=version+1,updated_at=n where id=t.id;
  text_value:=case p_action
    when 'assign' then 'توزيع التاسك'
    when 'start' then 'استلام وبدء التاسك'
    when 'pause' then 'إيقاف التايمر'
    when 'resume' then 'استكمال التايمر'
    when 'submit' then 'تسليم الشغل واحتساب النقاط'
    when 'delay' then 'توضيح التأخير'
    when 'approve' then 'اعتماد التسليم'
    when 'revision' then 'طلب تعديل'
    when 'delete_task' then 'نقل التاسك إلى تم التسليم'
    else 'تعديل التاسك' end;
  insert into public.bv_activity(task_id,assignment_id,actor,action,detail)
  values(t.id,case when p_action in ('start','pause','resume','submit','delay') then a.id else null end,u,text_value,left(coalesce(p->>'note',p->>'delay_reason',''),10000));
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

-- State separates active tasks from the new Delivered/Archive page and exposes the durable ledger.
create or replace function public.bv_state()
returns jsonb language sql stable security invoker set search_path=''
as $$
 select jsonb_build_object(
   'server_time',clock_timestamp(),
   'profiles',coalesce((select jsonb_agg(x order by x.name) from public.bv_profiles x),'[]'::jsonb),
   'tasks',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_tasks x where x.deleted_at is null),'[]'::jsonb),
   'archived_tasks',coalesce((select jsonb_agg(x order by x.deleted_at desc) from public.bv_tasks x where x.deleted_at is not null),'[]'::jsonb),
   'assignments',coalesce((select jsonb_agg(x) from public.bv_assignments x),'[]'::jsonb),
   'point_ledger',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_point_ledger x),'[]'::jsonb),
   'requests',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_requests x where x.deleted_at is null),'[]'::jsonb),
   'activity',coalesce((select jsonb_agg(x order by x.created_at desc) from (select * from public.bv_activity order by created_at desc limit 1000) x),'[]'::jsonb)
 )
$$;
revoke all on function public.bv_state() from public,anon;
grant execute on function public.bv_state() to authenticated;

-- Explicit Data API grants for the new table (required on projects using opt-in exposure).
grant select on public.bv_point_ledger to authenticated;

do $$ begin
 alter publication supabase_realtime add table public.bv_point_ledger;
exception when duplicate_object then null; end $$;
alter table public.bv_point_ledger replica identity full;
