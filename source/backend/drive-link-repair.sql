-- Applied to Studio. Existing records are preserved; every new/updated row requires Drive.
alter table public.bv_tasks drop constraint bv_tasks_drive_url_check;
alter table public.bv_tasks add constraint bv_tasks_drive_url_check
check (drive_url ~ '^https://(drive|docs)[.]google[.]com/') not valid;
do $repair$
declare def text;
begin
 select pg_get_functiondef('bv_private.action(text,jsonb)'::regprocedure) into def;
 def:=replace(def, E'^https://(drive|docs)\\\\.google\\\\.com/', '^https://(drive|docs)[.]google[.]com/');
 execute def;
end $repair$;
