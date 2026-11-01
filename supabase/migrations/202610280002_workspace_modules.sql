-- Workspace modules with composite tenant-safe foreign keys.
-- Composite foreign keys prevent relationships crossing workspace boundaries.
alter table public.memberships add unique (organization_id, id);
alter table public.attendance add unique (organization_id, id);
alter table public.requests add unique (organization_id, id);
alter table public.employees
  add column manager_id uuid,
  add column shift_id uuid,
  add foreign key (organization_id, manager_id) references public.employees(organization_id, id),
  add foreign key (organization_id, shift_id) references public.shifts(organization_id, id),
  add check (manager_id is null or manager_id <> id);
create unique index employees_workspace_user on public.employees(organization_id, user_id)
  where user_id is not null;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null check (length(trim(name)) > 0),
  description text not null default '',
  status text not null default 'Planning',
  deadline date,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);
create table public.project_members (
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null,
  employee_id uuid not null,
  primary key (organization_id, project_id, employee_id),
  foreign key (organization_id, project_id) references public.projects(organization_id, id),
  foreign key (organization_id, employee_id) references public.employees(organization_id, id)
);
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null,
  employee_id uuid,
  title text not null check (length(trim(title)) > 0),
  status text not null default 'To do',
  deadline date,
  created_at timestamptz not null default now(),
  foreign key (organization_id, project_id) references public.projects(organization_id, id),
  foreign key (organization_id, employee_id) references public.employees(organization_id, id)
);
create table public.onboarding_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null,
  title text not null check (length(trim(title)) > 0),
  deadline date,
  status text not null default 'Not Started',
  notes text not null default '',
  created_at timestamptz not null default now(),
  foreign key (organization_id, employee_id) references public.employees(organization_id, id)
);
create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  holiday_date date not null,
  unique (organization_id, holiday_date)
);
create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  author_membership_id uuid not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, author_membership_id) references public.memberships(organization_id, id)
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  recipient_membership_id uuid not null,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, recipient_membership_id) references public.memberships(organization_id, id)
);
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null,
  name text not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  status text not null default 'Pending Review',
  created_at timestamptz not null default now(),
  foreign key (organization_id, employee_id) references public.employees(organization_id, id),
  check (split_part(storage_path, '/', 1) = organization_id::text),
  check (split_part(storage_path, '/', 2) = employee_id::text)
);
create table public.punches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  attendance_id uuid not null,
  kind text not null check (kind in ('in', 'out')),
  punched_at timestamptz not null,
  foreign key (organization_id, attendance_id) references public.attendance(organization_id, id),
  unique (organization_id, attendance_id, kind)
);
create table public.leave_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null,
  policy_id uuid not null,
  request_id uuid,
  actor_membership_id uuid,
  amount numeric(6,2) not null,
  kind text not null,
  reason text,
  created_at timestamptz not null default now(),
  foreign key (organization_id, employee_id) references public.employees(organization_id, id),
  foreign key (organization_id, policy_id) references public.leave_policies(organization_id, id),
  foreign key (organization_id, request_id) references public.requests(organization_id, id),
  foreign key (organization_id, actor_membership_id) references public.memberships(organization_id, id)
);
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  actor_membership_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  changes jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (organization_id, actor_membership_id) references public.memberships(organization_id, id)
);
create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  provider text not null,
  event_id text not null,
  payment_id text,
  amount_minor bigint check (amount_minor >= 0),
  currency text,
  status text not null,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);
-- Encrypted identity records stay outside the exposed API schema.
create table private.employee_sensitive (
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  primary key (organization_id, employee_id),
  foreign key (organization_id, employee_id) references public.employees(organization_id, id)
);
alter table private.employee_sensitive enable row level security;
revoke all on private.employee_sensitive from public, anon, authenticated;

-- Explicit grants and RLS remain read-only until transactional API functions exist.
do $$
declare table_name text;
begin
  foreach table_name in array array['projects', 'project_members', 'tasks',
    'onboarding_tasks', 'holidays', 'announcements', 'notifications', 'documents',
    'punches', 'leave_transactions', 'audit_events', 'payment_events']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('create policy admin_read on public.%I for select to authenticated using (private.is_workspace_admin(organization_id))', table_name);
    execute format('create index %I on public.%I (organization_id)', table_name || '_workspace', table_name);
  end loop;
end;
$$;
create index tasks_assignee on public.tasks(organization_id, employee_id);
create index notifications_recipient on public.notifications(organization_id, recipient_membership_id, created_at desc);
create index audit_events_timeline on public.audit_events(organization_id, created_at desc);
