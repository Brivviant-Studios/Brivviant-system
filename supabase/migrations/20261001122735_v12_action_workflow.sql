create or replace function bv_private.action(p_action text,p jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
 u uuid:=auth.uid(); r text; t public.bv_tasks; a public.bv_assignments; q public.bv_requests; s public.bv_task_stages;
 previous_q public.bv_requests; n timestamptz:=clock_timestamp(); out_id uuid; text_value text; drive_value text;
 request_kind text; request_title text; request_body text; requested_status text; request_due timestamptz;
 leave_start date; leave_end date; ids uuid[]; x uuid; target_user uuid; amount integer; stage_json jsonb; stage_count int:=0;
 owner_id uuid; score integer; score_reason text; responsible uuid; pause_kind text; pause_reason text; approval_note text;
begin
 select role into r from public.bv_profiles where id=u and active and not must_change;
 if u is null or r is null then raise exception 'سجّل دخولك بحساب مفعّل أولًا.'; end if;

 if p_action='create_task' then
  if r not in ('ceo','team_leader','coordinator') then raise exception 'إضافة التاسكات للإدارة والـProject Manager فقط.'; end if;
  if coalesce(trim(p->>'title'),'')='' or coalesce(trim(p->>'brief'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false)
    then raise exception 'اسم التاسك والبريف وموعد التسليم مطلوبون.'; end if;
  drive_value:=trim(coalesce(p->>'drive_url',''));
  if drive_value='' and r in ('ceo','team_leader') then drive_value:='https://drive.google.com/drive/folders/TEST'; end if;
  if not coalesce(drive_value ~ '^https://(drive|docs)\.google\.com/',false) then
    if r='coordinator' then raise exception 'الـProject Manager لازم يحط لينك Google Drive للبريف.'; end if;
    raise exception 'لينك Google Drive غير صحيح.';
  end if;
  insert into public.bv_tasks(title,brief,drive_url,due_at,created_by)
  values(left(trim(p->>'title'),180),left(p->>'brief',20000),drive_value,(p->>'due_at')::timestamptz,u) returning id into out_id;
  insert into public.bv_activity(task_id,actor,action,detail) values(out_id,u,'إنشاء التاسك',left(trim(p->>'title'),10000));

 elsif p_action='create_request' then
  request_kind:=coalesce(p->>'kind',''); request_title:=left(trim(coalesce(p->>'title','')),180); request_body:=left(trim(coalesce(p->>'body','')),10000);
  if request_title='' or request_body='' then raise exception 'اكتب عنوان الطلب وتفاصيله.'; end if;
  if request_kind not in ('equipment','fault','complaint','leave','other') then raise exception 'نوع الطلب غير صحيح.'; end if;
  if request_kind='leave' then
    leave_start:=nullif(p->>'leave_from','')::date; leave_end:=nullif(p->>'leave_to','')::date;
    if leave_start is null or leave_end is null or leave_end<leave_start then raise exception 'حدد بداية ونهاية الإجازة بشكل صحيح.'; end if;
  end if;
  select * into previous_q from public.bv_requests old
  where old.created_by=u and old.kind=request_kind and old.status='rejected'
    and ((request_kind='leave' and old.leave_from=leave_start and old.leave_to=leave_end)
      or (request_kind<>'leave' and lower(regexp_replace(trim(old.title),'\s+',' ','g'))=lower(regexp_replace(request_title,'\s+',' ','g'))))
  order by old.created_at desc limit 1;
  insert into public.bv_requests(created_by,kind,title,body,leave_from,leave_to,previous_request_id,attempt_no,escalation_required)
  values(u,request_kind,request_title,request_body,leave_start,leave_end,
    previous_q.id,case when previous_q.id is null then 1 else greatest(previous_q.attempt_no,1)+1 end,previous_q.id is not null)
  returning id into out_id;
  insert into public.bv_activity(request_id,actor,action,detail)
  values(out_id,u,case when previous_q.id is null then 'إرسال طلب' else 'إعادة تقديم طلب مرفوض سابقًا — تصعيد للإدارة' end,request_title);

 elsif p_action='resubmit_request' then
  select * into q from public.bv_requests where id=(p->>'id')::uuid and created_by=u for update;
  if not found or q.status<>'rejected' then raise exception 'إعادة التقديم متاحة للطلب المرفوض فقط.'; end if;
  insert into public.bv_requests(created_by,kind,title,body,leave_from,leave_to,previous_request_id,attempt_no,escalation_required)
  values(u,q.kind,q.title,q.body,q.leave_from,q.leave_to,q.id,greatest(q.attempt_no,1)+1,true) returning id into out_id;
  insert into public.bv_activity(request_id,actor,action,detail) values(out_id,u,'إعادة تقديم طلب مرفوض سابقًا — تصعيد للإدارة',left(q.title,10000));

 elsif p_action='update_request' then
  if r not in ('ceo','team_leader') then raise exception 'إدارة الطلبات للإدارة فقط.'; end if;
  select * into q from public.bv_requests where id=(p->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'الطلب غير موجود.'; end if;
  requested_status:=coalesce(p->>'status','open');
  if requested_status not in ('open','progress','done','rejected') then raise exception 'حالة الطلب غير صحيحة.'; end if;
  if q.escalation_required and r='team_leader' and requested_status='rejected' then raise exception 'الطلب مرفوض سابقًا؛ الـTeam Leader لا يقدر يرفضه مرة ثانية.'; end if;
  request_due:=nullif(p->>'execution_due_at','')::timestamptz;
  if requested_status='progress' and request_due is null then raise exception 'حدد وقت التنفيذ عند القبول.'; end if;
  if requested_status='rejected' and coalesce(trim(p->>'response'),'')='' then raise exception 'سبب الرفض مطلوب ويظهر لصاحب الطلب.'; end if;
  update public.bv_requests set status=requested_status,response=left(coalesce(p->>'response',''),10000),
    execution_due_at=case when requested_status='progress' then request_due else execution_due_at end,
    approved_at=case when requested_status in ('progress','done') then coalesce(approved_at,n) else approved_at end,
    approved_by=case when requested_status in ('progress','done') then u else approved_by end,
    rejected_at=case when requested_status='rejected' then n else rejected_at end,
    rejected_by=case when requested_status='rejected' then u else rejected_by end,
    rejection_reason=case when requested_status='rejected' then left(trim(p->>'response'),10000) else rejection_reason end,
    updated_at=n where id=q.id returning id into out_id;
  insert into public.bv_activity(request_id,actor,action,detail) values(q.id,u,
    case requested_status when 'progress' then 'قبول الطلب' when 'done' then 'إتمام الطلب' when 'rejected' then 'رفض الطلب' else 'إعادة الطلب للمراجعة' end,
    left(coalesce(nullif(trim(p->>'response'),''),q.title),10000));

 elsif p_action='delete_request' then
  if r not in ('ceo','team_leader') then raise exception 'حذف الطلبات للإدارة فقط.'; end if;
  select * into q from public.bv_requests where id=(p->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'الطلب غير موجود.'; end if;
  if q.escalation_required and r<>'ceo' then raise exception 'الطلب المُصعّد لا يقدر الـTeam Leader يحذفه.'; end if;
  update public.bv_requests set deleted_at=n,deleted_by=u,updated_at=n where id=q.id returning id into out_id;

 elsif p_action='adjust_points' then
  if r not in ('ceo','team_leader') then raise exception 'تعديل النقاط للإدارة فقط.'; end if;
  target_user:=(p->>'user_id')::uuid; amount:=(p->>'points')::integer;
  if amount=0 or abs(amount)>10000 then raise exception 'قيمة النقاط غير صحيحة.'; end if;
  if coalesce(trim(p->>'reason'),'')='' then raise exception 'سبب إضافة أو خصم النقاط مطلوب.'; end if;
  insert into public.bv_point_ledger(user_id,points,kind,reason,created_by)
  values(target_user,amount,'manual_adjustment',left(trim(p->>'reason'),1000),u) returning id into out_id;

 else
  select * into t from public.bv_tasks where id=(p->>'task_id')::uuid and deleted_at is null for update;
  if not found or not bv_private.can_read_task(t.id) then raise exception 'التاسك غير متاح.'; end if;
  if coalesce((p->>'version')::integer,-1)<>t.version then raise exception 'التاسك اتحدث من مستخدم آخر. حدّث الصفحة وحاول تاني.'; end if;
  out_id:=t.id;

  if p_action='delete_task' then
    if r not in ('ceo','team_leader') then raise exception 'نقل التاسك إلى تم التسليم للإدارة فقط.'; end if;
    update public.bv_assignments set elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
      running_since=null,status=case when status='working' then 'paused' else status end where task_id=t.id;
    update public.bv_task_stages set elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
      running_since=null,status=case when status='working' then 'paused' else status end,updated_at=n where task_id=t.id;
    update public.bv_tasks set deleted_at=n,deleted_by=u,updated_at=n where id=t.id;

  elsif p_action='assign' then
    if r not in ('ceo','team_leader') then raise exception 'توزيع التاسكات للإدارة فقط.'; end if;
    select array_agg(distinct value::uuid) into ids from jsonb_array_elements_text(p->'user_ids');
    if coalesce(cardinality(ids),0)=0 then raise exception 'اختر عضوًا واحدًا على الأقل.'; end if;
    foreach x in array ids loop
      if not exists(select 1 from public.bv_profiles where id=x and active) then raise exception 'يوجد حساب غير مفعّل ضمن التوزيع.'; end if;
      insert into public.bv_assignments(task_id,user_id,round,deadline_at) values(t.id,x,t.round,t.due_at)
      on conflict(task_id,user_id,round) do update set active=true,deadline_at=excluded.deadline_at;
    end loop;
    update public.bv_assignments set active=false where task_id=t.id and round=t.round and active and not(user_id=any(ids));

  elsif p_action='save_workflow' then
    if r not in ('ceo','team_leader') then raise exception 'إعداد مراحل المشروع للإدارة فقط.'; end if;
    if exists(select 1 from public.bv_task_stages where task_id=t.id and status<>'pending') then raise exception 'لا يمكن استبدال الخطة بعد بدء مرحلة.'; end if;
    owner_id:=(p->>'owner_user_id')::uuid;
    if not exists(select 1 from public.bv_profiles where id=owner_id and active) then raise exception 'حدد Task Owner مفعّل.'; end if;
    if jsonb_typeof(p->'stages')<>'array' or jsonb_array_length(p->'stages')<4 then raise exception 'أضف مراحل المشروع المطلوبة.'; end if;
    delete from public.bv_task_stages where task_id=t.id;
    stage_count:=0;
    for stage_json in select value from jsonb_array_elements(p->'stages') loop
      stage_count:=stage_count+1;
      if coalesce((stage_json->>'planned_hours')::numeric,0)<=0 then raise exception 'عدد الساعات لكل مرحلة لازم يكون أكبر من صفر.'; end if;
      target_user:=(stage_json->>'user_id')::uuid;
      if not exists(select 1 from public.bv_profiles where id=target_user and active) then raise exception 'كل مرحلة لازم يكون لها مسؤول مفعّل.'; end if;
      insert into public.bv_task_stages(task_id,stage_key,title_ar,title_en,sort_order,planned_hours,assigned_user_id)
      values(t.id,coalesce(nullif(stage_json->>'stage_key',''),'custom'),left(coalesce(stage_json->>'title_ar','مرحلة'),120),left(coalesce(stage_json->>'title_en','Stage'),120),
        stage_count,(stage_json->>'planned_hours')::numeric,target_user);
      insert into public.bv_assignments(task_id,user_id,round,deadline_at) values(t.id,target_user,t.round,t.due_at)
      on conflict(task_id,user_id,round) do update set active=true,deadline_at=excluded.deadline_at;
    end loop;
    update public.bv_tasks set owner_user_id=owner_id,workflow_required=true,updated_at=n where id=t.id;
    insert into public.bv_activity(task_id,actor,action,detail) values(t.id,u,'إعداد Workflow المشروع','Task Owner: '||(select name from public.bv_profiles where id=owner_id)||' · '||stage_count||' مراحل');

  elsif p_action in ('stage_start','stage_pause','stage_resume','stage_submit','stage_approve') then
    select * into s from public.bv_task_stages where id=(p->>'stage_id')::uuid and task_id=t.id for update;
    if not found then raise exception 'المرحلة غير موجودة.'; end if;
    if p_action='stage_start' then
      if s.assigned_user_id<>u then raise exception 'بدء المرحلة لمسؤول المرحلة فقط.'; end if;
      if s.status<>'pending' then raise exception 'المرحلة بدأت بالفعل.'; end if;
      if exists(select 1 from public.bv_task_stages prev where prev.task_id=t.id and prev.sort_order<s.sort_order and prev.status<>'approved') then raise exception 'اعتمد المراحل السابقة أولًا.'; end if;
      update public.bv_task_stages set status='working',running_since=n,started_at=coalesce(started_at,n),updated_at=n where id=s.id;
    elsif p_action='stage_pause' then
      if s.assigned_user_id<>u then raise exception 'إيقاف المرحلة لمسؤول المرحلة فقط.'; end if;
      if s.status<>'working' then raise exception 'تايمر المرحلة غير شغال.'; end if;
      pause_kind:=coalesce(p->>'pause_kind','external'); pause_reason:=left(trim(coalesce(p->>'pause_reason','')),1000);
      if pause_reason='' then raise exception 'سبب إيقاف الوقت مطلوب.'; end if;
      update public.bv_task_stages set status='paused',elapsed_ms=elapsed_ms+greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint,running_since=null,note=pause_reason,updated_at=n where id=s.id;
      if pause_kind='negligence' then
        insert into public.bv_task_quality_flags(task_id,stage_id,user_id,kind,note,created_by) values(t.id,s.id,u,'negligent_pause',pause_reason,u);
      end if;
    elsif p_action='stage_resume' then
      if s.assigned_user_id<>u then raise exception 'استكمال المرحلة لمسؤول المرحلة فقط.'; end if;
      if s.status<>'paused' then raise exception 'المرحلة ليست متوقفة.'; end if;
      update public.bv_task_stages set status='working',running_since=n,updated_at=n where id=s.id;
    elsif p_action='stage_submit' then
      if s.assigned_user_id<>u then raise exception 'تسليم المرحلة لمسؤول المرحلة فقط.'; end if;
      if s.status not in ('working','paused') then raise exception 'ابدأ المرحلة قبل تسليمها.'; end if;
      update public.bv_task_stages set status='submitted',elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,running_since=null,submitted_at=n,note=left(coalesce(p->>'note',''),2000),updated_at=n where id=s.id;
    else
      if r not in ('ceo','team_leader') then raise exception 'اعتماد المرحلة للإدارة فقط.'; end if;
      if s.status<>'submitted' then raise exception 'المرحلة لازم تكون متسلمة قبل الاعتماد.'; end if;
      update public.bv_task_stages set status='approved',approved_at=n,approved_by=u,updated_at=n where id=s.id;
    end if;
    insert into public.bv_activity(task_id,stage_id,actor,action,detail) values(t.id,s.id,u,
      case p_action when 'stage_start' then 'بدء مرحلة' when 'stage_pause' then 'إيقاف مرحلة' when 'stage_resume' then 'استكمال مرحلة' when 'stage_submit' then 'تسليم مرحلة' else 'اعتماد مرحلة' end,
      left(coalesce(nullif(pause_reason,''),nullif(p->>'note',''),s.title_ar),10000));

  elsif p_action='flag_quality' then
    if r not in ('ceo','team_leader') then raise exception 'تسجيل ملاحظة جودة للإدارة فقط.'; end if;
    target_user:=(p->>'user_id')::uuid;
    if coalesce(p->>'kind','') not in ('error_revision','negligent_pause') then raise exception 'نوع الملاحظة غير صحيح.'; end if;
    if coalesce(trim(p->>'note'),'')='' then raise exception 'سبب الملاحظة مطلوب.'; end if;
    insert into public.bv_task_quality_flags(task_id,stage_id,user_id,kind,note,created_by)
    values(t.id,nullif(p->>'stage_id','')::uuid,target_user,p->>'kind',left(trim(p->>'note'),2000),u) returning id into out_id;
    insert into public.bv_activity(task_id,stage_id,actor,action,detail) values(t.id,nullif(p->>'stage_id','')::uuid,u,'ملاحظة جودة تؤثر على النقاط',left(trim(p->>'note'),10000));

  elsif p_action in ('start','pause','resume','submit','delay') then
    select * into a from public.bv_assignments where id=(p->>'assignment_id')::uuid and task_id=t.id and round=t.round and active for update;
    if not found or a.user_id<>u then raise exception 'الإجراء متاح لصاحب التكليف فقط.'; end if;
    if p_action='start' then
      if a.status<>'assigned' then raise exception 'التاسك بدأ بالفعل.'; end if;
      update public.bv_assignments set status='working',running_since=n,started_at=coalesce(started_at,n),deadline_at=coalesce(deadline_at,t.due_at) where id=a.id;
    elsif p_action='pause' then
      if a.status<>'working' then raise exception 'التايمر غير شغال.'; end if;
      update public.bv_assignments set status='paused',elapsed_ms=elapsed_ms+greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint,running_since=null where id=a.id;
      if coalesce(p->>'pause_kind','')='negligence' then
        insert into public.bv_task_quality_flags(task_id,user_id,kind,note,created_by) values(t.id,u,'negligent_pause',left(coalesce(p->>'pause_reason','إيقاف بسبب تقصير'),2000),u);
      end if;
    elsif p_action='resume' then
      if a.status<>'paused' then raise exception 'التايمر ليس متوقفًا.'; end if;
      update public.bv_assignments set status='working',running_since=n where id=a.id;
    elsif p_action='delay' then
      if coalesce(trim(p->>'delay_reason'),'')='' then raise exception 'سبب التأخير مطلوب.'; end if;
      update public.bv_assignments set delay_reason=left(p->>'delay_reason',3000) where id=a.id;
    else
      if a.status not in ('working','paused') then raise exception 'ابدأ التاسك قبل التسليم.'; end if;
      if not coalesce((p->>'submission_url') ~ '^https://(drive|docs)\.google\.com/',false) then raise exception 'لينك Drive للتسليم مطلوب.'; end if;
      update public.bv_assignments set status='submitted',elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
        running_since=null,submitted_at=n,submission_url=p->>'submission_url',delay_reason=coalesce(nullif(trim(p->>'delay_reason'),''),delay_reason),
        deadline_at=coalesce(deadline_at,t.due_at),points_awarded=0,points_reason='يتم احتساب النقاط عند اعتماد المشروع بالكامل.',points_calculated_at=null where id=a.id;
    end if;

  elsif p_action='approve' then
    if r not in ('ceo','team_leader') then raise exception 'اعتماد المشروع للإدارة فقط.'; end if;
    if t.workflow_required then
      if not exists(select 1 from public.bv_task_stages where task_id=t.id) or exists(select 1 from public.bv_task_stages where task_id=t.id and status<>'approved') then raise exception 'لازم كل مراحل المشروع تكون متسلمة ومعتمدة أولًا.'; end if;
    else
      if not exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active) or exists(select 1 from public.bv_assignments where task_id=t.id and round=t.round and active and status<>'submitted') then raise exception 'لازم كل الأعضاء يسلموا التاسك أولًا.'; end if;
    end if;
    approval_note:=left(trim(coalesce(p->>'approval_note','')),3000);
    if t.owner_user_id is null then
      select user_id into owner_id from public.bv_assignments where task_id=t.id and round=t.round and active order by created_at limit 1;
    else owner_id:=t.owner_user_id; end if;
    update public.bv_tasks set approved_at=n,final_approved_by=u,final_approval_note=approval_note,owner_user_id=coalesce(owner_user_id,owner_id),
      approval_snapshot=jsonb_build_object(
        'approved_at',n,'approved_by',u,'owner_user_id',coalesce(owner_user_id,owner_id),
        'stages',(select coalesce(jsonb_agg(to_jsonb(st) order by st.sort_order),'[]'::jsonb) from public.bv_task_stages st where st.task_id=t.id),
        'revisions',(select coalesce(jsonb_agg(to_jsonb(rv) order by rv.created_at),'[]'::jsonb) from public.bv_task_revisions rv where rv.task_id=t.id),
        'quality_flags',(select coalesce(jsonb_agg(to_jsonb(qf) order by qf.created_at),'[]'::jsonb) from public.bv_task_quality_flags qf where qf.task_id=t.id)
      ),updated_at=n where id=t.id;
    if t.workflow_required then
      for target_user in select distinct assigned_user_id from public.bv_task_stages where task_id=t.id loop
        score:=bv_private.project_points(t.id,target_user); score_reason:=bv_private.project_points_reason(t.id,target_user);
        if score=0 then
          delete from public.bv_point_ledger where kind='project_score' and task_id=t.id and user_id=target_user;
        else
          insert into public.bv_point_ledger(user_id,points,kind,task_id,reason,created_by,created_at)
          values(target_user,score,'project_score',t.id,score_reason,u,n)
          on conflict (task_id,user_id) where kind='project_score' and task_id is not null
          do update set points=excluded.points,reason=excluded.reason,created_by=excluded.created_by,created_at=excluded.created_at;
        end if;
      end loop;
    end if;

  elsif p_action='revision' then
    if r not in ('ceo','team_leader') then raise exception 'طلب التعديلات للإدارة فقط.'; end if;
    if coalesce(trim(p->>'note'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'وصف التعديل وموعد تسليمه مطلوبان.'; end if;
    responsible:=nullif(p->>'responsible_user_id','')::uuid;
    insert into public.bv_task_revisions(task_id,round,note,due_at,is_error,responsible_user_id,created_by)
    values(t.id,t.round,left(trim(p->>'note'),10000),(p->>'due_at')::timestamptz,coalesce((p->>'is_error')::boolean,false),responsible,u);
    if coalesce((p->>'is_error')::boolean,false) then
      if responsible is null then raise exception 'حدد الشخص المسؤول عن الخطأ.'; end if;
      insert into public.bv_task_quality_flags(task_id,user_id,kind,note,created_by)
      values(t.id,responsible,'error_revision',left(trim(p->>'note'),2000),u);
    end if;
    update public.bv_assignments set elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
      running_since=null,status=case when status='working' then 'paused' else status end where task_id=t.id and round=t.round;
    insert into public.bv_assignments(task_id,user_id,round,deadline_at)
    select t.id,user_id,t.round+1,(p->>'due_at')::timestamptz from public.bv_assignments where task_id=t.id and round=t.round and active;
    update public.bv_tasks set round=round+1,due_at=(p->>'due_at')::timestamptz,approved_at=null,final_approved_by=null,approval_snapshot=null,updated_at=n where id=t.id;

  elsif p_action='edit_task' then
    if r not in ('ceo','team_leader') then raise exception 'تعديل التاسك للإدارة فقط.'; end if;
    if coalesce(trim(p->>'brief'),'')='' or not coalesce((p->>'due_at')::timestamptz>n,false) then raise exception 'البريف وموعد التسليم مطلوبان.'; end if;
    drive_value:=trim(coalesce(p->>'drive_url','')); if drive_value='' then drive_value:='https://drive.google.com/drive/folders/TEST'; end if;
    if not coalesce(drive_value ~ '^https://(drive|docs)\.google\.com/',false) then raise exception 'لينك Google Drive غير صحيح.'; end if;
    update public.bv_tasks set title=left(trim(p->>'title'),180),brief=left(p->>'brief',20000),drive_url=drive_value,due_at=(p->>'due_at')::timestamptz,updated_at=n where id=t.id;
    update public.bv_assignments set deadline_at=(p->>'due_at')::timestamptz where task_id=t.id and round=t.round and active and status<>'submitted';
  else raise exception 'إجراء غير معروف.'; end if;

  update public.bv_tasks set version=version+1,updated_at=n where id=t.id;
  if p_action not in ('save_workflow','stage_start','stage_pause','stage_resume','stage_submit','stage_approve','flag_quality') then
    text_value:=case p_action when 'assign' then 'توزيع التاسك' when 'start' then 'بدء التاسك' when 'pause' then 'إيقاف التايمر' when 'resume' then 'استكمال التايمر'
      when 'submit' then 'تسليم الشغل للمراجعة' when 'delay' then 'توضيح التأخير' when 'approve' then 'اعتماد المشروع واحتساب نقاطه'
      when 'revision' then 'طلب تعديل' when 'delete_task' then 'نقل التاسك إلى تم التسليم' else 'تعديل التاسك' end;
    insert into public.bv_activity(task_id,assignment_id,actor,action,detail)
    values(t.id,case when p_action in ('start','pause','resume','submit','delay') then a.id else null end,u,text_value,left(coalesce(p->>'approval_note',p->>'note',p->>'delay_reason',''),10000));
  end if;
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
