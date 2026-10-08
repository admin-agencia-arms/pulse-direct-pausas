-- Distribuição automática de conversas (aba /distribuicao). Rode como owner do banco, depois do schema.sql.
-- Idempotente: pode rodar de novo sem perder dados.

-- Cópia local das conversas que importam: abertas e concluídas hoje.
create table if not exists pausas.dist_conversas (
  id            text primary key,
  status        text not null,
  equipe_id     text,
  user_id       text,
  criada_em     bigint,                    -- ms
  alterada_us   bigint not null default 0, -- µs (precisão do Pulse Direct)
  encerrada_em  bigint,                    -- ms
  tipo          text,
  leitura       integer                    -- rodada da última leitura completa que viu a conversa
);
create index if not exists dist_conversas_dono on pausas.dist_conversas (user_id) where status in ('STARTED', 'PENDING', 'IN_PROGRESS');
create index if not exists dist_conversas_fila on pausas.dist_conversas (equipe_id) where status = 'PENDING' and user_id is null;
create index if not exists dist_conversas_concluidas on pausas.dist_conversas (encerrada_em) where status = 'COMPLETED';

-- Configuração e estado do motor (marca d'água, cursores, fotos de equipes/atendentes, avisos).
create table if not exists pausas.dist_estado (chave text primary key, valor jsonb not null, atualizado_em bigint not null);

-- Travas com validade (um ciclo por vez entre instâncias serverless).
create table if not exists pausas.dist_trava (nome text primary key, dono text not null, expira_em bigint not null);

-- Simulação: última decisão por conversa (para não repetir e registrar o desfecho).
create table if not exists pausas.dist_simulacao (conversa_id text primary key, user_id text not null, em bigint not null);

create table if not exists pausas.dist_decisoes (
  id          bigint generated always as identity primary key,
  em          bigint not null,
  modo        text not null,
  conversa_id text not null,
  equipe_id   text,
  equipe      text,
  user_id     text,
  atendente   text,
  carga_antes integer not null default 0,
  resultado   text not null,
  detalhe     text
);
create index if not exists dist_decisoes_em on pausas.dist_decisoes (em);

create table if not exists pausas.dist_eventos (
  id bigint generated always as identity primary key,
  em bigint not null, nivel text not null, tipo text not null, mensagem text not null, dados jsonb
);
create index if not exists dist_eventos_em on pausas.dist_eventos (em);

create table if not exists pausas.dist_chamadas (
  id bigint generated always as identity primary key,
  em bigint not null, metodo text not null, caminho text not null,
  status integer not null, duracao_ms integer not null, tentativa integer not null
);
create index if not exists dist_chamadas_em on pausas.dist_chamadas (em);

create table if not exists pausas.dist_ciclos (
  id bigint generated always as identity primary key,
  em bigint not null, origem text not null, duracao_ms integer not null,
  requisicoes integer not null, decisoes integer not null, erro text
);
create index if not exists dist_ciclos_em on pausas.dist_ciclos (em);

-- Mesmas regras do schema.sql: RLS ligado (o app usa pausas_app, que ignora RLS) e nada para anon/authenticated.
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'pausas' and tablename like 'dist\_%' loop
    execute format('alter table pausas.%I enable row level security', t);
  end loop;
end $$;
grant select, insert, update, delete on all tables in schema pausas to pausas_app;
grant usage, select on all sequences in schema pausas to pausas_app;
