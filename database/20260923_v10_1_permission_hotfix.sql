-- V10.1 permission hotfix
-- Required because public.bv_state/public.bv_action are SECURITY INVOKER wrappers
-- and their RLS / SQL bodies call these private helper functions as authenticated users.

grant execute on function bv_private.can_read_task(uuid) to authenticated;
grant execute on function bv_private.action(text,jsonb) to authenticated;
