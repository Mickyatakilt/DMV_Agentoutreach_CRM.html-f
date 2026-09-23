-- Lead comments feature — new, additive tables only. Nothing existing is touched.
-- NOT YET APPLIED. Run via Supabase MCP apply_migration (or the dashboard SQL editor)
-- only after Mike approves.

create table if not exists public.lead_comments (
  id bigint generated always as identity primary key,
  kind text not null default 'lead' check (kind in ('lead','task')),
  lead_id bigint not null,
  parent_id bigint references public.lead_comments(id),
  author_id uuid, -- null for an anonymous emailed-link recipient (name-only identity)
  author_name text not null,
  author_role text not null,
  body text not null,
  mentions jsonb not null default '[]'::jsonb,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists lead_comments_lookup on public.lead_comments (kind, lead_id, created_at);
create index if not exists lead_comments_mentions on public.lead_comments using gin (mentions);

-- One row per (user, lead): when they last opened that lead's comment panel.
-- Drives the unread/@mention badge.
create table if not exists public.lead_comment_reads (
  user_id uuid not null,
  kind text not null default 'lead',
  lead_id bigint not null,
  last_read_at timestamptz not null default now(),
  primary key (user_id, kind, lead_id)
);

-- RLS on, no client-facing policies — matches lead_agreements: all reads/writes route
-- through the lead-agreement edge function (service role), which enforces the same
-- recipient-scope rules already used for portal_save/recipient_save.
alter table public.lead_comments enable row level security;
alter table public.lead_comment_reads enable row level security;
