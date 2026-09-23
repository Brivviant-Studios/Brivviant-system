-- Brivviant V7: self-controlled timers, management activity log, request/complaint table workflow.
-- Additive migration. Existing tasks, assignments, requests, chat, accounts and history are preserved.

alter table public.bv_requests add column if not exists execution_due_at timestamptz;
alter table public.bv_requests add column if not exists approved_at timestamptz;
alter table public.bv_requests add column if not exists approved_by uuid references public.bv_profiles(id);
alter table public.bv_requests add column if not exists deleted_at timestamptz;
alter table public.bv_requests add column if not exists deleted_by uuid references public.bv_profiles(id);

alter table public.bv_activity add column if not exists request_id uuid references public.bv_requests(id);
alter table public.bv_activity add column if not exists assignment_id uuid references public.bv_assignments(id);
create index if not exists bv_activity_request on public.bv_activity(request_id,created_at desc);
create index if not exists bv_activity_assignment on public.bv_activity(assignment_id,created_at desc);
create index if not exists bv_request_deleted on public.bv_requests(deleted_at);
create index if not exists bv_request_due on public.bv_requests(execution_due_at) where deleted_at is null;
create index if not exists bv_request_approved_by on public.bv_requests(approved_by);
create index if not exists bv_request_deleted_by on public.bv_requests(deleted_by);

-- CEO can read the full audit log. Other members only see activity for tasks they are allowed to read.
drop policy if exists bv_activity_read on public.bv_activity;
create policy bv_activity_read on public.bv_activity for select to authenticated
using ((select bv_private.member_role())='ceo' or bv_private.can_read_task(task_id));

create or replace function bv_private.action(p_action text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
 u uuid:=auth.uid(); r text; t public.bv_tasks; a public.bv_assignments; q public.bv_requests;
 x uuid; ids uuid[]; n timestamptz:=clock_timestamp(); out_id uuid; text_value text;
 request_due timestamptz; requested_status text;
begin
 select role into r from public.bv_profiles where id=u and active and not must_change;
 if u is null or r is null then raise exception 'سجّل دخولك وغيّر كلمة المرور المؤقتة أولًا.'; end if;

 if p_action='create_task' then
  if r not in ('ceo','coordinator') then raise exception 'إضافة التاسكات للإدارة وإيمي فقط.'; end if;
  if coalesce(trim(p->>'brief'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'البريف وموعد التسليم القادم مطلوبان.'; end if;
  insert into public.bv_tasks(title,brief,drive_url,due_at,created_by)
  values(trim(p->>'title'),p->>'brief',p->>'drive_url',(p->>'due_at')::timestamptz,u) returning id into out_id;
  insert into public.bv_activity(task_id,actor,action,detail) values(out_id,u,'إنشاء التاسك',left(trim(p->>'title'),10000));

 elsif p_action='create_request' then
  if coalesce(trim(p->>'title'),'')='' or coalesce(trim(p->>'body'),'')='' then raise exception 'اكتب عنوان الطلب وتفاصيله.'; end if;
  if coalesce(p->>'kind','') not in ('equipment','fault','complaint','other') then raise exception 'نوع الطلب غير صحيح.'; end if;
  insert into public.bv_requests(created_by,kind,title,body)
  values(u,p->>'kind',left(trim(p->>'title'),180),left(trim(p->>'body'),10000)) returning id into out_id;
  insert into public.bv_activity(request_id,actor,action,detail)
  values(out_id,u,'إرسال طلب/شكوى',left(trim(p->>'title'),10000));

 elsif p_action='update_request' then
  if r<>'ceo' then raise exception 'إدارة الطلبات للـCEO فقط.'; end if;
  select * into q from public.bv_requests where id=(p->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'الطلب غير موجود أو تم حذفه.'; end if;
  requested_status:=coalesce(p->>'status','open');
  if requested_status not in ('open','progress','done') then raise exception 'حالة الطلب غير صحيحة.'; end if;
  request_due:=nullif(p->>'execution_due_at','')::timestamptz;
  if requested_status='progress' and request_due is null then raise exception 'حدد وقت التنفيذ عند الموافقة على الطلب.'; end if;
  if requested_status='progress' and request_due<=n then raise exception 'وقت التنفيذ لازم يكون في المستقبل.'; end if;
  update public.bv_requests set
    status=requested_status,
    response=left(coalesce(p->>'response',''),10000),
    execution_due_at=case when requested_status='open' then null else coalesce(request_due,execution_due_at) end,
    approved_at=case when requested_status='open' then null else coalesce(approved_at,n) end,
    approved_by=case when requested_status='open' then null else coalesce(approved_by,u) end,
    updated_at=n
  where id=q.id returning id into out_id;
  insert into public.bv_activity(request_id,actor,action,detail)
  values(q.id,u,case requested_status when 'open' then 'إعادة الطلب للمراجعة' when 'progress' then 'الموافقة على الطلب وتحديد التنفيذ' else 'إتمام الطلب/الشكوى' end,
         left(coalesce(nullif(trim(p->>'response'),''),q.title),10000));

 elsif p_action='delete_request' then
  if r<>'ceo' then raise exception 'حذف الطلبات والشكاوى للـCEO فقط.'; end if;
  select * into q from public.bv_requests where id=(p->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'الطلب غير موجود أو تم حذفه.'; end if;
  update public.bv_requests set deleted_at=n,deleted_by=u,updated_at=n where id=q.id returning id into out_id;
  insert into public.bv_activity(request_id,actor,action,detail) values(q.id,u,'حذف طلب/شكوى',left(q.title,10000));

 else
  select * into t from public.bv_tasks where id=(p->>'task_id')::uuid and deleted_at is null for update;
  if not found or not bv_private.can_read_task(t.id) then raise exception 'التاسك غير متاح.'; end if;
  if coalesce((p->>'version')::integer,-1)<>t.version then raise exception 'التاسك اتحدث من مستخدم آخر. حدّث الصفحة وحاول تاني.'; end if;
  if t.approved_at is not null and p_action not in ('revision','edit_task','delete_task') then raise exception 'التاسك معتمد بالفعل.'; end if;
  out_id:=t.id;

  if p_action='delete_task' then
   if r<>'ceo' then raise exception 'حذف التاسكات للـCEO فقط.'; end if;
   update public.bv_assignments set elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
    running_since=null,status=case when status='working' then 'paused' else status end where task_id=t.id;
   update public.bv_tasks set deleted_at=n,deleted_by=u,updated_at=n where id=t.id;

  elsif p_action='assign' then
   if r<>'ceo' then raise exception 'توزيع التاسكات للـCEO فقط.'; end if;
   select array_agg(distinct value::uuid) into ids from jsonb_array_elements_text(p->'user_ids');
   if coalesce(cardinality(ids),0)=0 or exists(select 1 from unnest(ids) v where not exists(select 1 from public.bv_profiles where id=v and active)) then
    raise exception 'اختر عضوًا مفعّلًا واحدًا على الأقل.';
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
   if not found then raise exception 'التاسك غير مسند لهذا العضو.'; end if;
   if a.user_id<>u then raise exception 'البدء والإيقاف والاستكمال والتسليم متاحين لصاحب التكليف فقط.'; end if;

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
    if not coalesce((p->>'submission_url') ~ '^https://(drive|docs)\\.google\\.com/',false) then raise exception 'لينك Drive للتسليم مطلوب.'; end if;
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
   then raise exception 'لازم كل الأعضاء يسلموا التاسك أولًا.'; end if;
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
  text_value:=case p_action when 'assign' then 'توزيع التاسك' when 'start' then 'استلام وبدء التاسك'
    when 'pause' then 'إيقاف التايمر' when 'resume' then 'استكمال التايمر' when 'submit' then 'تسليم الشغل'
    when 'delay' then 'توضيح التأخير' when 'approve' then 'اعتماد التسليم' when 'revision' then 'طلب تعديل'
    when 'delete_task' then 'حذف التاسك' else 'تعديل التاسك' end;
  insert into public.bv_activity(task_id,assignment_id,actor,action,detail)
  values(t.id,case when p_action in ('start','pause','resume','submit','delay') then a.id else null end,u,text_value,left(coalesce(p->>'note',p->>'delay_reason',''),10000));
 end if;

 update public.bv_profiles set touched_at=n where id=u;
 return jsonb_build_object('id',out_id,'ok',true,'server_time',n);
end $$;

revoke all on function bv_private.action(text,jsonb) from public,anon,authenticated;

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
 'tasks',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_tasks x where x.deleted_at is null),'[]'::jsonb),
 'assignments',coalesce((select jsonb_agg(x) from public.bv_assignments x),'[]'::jsonb),
 'requests',coalesce((select jsonb_agg(x order by x.created_at desc) from public.bv_requests x where x.deleted_at is null),'[]'::jsonb),
 'activity',coalesce((select jsonb_agg(x order by x.created_at desc) from (select * from public.bv_activity order by created_at desc limit 500) x),'[]'::jsonb)
 )
$$;
revoke all on function public.bv_state() from public,anon;
grant execute on function public.bv_state() to authenticated;

-- Request activity is already notified by the bv_requests trigger. Do not broadcast audit-only request log rows as task notifications.
create or replace function bv_private.notify_event() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='bv_messages' then
  insert into public.bv_notifications(user_id,kind,title,peer_id,message_id)
  values(new.recipient_id,'message','رسالة خاصة جديدة',new.sender_id,new.id);
 elsif tg_table_name='bv_activity' then
  if new.task_id is null then return new; end if;
  insert into public.bv_notifications(user_id,kind,title,task_id)
  select p.id,'task',new.action,
   case when p.role in ('ceo','coordinator') or exists(select 1 from public.bv_assignments a where a.task_id=new.task_id and a.user_id=p.id and a.active) then new.task_id else null end
  from public.bv_profiles p where p.active;
 elsif tg_table_name='bv_requests' then
  insert into public.bv_notifications(user_id,kind,title,request_id)
  select p.id,'request',
   case when tg_op='INSERT' then 'طلب أو شكوى جديدة'
        when new.deleted_at is not null and old.deleted_at is null then 'تم حذف طلب أو شكوى'
        when new.status='progress' and old.status is distinct from new.status then 'تمت الموافقة على طلب أو شكوى'
        when new.status='done' and old.status is distinct from new.status then 'تم تنفيذ طلب أو شكوى'
        else 'تحديث متابعة طلب أو شكوى' end,
   new.id
  from public.bv_profiles p where p.active and (p.role='ceo' or p.id=new.created_by);
 elsif tg_table_name='bv_profiles' then
  if tg_op='UPDATE' then
   if (new.name,new.role,new.active,new.must_change) is not distinct from (old.name,old.role,old.active,old.must_change) then return new; end if;
  end if;
  insert into public.bv_notifications(user_id,kind,title)
  select p.id,'account','تحديث في بيانات الفريق' from public.bv_profiles p where p.active;
 end if;
 return new;
end $$;
revoke all on function bv_private.notify_event() from public,anon,authenticated;
