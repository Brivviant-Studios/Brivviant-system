-- Additive upgrade. Existing tasks, accounts and passwords are preserved.
do $upgrade$
declare def text;
begin
 select pg_get_functiondef('bv_private.action(text,jsonb)'::regprocedure) into def;
 def:=replace(def, 'and active and role=''employee''','and active');
 def:=replace(def, 'اختر موظفًا واحدًا على الأقل.', 'اختر عضوًا مفعّلًا واحدًا على الأقل.');
 execute def;
end $upgrade$;

create table public.bv_messages (
 id bigint generated always as identity primary key,
 client_id uuid not null,
 sender_id uuid not null references public.bv_profiles(id),
 recipient_id uuid not null references public.bv_profiles(id),
 body text not null check(length(trim(body)) between 1 and 5000),
 created_at timestamptz not null default clock_timestamp(),
 read_at timestamptz,
 check(sender_id<>recipient_id), unique(sender_id,client_id)
);
create index bv_messages_sender on public.bv_messages(sender_id,recipient_id,id desc);
create index bv_messages_recipient on public.bv_messages(recipient_id,sender_id,id desc);
create table public.bv_notifications (
 id bigint generated always as identity primary key,
 user_id uuid not null references public.bv_profiles(id),
 kind text not null check(kind in ('task','request','message','account')),
 title text not null,
 task_id uuid references public.bv_tasks(id),
 request_id uuid references public.bv_requests(id),
 peer_id uuid references public.bv_profiles(id),
 message_id bigint references public.bv_messages(id),
 created_at timestamptz not null default clock_timestamp(),
 read_at timestamptz
);
create index bv_notifications_owner on public.bv_notifications(user_id,id desc);
create index bv_notifications_unread on public.bv_notifications(user_id) where read_at is null;
create index bv_notifications_task on public.bv_notifications(task_id);
create index bv_notifications_request on public.bv_notifications(request_id);
create index bv_notifications_peer on public.bv_notifications(peer_id);
create index bv_notifications_message on public.bv_notifications(message_id);
alter table public.bv_messages enable row level security;
alter table public.bv_notifications enable row level security;
revoke all on public.bv_messages,public.bv_notifications from anon,authenticated;
grant select on public.bv_messages,public.bv_notifications to authenticated;
grant all on public.bv_messages,public.bv_notifications to service_role;
grant usage,select on sequence public.bv_messages_id_seq,public.bv_notifications_id_seq to service_role;
create policy bv_message_private on public.bv_messages for select to authenticated
using ((select bv_private.member_role()) is not null and ((select auth.uid())=sender_id or (select auth.uid())=recipient_id));
create policy bv_notification_private on public.bv_notifications for select to authenticated
using ((select bv_private.member_role()) is not null and user_id=(select auth.uid()));

create function bv_private.communicate(p_action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); peer uuid; mid bigint; existing public.bv_messages;
begin
 if u is null or not exists(select 1 from public.bv_profiles where id=u and active and not must_change) then raise exception 'سجّل الدخول بحساب مفعّل أولًا.'; end if;
 if p_action='send' then
  peer:=(p->>'recipient_id')::uuid;
  if peer=u or not exists(select 1 from public.bv_profiles where id=peer and active) then raise exception 'اختر عضوًا مفعّلًا آخر.'; end if;
  if p->>'client_id' is null or coalesce(length(trim(p->>'body')),0) not between 1 and 5000 then raise exception 'اكتب رسالة من 1 إلى 5000 حرف.'; end if;
  insert into public.bv_messages(client_id,sender_id,recipient_id,body)
  values((p->>'client_id')::uuid,u,peer,trim(p->>'body'))
  on conflict(sender_id,client_id) do nothing returning id into mid;
  if mid is null then
   select * into existing from public.bv_messages where sender_id=u and client_id=(p->>'client_id')::uuid;
   if existing.recipient_id<>peer or existing.body<>trim(p->>'body') then raise exception 'معرّف الرسالة مستخدم. ابدأ رسالة جديدة.'; end if;
   mid:=existing.id;
  end if;
 elsif p_action='read_chat' then
  peer:=(p->>'peer_id')::uuid;
  update public.bv_messages set read_at=clock_timestamp() where recipient_id=u and sender_id=peer and id<=(p->>'through')::bigint and read_at is null;
  update public.bv_notifications set read_at=clock_timestamp() where user_id=u and kind='message' and peer_id=peer and message_id<=(p->>'through')::bigint and read_at is null;
 elsif p_action='read_notification' then
  update public.bv_notifications set read_at=clock_timestamp() where user_id=u and id=(p->>'id')::bigint and read_at is null;
 elsif p_action='read_all' then
  update public.bv_notifications set read_at=clock_timestamp() where user_id=u and id<=(p->>'through')::bigint and read_at is null;
 else raise exception 'إجراء غير معروف.';
 end if;
 return jsonb_build_object('ok',true,'id',mid);
end $$;
revoke all on function bv_private.communicate(text,jsonb) from public,anon;
grant execute on function bv_private.communicate(text,jsonb) to authenticated;
create function public.bv_communicate(p_action text,p jsonb) returns jsonb
language sql security invoker set search_path='' as $$select bv_private.communicate(p_action,p)$$;
revoke all on function public.bv_communicate(text,jsonb) from public,anon;
grant execute on function public.bv_communicate(text,jsonb) to authenticated;

-- Notifications and the originating change are committed atomically.
create function bv_private.notify_event() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='bv_messages' then
  insert into public.bv_notifications(user_id,kind,title,peer_id,message_id)
  values(new.recipient_id,'message','رسالة خاصة جديدة',new.sender_id,new.id);
 elsif tg_table_name='bv_activity' then
  -- Every active member gets a neutral task update. Details stay behind task RLS.
  insert into public.bv_notifications(user_id,kind,title,task_id)
  select p.id,'task',new.action,
   case when p.role in ('ceo','coordinator') or exists(select 1 from public.bv_assignments a where a.task_id=new.task_id and a.user_id=p.id and a.active) then new.task_id else null end
  from public.bv_profiles p where p.active;
 elsif tg_table_name='bv_requests' then
  insert into public.bv_notifications(user_id,kind,title,request_id)
  select p.id,'request',case when tg_op='INSERT' then 'طلب أو شكوى جديدة' else 'تحديث متابعة طلب أو شكوى' end,new.id
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
create trigger bv_message_notification after insert on public.bv_messages for each row execute function bv_private.notify_event();
create trigger bv_task_notification after insert on public.bv_activity for each row execute function bv_private.notify_event();
create trigger bv_request_notification after insert or update on public.bv_requests for each row execute function bv_private.notify_event();
create trigger bv_profile_notification after insert or update on public.bv_profiles for each row execute function bv_private.notify_event();
alter publication supabase_realtime add table public.bv_messages,public.bv_notifications;
