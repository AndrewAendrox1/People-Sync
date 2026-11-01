create table private.workspace_invitations (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 employee_id uuid not null,
 token_hash text not null unique,
 expires_at timestamptz not null,
 accepted_at timestamptz,
 foreign key(organization_id,employee_id) references public.employees(organization_id,id)
);
alter table private.workspace_invitations enable row level security;
revoke all on private.workspace_invitations from public,anon,authenticated;
