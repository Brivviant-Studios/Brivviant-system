create or replace function bv_private.submission_points_relative(
  p_assigned_at timestamptz,
  p_deadline timestamptz,
  p_submitted timestamptz
)
returns integer
language plpgsql
immutable
set search_path=''
as $$
declare
  total_seconds numeric;
  early_seconds numeric;
  early_ratio numeric;
begin
  if p_assigned_at is null or p_deadline is null or p_submitted is null then return 0; end if;
  total_seconds := extract(epoch from (p_deadline - p_assigned_at));
  if total_seconds <= 0 then return 0; end if;

  early_seconds := extract(epoch from (p_deadline - p_submitted));
  if early_seconds <= 0 then return 0; end if;

  early_ratio := least(1, early_seconds / total_seconds);

  return case
    when early_ratio >= 0.50 then 100
    when early_ratio >= 0.35 then 80
    when early_ratio >= 0.25 then 60
    when early_ratio >= 0.15 then 40
    when early_ratio >= 0.05 then 25
    else 10
  end;
end $$;

create or replace function bv_private.submission_points_reason_relative(
  p_assigned_at timestamptz,
  p_deadline timestamptz,
  p_submitted timestamptz
)
returns text
language plpgsql
immutable
set search_path=''
as $$
declare
  total_seconds numeric;
  delta_seconds numeric;
  ratio numeric;
  pts integer;
  total_hours numeric;
  delta_hours numeric;
begin
  if p_assigned_at is null or p_deadline is null or p_submitted is null then
    return 'لم يتم احتساب النقاط لعدم اكتمال بيانات الوقت.';
  end if;

  total_seconds := extract(epoch from (p_deadline - p_assigned_at));
  if total_seconds <= 0 then return 'مدة التاسك غير صالحة لاحتساب النقاط.'; end if;

  delta_seconds := extract(epoch from (p_deadline - p_submitted));
  total_hours := round(total_seconds / 3600.0, 1);
  delta_hours := round(abs(delta_seconds) / 3600.0, 1);

  if delta_seconds < 0 then
    return 'تسليم متأخر بـ '||delta_hours||' ساعة من تاسك مدته '||total_hours||' ساعة — 0 نقطة.';
  elsif delta_seconds = 0 then
    return 'تسليم في الموعد بالضبط — 0 نقطة تبكير.';
  end if;

  ratio := least(1, delta_seconds / total_seconds);
  pts := bv_private.submission_points_relative(p_assigned_at,p_deadline,p_submitted);

  return 'تسليم مبكر بـ '||delta_hours||' ساعة ('||
         round(ratio*100,1)||'% من مدة التاسك '||total_hours||
         ' ساعة) — +'||pts||' نقطة.';
end $$;

create or replace function bv_private.apply_relative_assignment_points()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.status='submitted' and new.submitted_at is not null then
    new.points_awarded := bv_private.submission_points_relative(
      new.created_at,
      new.deadline_at,
      new.submitted_at
    );
    new.points_reason := bv_private.submission_points_reason_relative(
      new.created_at,
      new.deadline_at,
      new.submitted_at
    );
    new.points_calculated_at := clock_timestamp();
  elsif new.status<>'submitted' then
    new.points_awarded := 0;
    new.points_reason := '';
    new.points_calculated_at := null;
  end if;
  return new;
end $$;

revoke all on function bv_private.submission_points_relative(timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function bv_private.submission_points_reason_relative(timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function bv_private.apply_relative_assignment_points() from public,anon,authenticated;

drop trigger if exists bv_assignment_relative_points on public.bv_assignments;
create trigger bv_assignment_relative_points
before insert or update of status,submitted_at,deadline_at
on public.bv_assignments
for each row
execute function bv_private.apply_relative_assignment_points();

update public.bv_assignments
set points_awarded = bv_private.submission_points_relative(created_at,deadline_at,submitted_at),
    points_reason = bv_private.submission_points_reason_relative(created_at,deadline_at,submitted_at),
    points_calculated_at = clock_timestamp()
where status='submitted' and submitted_at is not null and deadline_at is not null;
