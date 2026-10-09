# Pulse Direct · Gestão de Pausas

Plataforma de gestão de pausas integrada ao Pulse Direct. O atendente controla a própria disponibilidade (jornada e pausas com motivo). A disponibilidade muda na hora no Pulse Direct, e o tempo de pausa e de atividade fica registrado por dia.

**Stack:** Node.js + Express (função serverless na Vercel) · Postgres (Supabase) · frontend em JS puro (`public/`).

## Como funciona
| Ação do atendente | Disponibilidade no Pulse Direct | Registro |
|---|---|---|
| Iniciar jornada | `AVAILABLE` | começa o tempo ativo |
| Pausar (com motivo) | `UNAVAILABLE` | fecha o tempo ativo, abre a pausa |
| Retomar atendimento | `AVAILABLE` | fecha a pausa, abre o tempo ativo |
| Encerrar jornada | `UNAVAILABLE` | fecha o período atual |

A plataforma altera **apenas a disponibilidade** (`PUT /v1/agent/{userId}` com `fields: ["Availability"]`). Ela nunca bloqueia o usuário, então o login no Pulse Direct continua funcionando. Mudanças de disponibilidade feitas direto no Pulse Direct também aparecem na plataforma.

- **Acesso:** o atendente digita o e-mail do Pulse Direct e, no primeiro acesso, cria a senha.
- **Papéis:** `Usuário` vê só os próprios dados. `Admin` tem visão de equipe em tempo real, relatórios (com CSV), motivos de pausa e usuários.
- **Sincronização de usuários:** automática quando a lista tem mais de `SYNC_MINUTES` (ao abrir Equipe ou Usuários), também quando chega um e-mail novo no login, 1x/dia via Vercel Cron e pelo botão na tela Usuários.

## Rodar localmente
```bash
npm install
cp .env.example .env   # preencha as variáveis
npm start              # http://localhost:3000
```

## Banco de dados
Rode `db/schema.sql` no Postgres (troque a senha do usuário `pausas_app`). No Supabase, use a conexão do **pooler em modo transação** (porta 6543):
`postgres://pausas_app.<ref-do-projeto>:<senha>@aws-0-<região>.pooler.supabase.com:6543/postgres`

## Deploy (Vercel)
Configure na Vercel as variáveis do `.env.example`, com `COOKIE_SECURE=true`. A função roda em `gru1` (São Paulo), perto do banco.

## Administradores
- `ADMIN_EMAILS` (separados por vírgula) viram admin automaticamente, **ou**
- `npm run admin -- email@dominio.com` (usa o `DATABASE_URL` do `.env`).

Depois disso, novos admins podem ser promovidos pela tela **Usuários**.

## Distribuição automática (`/distribuicao`)
Aba **Distribuição** no menu, só para admin. Mantém cada atendente com até 15 conversas abertas (pendentes + em atendimento, até ele finalizar): a conversa mais antiga da fila vai para o atendente **online** daquela equipe com mais vagas. Ninguém perde conversa; quem está acima do teto só não recebe mais.

Sobe **desligada**: só simula, e a aba Registro mostra o que faria.

| Aba | O que tem |
|---|---|
| Atendentes | abertos por equipe, vagas, concluídos hoje, planilha · botão **Editar equipes** por pessoa · marcar várias pessoas e colocar ou tirar de uma equipe de uma vez · clicar numa equipe filtra a lista |
| Equipes | fila, espera mais antiga, quem distribui · **Gerenciar**: pessoas da equipe (colocar e tirar várias de uma vez), nome, incluir na distribuição, distribuição do próprio Pulse Direct |
| Registro | entregas, mudanças de pessoas e equipes, avisos e erros |

**Para ligar:**
1. Rode `db/distribuicao.sql` com o dono do banco (depois do `schema.sql`).
2. Defina `DISTRIBUICAO_SEGREDO` na Vercel (opcionais: `PULSE_CHAT_API_URL`, `DISTRIBUICAO_ORCAMENTO_5MIN`).
3. Na tela, **Ligar eventos do Pulse Direct**: cada conversa nova, atualizada ou encerrada dispara um ciclo, sem ninguém com a tela aberta. Opcional: agendador chamando `GET /api/distribuicao/ciclo` com `Authorization: Bearer <CRON_SECRET>`.
4. Em **Equipes › Gerenciar › Configuração**, inclua a equipe e desligue nela a distribuição do próprio Pulse Direct.
5. **Ligar distribuição automática.** Desligar volta a só simular.

Cada entrega confere a conversa e a contagem do atendente no Pulse Direct na hora, e uma escrita nunca é repetida. Pessoas, equipes e quem está online vêm direto do Pulse Direct (relidos a cada poucos segundos), sem cadastro paralelo.

**Testes:** `DATABASE_URL_TESTE=postgres://pausas_app:<senha>@localhost:5432/<banco_local> npm test` (banco local com `schema.sql` e `distribuicao.sql`; recusa banco remoto).
