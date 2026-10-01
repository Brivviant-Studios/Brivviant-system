alter table public.bv_tasks add column deleted_at timestamptz, add column deleted_by uuid references public.bv_profiles(id);
create index bv_tasks_deleted_by on public.bv_tasks(deleted_by);
alter table public.bv_tasks drop constraint bv_tasks_drive_url_check;
alter table public.bv_tasks add constraint bv_tasks_drive_url_check check(deleted_at is not null or drive_url ~ '^https://(drive|docs)[.]google[.]com/') not valid;
create or replace function bv_private.can_read_task(t uuid) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.bv_tasks where id=t and deleted_at is null) and (
  bv_private.member_role() in ('ceo','coordinator') or (
   bv_private.member_role()='employee' and exists(select 1 from public.bv_assignments where task_id=t and user_id=auth.uid() and active)
  ))
$$;
do $upgrade$
declare def text;
begin
 select pg_get_functiondef('bv_private.action(text,jsonb)'::regprocedure) into def;
 def:=replace(def, $old$'revision','edit_task'$old$, $new$'revision','edit_task','delete_task'$new$);
 def:=replace(def, 'if p_action=''assign'' then', $branch$if p_action='delete_task' then
   if r<>'ceo' then raise exception 'حذف التاسكات للـCEO فقط.'; end if;
   update public.bv_assignments set elapsed_ms=elapsed_ms+case when running_since is null then 0 else greatest(0,floor(extract(epoch from(n-running_since))*1000))::bigint end,
    running_since=null,status=case when status='working' then 'paused' else status end where task_id=t.id;
   update public.bv_tasks set deleted_at=n,deleted_by=u where id=t.id;
  elsif p_action='assign' then$branch$);
 def:=replace(def, 'else ''تعديل التاسك'' end', 'when ''delete_task'' then ''حذف التاسك'' else ''تعديل التاسك'' end');
 execute def;
 -- Keep deletion alerts neutral and avoid links to a removed task.
 select pg_get_functiondef('bv_private.notify_event()'::regprocedure) into def;
 def:=replace(def,'case when p.role in', 'case when new.action<>''حذف التاسك'' and (p.role in');
 def:=replace(def, 'a.user_id=p.id and a.active) then new.task_id', 'a.user_id=p.id and a.active)) then new.task_id');
 execute def;
end $upgrade$;
