drop policy if exists bv_profile_read on public.bv_profiles;
create policy bv_profile_read on public.bv_profiles for select to authenticated
using ((id=(select auth.uid())) or ((select bv_private.member_role()) is not null));
