-- Supabase PostgreSQL foundation. Auth roles come only from trusted memberships.
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(trim(name)) >= 2),
  code text not null unique check(code ~ '^[A-Z0-9-]{3,20}$'),
  timezone text not null default 'Asia/Kolkata',
  workdays integer[] not null default '{1,2,3,4,5}',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  user_id uuid not null references auth.users(id),
  role text not null check(role in ('owner','admin','hr','attendance','approver','project','employee')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(organization_id,user_id)
);
create index memberships_user_active on public.memberships(user_id,organization_id) where active;
create table public.employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  user_id uuid references auth.users(id),
  employee_code text not null,
  name text not null,
  email text not null,
  department text not null default 'General',
  designation text,
  joining_date date,
  status text not null default 'Active' check(status in ('Active','Inactive','Exited')),
  profile jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(organization_id,employee_code),
  unique(organization_id,email),
  unique(organization_id,id)
);
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  code text not null,
  start_time time not null,
  end_time time not null,
  policy jsonb not null default '{}',
  active boolean not null default true,
  unique(organization_id,code),
  unique(organization_id,id)
);
create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null,
  work_date date not null,
  check_in timestamptz,
  check_out timestamptz,
  shift_snapshot jsonb not null,
  result jsonb not null default '{}',
  unique(organization_id,employee_id,work_date),
  foreign key(organization_id,employee_id) references public.employees(organization_id,id),
  check(check_out is null or (check_in is not null and check_out >= check_in))
);
create table public.leave_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  code text not null,
  entitlement numeric(6,2) not null check(entitlement >= 0),
  active boolean not null default true,
  unique(organization_id,code),
  unique(organization_id,id)
);
create table public.leave_balances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null,
  policy_id uuid not null,
  year integer not null,
  allocated numeric(6,2) not null default 0,
  used numeric(6,2) not null default 0,
  reserved numeric(6,2) not null default 0,
  foreign key(organization_id,employee_id) references public.employees(organization_id,id),
  foreign key(organization_id,policy_id) references public.leave_policies(organization_id,id),
  unique(organization_id,employee_id,policy_id,year),
  check(used >= 0 and reserved >= 0 and allocated >= used + reserved)
);
create table public.requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null,
  kind text not null,
  status text not null default 'Pending' check(status in ('Pending','Approved','Rejected','Cancelled','Clarification')),
  from_date date not null,
  to_date date not null,
  reason text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key(organization_id,employee_id) references public.employees(organization_id,id),
  check(to_date >= from_date)
);
create index requests_inbox on public.requests(organization_id,status,created_at desc);

-- Fail closed during migration: no anonymous or direct client writes.
-- API write operations and employee-specific policies are added with their routes.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;
create function private.is_workspace_admin(workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.memberships m
    where m.organization_id=workspace_id and m.user_id=auth.uid()
    and m.active and m.role in ('owner','admin'));
$$;
revoke all on function private.is_workspace_admin(uuid) from public;
grant execute on function private.is_workspace_admin(uuid) to authenticated;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.employees enable row level security;
alter table public.shifts enable row level security;
alter table public.attendance enable row level security;
alter table public.leave_policies enable row level security;
alter table public.leave_balances enable row level security;
alter table public.requests enable row level security;
create policy own_memberships on public.memberships for select to authenticated using(user_id=auth.uid());
create policy admin_organizations on public.organizations for select to authenticated using(private.is_workspace_admin(id));
create policy admin_employees on public.employees for select to authenticated using(private.is_workspace_admin(organization_id));
create policy admin_shifts on public.shifts for select to authenticated using(private.is_workspace_admin(organization_id));
create policy admin_attendance on public.attendance for select to authenticated using(private.is_workspace_admin(organization_id));
create policy admin_leave_policies on public.leave_policies for select to authenticated using(private.is_workspace_admin(organization_id));
create policy admin_leave_balances on public.leave_balances for select to authenticated using(private.is_workspace_admin(organization_id));
create policy admin_requests on public.requests for select to authenticated using(private.is_workspace_admin(organization_id));
revoke all on public.organizations, public.memberships, public.employees,
  public.shifts, public.attendance, public.leave_policies, public.leave_balances,
  public.requests from anon, authenticated;
grant select on public.organizations, public.memberships, public.employees,
  public.shifts, public.attendance, public.leave_policies, public.leave_balances,
  public.requests to authenticated;
