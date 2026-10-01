create or replace function bv_private.project_points(p_task uuid,p_user uuid)
returns integer language plpgsql stable security definer set search_path=''
as $$
declare planned numeric; actual numeric; ratio numeric; has_flag boolean;
begin
 select exists(select 1 from public.bv_task_quality_flags q where q.task_id=p_task and q.user_id=p_user) into has_flag;
 if has_flag then return 0; end if;
 select coalesce(sum(planned_hours*3600000),0),
        coalesce(sum(elapsed_ms + case when running_since is null then 0 else greatest(0,extract(epoch from(clock_timestamp()-running_since))*1000) end),0)
 into planned,actual from public.bv_task_stages where task_id=p_task and assigned_user_id=p_user;
 if planned<=0 then return 0; end if;
 ratio:=actual/planned;
 if ratio<=0.75 then return 100;
 elsif ratio<=1.00 then return 90;
 elsif ratio<=1.15 then return 70;
 elsif ratio<=1.30 then return 50;
 elsif ratio<=1.50 then return 25;
 else return 0; end if;
end $$;
revoke all on function bv_private.project_points(uuid,uuid) from public,anon,authenticated;

create or replace function bv_private.project_points_reason(p_task uuid,p_user uuid)
returns text language plpgsql stable security definer set search_path=''
as $$
declare planned numeric; actual numeric; ratio numeric; flags text; pts integer;
begin
 select string_agg(case kind when 'error_revision' then 'تعديل بسبب خطأ' else 'إيقاف بسبب تقصير' end,'، ' order by created_at)
 into flags from public.bv_task_quality_flags where task_id=p_task and user_id=p_user;
 if flags is not null then return flags||' — نقاط المشروع = 0.'; end if;
 select coalesce(sum(planned_hours),0),coalesce(sum(elapsed_ms/3600000.0),0)
 into planned,actual from public.bv_task_stages where task_id=p_task and assigned_user_id=p_user;
 pts:=bv_private.project_points(p_task,p_user);
 if planned<=0 then return 'لم يتم احتساب نقاط: لا توجد ساعات مخططة لهذا العضو.'; end if;
 ratio:=actual/planned;
 return 'أداء المشروع: '||round(actual,2)||' ساعة فعلية من '||round(planned,2)||' ساعة مخططة ('||round(ratio*100,1)||'%) — '||pts||' نقطة.';
end $$;
revoke all on function bv_private.project_points_reason(uuid,uuid) from public,anon,authenticated;
