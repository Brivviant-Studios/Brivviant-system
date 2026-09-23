alter table public.bv_profiles add column touched_at timestamptz not null default now();
drop policy bv_profile_read on public.bv_profiles;
create policy bv_profile_read on public.bv_profiles for select to authenticated using (id=(select auth.uid()) or (select bv_private.member_role()) is not null);
create or replace function bv_private.action(p_action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 u uuid:=auth.uid(); r text; t public.bv_tasks; a public.bv_assignments; x uuid; ids uuid[]; n timestamptz:=clock_timestamp(); out_id uuid; text_value text;
begin
 select role into r from public.bv_profiles where id=u and active and not must_change;
 if u is null or r is null then raise exception 'سجّل دخولك وغيّر كلمة المرور المؤقتة أولًا.'; end if;
 if p_action='create_task' then
  if r not in ('ceo','coordinator') then raise exception 'إضافة التاسكات للإدارة وإيمي فقط.'; end if;
  if coalesce(trim(p->>'brief'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'البريف وموعد التسليم القادم مطلوبان.'; end if;
  insert into public.bv_tasks(title,brief,drive_url,due_at,created_by) values(trim(p->>'title'),p->>'brief',p->>'drive_url',(p->>'due_at')::timestamptz,u) returning id into out_id;
  insert into public.bv_activity(task_id,actor,action) values(out_id,u,'إنشاء التاسك');
 elsif p_action='create_request' then
  if coalesce(trim(p->>'title'),'')='' or coalesce(trim(p->>'body'),'')='' then raise exception 'اكتب عنوان الطلب وتفاصيله.'; end if;
  insert into public.bv_requests(created_by,kind,title,body) values(u,p->>'kind',left(p->>'title',180),left(p->>'body',10000)) returning id into out_id;
 elsif p_action='update_request' then
  if r<>'ceo' then raise exception 'إدارة الطلبات للـCEO فقط.'; end if;
  update public.bv_requests set status=p->>'status',response=left(coalesce(p->>'response',''),10000),updated_at=n where id=(p->>'id')::uuid returning id into out_id;
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
   if coalesce(cardinality(ids),0)=0 or exists(select 1 from unnest(ids) v where not exists(select 1 from public.bv_profiles where id=v and active and role='employee')) then raise exception 'اختر موظفًا واحدًا على الأقل.'; end if;
   update public.bv_assignments set elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,running_since=null,status=case when status='working' then 'paused' else status end,active=false where task_id=t.id and round=t.round and active and not(user_id=any(ids));
   foreach x in array ids loop
    insert into public.bv_assignments(task_id,user_id,round) values(t.id,x,t.round) on conflict(task_id,user_id,round) do update set active=true;
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
    update public.bv_assignments set status='paused',elapsed_ms=elapsed_ms+greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint,running_since=null where id=a.id;
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
    update public.bv_assignments set status='submitted',elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,running_since=null,submitted_at=n,submission_url=p->>'submission_url',delay_reason=coalesce(nullif(trim(p->>'delay_reason'),''),delay_reason) where id=a.id;
   end if;
  elsif p_action='approve' then
   if r<>'ceo' then raise exception 'اعتماد التسليم للـCEO فقط.'; end if;
   if not exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active) or exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active and status<>'submitted') then raise exception 'لازم كل الموظفين يسلموا التاسك أولًا.'; end if;
   update public.bv_tasks set approved_at=n where id=t.id;
  elsif p_action='revision' then
   if r<>'ceo' then raise exception 'طلب التعديلات للـCEO فقط.'; end if;
   if coalesce(trim(p->>'note'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'وصف التعديل وموعد تسليمه مطلوبان.'; end if;
   if not exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active) then raise exception 'وزع التاسك أولًا.'; end if;
   update public.bv_assignments set elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,running_since=null,status=case when status='working' then 'paused' else status end where task_id=t.id and round=t.round;
   insert into public.bv_assignments(task_id,user_id,round) select t.id,user_id,t.round+1 from public.bv_assignments where task_id=t.id and round=t.round and active;
   update public.bv_tasks set round=round+1,due_at=(p->>'due_at')::timestamptz,approved_at=null where id=t.id;
  elsif p_action='edit_task' then
   if r<>'ceo' then raise exception 'تعديل التاسك للـCEO فقط.'; end if;
   if coalesce(trim(p->>'brief'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'البريف وموعد التسليم مطلوبان.'; end if;
   update public.bv_tasks set title=trim(p->>'title'),brief=p->>'brief',drive_url=p->>'drive_url',due_at=(p->>'due_at')::timestamptz where id=t.id;
  else raise exception 'إجراء غير معروف.';
  end if;
  update public.bv_tasks set version=version+1,updated_at=n where id=t.id;
  text_value:=case p_action when 'assign' then 'توزيع التاسك' when 'start' then 'بدء الشغل' when 'pause' then 'إيقاف التايمر' when 'resume' then 'استكمال التايمر' when 'submit' then 'تسليم الشغل' when 'delay' then 'توضيح التأخير' when 'approve' then 'اعتماد التسليم' when 'revision' then 'طلب تعديل' else 'تعديل التاسك' end;
  insert into public.bv_activity(task_id,actor,action,detail) values(t.id,u,text_value,left(coalesce(p->>'note',p->>'delay_reason',''),10000));
 end if;
 update public.bv_profiles set touched_at=n where active;
 return jsonb_build_object('id',out_id,'ok',true,'server_time',n);
end $$;
