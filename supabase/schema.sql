-- =============================================
-- 汇源 · KNOWLEDGE SPACE 数据库 schema
-- 执行方式: Supabase Dashboard → SQL Editor → 粘贴全部执行
-- =============================================

-- 1. 用户表
create table if not exists public.users (
  id          text primary key,
  email       text not null unique,
  username    text not null unique,
  password_hash text,
  avatar      text,
  passkeys    jsonb not null default '[]'::jsonb,
  created_at  bigint not null
);

create index if not exists users_email_idx    on public.users (email);
create index if not exists users_username_idx on public.users (username);

-- 2. 会话表
create table if not exists public.sessions (
  token      text primary key,
  user_id    text not null references public.users(id) on delete cascade,
  expires_at bigint not null
);

create index if not exists sessions_user_id_idx on public.sessions (user_id);
create index if not exists sessions_expires_idx on public.sessions (expires_at);

-- 3. 知识数据快照表（按用户全量存储）
create table if not exists public.snapshots (
  user_id       text primary key references public.users(id) on delete cascade,
  docs          jsonb not null default '[]'::jsonb,
  active_doc_id text,
  updated_at    bigint not null default 0
);

-- 4. WebAuthn challenge 表（一次性、5 分钟过期）
--    旧实现把 challenge 放在进程内存里：多实例部署时发和验会落到不同实例，
--    且全局只有一个槽位，两个人同时登录必然互相覆盖。
create table if not exists public.webauthn_challenges (
  challenge  text primary key,
  purpose    text not null check (purpose in ('register', 'login')),
  user_id    text references public.users(id) on delete cascade,
  expires_at bigint not null
);

create index if not exists webauthn_challenges_expires_idx
  on public.webauthn_challenges (expires_at);

-- =============================================
-- 注释: 项目使用 JSONB 存储嵌套结构，避免过度规范化
-- users.passkeys → WebAuthn passkeys 数组
-- snapshots.docs → 完整 StoredDoc[]（含 nodes + relations）
-- 前端 PUT /api/data 每次全量覆盖，符合原项目设计
-- =============================================

-- =============================================
-- 5. 权限与 RLS
--    后端用 service_role 读写（绕过 RLS）；浏览器端不直连数据库，
--    所以 anon / authenticated 一律不授权，避免 publishable key 泄露用户密码哈希。
-- =============================================
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.snapshots enable row level security;
alter table public.webauthn_challenges enable row level security;