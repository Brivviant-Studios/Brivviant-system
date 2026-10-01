create table if not exists public.bv_push_config (
 id integer primary key check(id=1),
 vapid_public text,
 vapid_private text,
 internal_secret text not null default(gen_random_uuid()::text||gen_random_uuid()::text),
 updated_at timestamptz not null default clock_timestamp()
);
alter table public.bv_push_config enable row level security;
revoke all on public.bv_push_config from anon,authenticated;
insert into public.bv_push_config(id)
select 1 where not exists(select 1 from public.bv_push_config where id=1);

create or replace function bv_private.push_notification_webhook()
returns trigger language plpgsql security definer set search_path=''
as $$
declare secret_value text;
begin
 select internal_secret into secret_value from public.bv_push_config where id=1;
 perform net.http_post(
  url:='https://viwaclirvokwoeqqivgr.supabase.co/functions/v1/brivviant-push',
  headers:=jsonb_build_object('Content-Type','application/json','x-internal-secret',secret_value),
  body:=jsonb_build_object(
    'action','dispatch',
    'notification_id',new.id,
    'user_id',new.user_id,
    'title',new.title,
    'kind',new.kind,
    'task_id',new.task_id,
    'request_id',new.request_id,
    'peer_id',new.peer_id
  )
 );
 return new;
end $$;
revoke all on function bv_private.push_notification_webhook() from public,anon,authenticated;

drop trigger if exists bv_notification_push on public.bv_notifications;
create trigger bv_notification_push
after insert on public.bv_notifications
for each row execute function bv_private.push_notification_webhook();
