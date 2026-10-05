-- Schema da aplicação (Postgres). Rode como superusuário/owner do banco.
-- Troque TROQUE_ESTA_SENHA antes de executar.
create schema if not exists pausas;

create table pausas.users (
  id            integer generated always as identity primary key,
  email         text not null unique,
  name          text,
  crm_user_id   text unique,
  crm_agent_id  text,
  profile       text,
  departments   text[] not null default '{}',
  role          text not null default 'user' check (role in ('user','admin')),
  password_hash text,
  active        boolean not null default true,
  busy_until    bigint,
  created_at    bigint not null,
  updated_at    bigint not null,
  last_login_at bigint
);

create table pausas.departments (id text primary key, name text not null);

create table pausas.sessions (
  token_hash text primary key,
  user_id    integer not null references pausas.users(id) on delete cascade,
  created_at bigint not null,
  expires_at bigint not null
);
create index on pausas.sessions(user_id);

create table pausas.pause_reasons (
  id          integer generated always as identity primary key,
  name        text not null,
  color       text not null default '#f59e0b',
  max_minutes integer,
  active      boolean not null default true,
  sort        integer not null default 0
);

create table pausas.intervals (
  id          integer generated always as identity primary key,
  user_id     integer not null references pausas.users(id),
  kind        text not null check (kind in ('active','pause')),
  reason_id   integer references pausas.pause_reasons(id),
  reason_name text,
  max_minutes integer,
  note        text,
  started_at  bigint not null,
  ended_at    bigint,
  started_by  integer,
  ended_by    integer
);
create index on pausas.intervals(user_id, started_at);
create index on pausas.intervals(started_at, ended_at);
create unique index intervals_one_open on pausas.intervals(user_id) where ended_at is null;

create table pausas.audit (
  id integer generated always as identity primary key,
  at bigint not null, actor_id integer, target_id integer, action text not null, detail jsonb
);
create table pausas.meta (key text primary key, value text);
create table pausas.login_attempts (key text not null, at bigint not null);
create index on pausas.login_attempts(key, at);

insert into pausas.pause_reasons (name, color, max_minutes, sort) values
  ('Almoço', '#f97316', 60, 0), ('Lanche', '#eab308', 15, 1), ('Banheiro', '#06b6d4', 10, 2),
  ('Reunião / Feedback', '#8b5cf6', 30, 3), ('Treinamento', '#3b82f6', 60, 4),
  ('Problema técnico', '#ef4444', null, 5), ('Outros', '#64748b', 15, 6);

do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'pausas' loop
    execute format('alter table pausas.%I enable row level security', t);
  end loop;
end $$;
revoke all on schema pausas from anon, authenticated;

create role pausas_app login password 'TROQUE_ESTA_SENHA' bypassrls;
alter role pausas_app set search_path = pausas;
grant usage on schema pausas to pausas_app;
grant select, insert, update, delete on all tables in schema pausas to pausas_app;
grant usage, select on all sequences in schema pausas to pausas_app;
