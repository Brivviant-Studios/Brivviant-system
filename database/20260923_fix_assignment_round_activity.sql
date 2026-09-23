-- Already applied to the live Studio project on 2026-09-23.
-- Prevents old revision-round assignments from remaining active.

create or replace function bv_private.deactivate_previous_assignment_rounds()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.bv_assignments
  set active = false,
      elapsed_ms = elapsed_ms
        + case
            when running_since is null then 0
            else greatest(0,floor(extract(epoch from (clock_timestamp() - running_since)) * 1000)::bigint)
          end,
      running_since = null,
      status = case when status = 'working' then 'paused' else status end
  where task_id = new.task_id
    and user_id = new.user_id
    and round < new.round
    and active = true;
  return new;
end;
$$;

drop trigger if exists bv_deactivate_previous_assignment_rounds on public.bv_assignments;
create trigger bv_deactivate_previous_assignment_rounds
before insert on public.bv_assignments
for each row execute function bv_private.deactivate_previous_assignment_rounds();

update public.bv_assignments a
set active = false,
    running_since = null,
    status = case when status = 'working' then 'paused' else status end
from public.bv_tasks t
where a.task_id = t.id and a.round < t.round and a.active = true;
