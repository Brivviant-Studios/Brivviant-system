-- Preserve the production migration 20261008125320 in version control.
-- Team Leader AI planning drafts are private to the owning account.
create table if not exists public.bv_ai_plans (
 user_id uuid primary key references auth.users(id) on delete cascade,
 payload jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
alter table public.bv_ai_plans enable row level security;
grant select,insert,update on public.bv_ai_plans to authenticated;
create policy "ai_plans_owner_select" on public.bv_ai_plans for select to authenticated using (user_id=(select auth.uid()));
create policy "ai_plans_owner_insert" on public.bv_ai_plans for insert to authenticated with check (user_id=(select auth.uid()) and exists (select 1 from public.bv_profiles p where p.id=(select auth.uid()) and p.active and p.role='team_leader'));
create policy "ai_plans_owner_update" on public.bv_ai_plans for update to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()) and exists (select 1 from public.bv_profiles p where p.id=(select auth.uid()) and p.active and p.role='team_leader'));
