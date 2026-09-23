# Racha Times — Montar Times offline-first (Cloudflare)

App para montar os times do racha, **funciona sem internet** e **sincroniza sozinho**
quando a conexão volta. É uma porta fiel do módulo **Montar Times** do
`gestao-racha` (Laravel), com foco em **visualização mobile**.

## O que faz

Módulo de formação de times, com as mesmas regras do sistema original:

- **Fila** por ordem de chegada, com reordenação (arrastar ou ▲▼), desistência e recolocação
- **Partida**: a 1ª exige 14 jogadores e distribui alternando **Time Laranja** (`team_a`) e **Time Preto** (`team_b`), 7 por time
- **Placar** recalculado automaticamente ao marcar/remover gol
- **Finalizar**: perdedores voltam ao fim da fila e o **vencedor fica aguardando na quadra mantendo a cor**
- **Montar time** (manual): a partir da 2ª partida exige apenas **7** — os 7 primeiros da fila entram no lugar do perdedor, contra o vencedor, que **não troca de camisa** (mantém `team_a`/`team_b`)
- **Desfazer resultado** apenas da última partida finalizada (restaura a fila exata via snapshot e remove a partida seguinte, se houver)
- **Substituição** por busca na fila (quem sai vai para o fim, gols não são transferidos)
- **Remover da partida** devolve o jogador ao fim da fila
- **Movimentações da partida**: remoções e substituições ficam registradas no histórico da partida (com horário)
- **Artilheiros** (soma de gols por jogador)
- **Auditoria**: cada ação grava quem fez (`team_action_logs`)

### Propriedade e visualização

- **Só quem criou o racha pode alterar** (identidade `owner_id` gerada no dispositivo). A API bloqueia alterações de outros usuários com `403`.
- **Tela inicial**: rachas em aberto aparecem no topo em card maior (com selo "Seu racha" ou o nome do dono); os **finalizados** vão para a lista "Anteriores" como visualização.
- **Finalizar racha**: botão com confirmação; o racha vai para "Anteriores" e fica somente leitura (pode ser reaberto).
- Rachas criados antes da propriedade existir podem ser recuperados com o botão **"Estes rachas são meus (reivindicar)"**.

## Arquitetura

```
┌───────────────────────────── PWA (public/) ─────────────────────────────┐
│  app.js      UI mobile (SPA, roteamento por hash)                        │
│  domain.js   ← REGRAS DE NEGÓCIO (compartilhado com o Worker)            │
│  store.js    IndexedDB: estado local + outbox de operações               │
│  sync.js     envia outbox em lote, adota estado canônico do servidor     │
│  sw.js       Service Worker (app shell offline)                          │
└──────────────────────────────────────────────────────────────────────────┘
                                   │  /api/*  (Hono)
                                   ▼
┌────────────────────── Cloudflare Worker (src/) ──────────────────────────┐
│  index.js    rotas Hono                                                   │
│  db.js       D1: loadState / applyOps (idempotente) / persist atômico     │
│  ../public/domain.js  ← MESMAS regras aplicadas no servidor               │
└──────────────────────────────────────────────────────────────────────────┘
                                   ▼
                             D1 (SQLite)
```

**Por que funciona offline:** o cliente aplica a operação na hora sobre o estado
local (IndexedDB) e guarda a operação numa fila (`outbox`). Quando há internet, a
fila é enviada em lote para a API, que reaplica as operações sobre o estado
autoritativo no D1 **de forma idempotente** (`applied_ops`) e devolve o estado
canônico, que o cliente adota. A mesma `domain.js` roda nos dois lados — não há
duplicação de regra.

## Desenvolvimento local

```bash
npm install
npm run db:init:local     # cria as tabelas no D1 local
npm run dev               # http://localhost:8787
npm test                  # testes das regras de domínio (vitest)
```

O D1 local roda em `.wrangler/state` (não precisa de conta Cloudflare).

## Deploy na Cloudflare

1. Autentique e crie o banco D1:

```bash
npx wrangler login
npx wrangler d1 create racha-times-db
```

2. Copie o `database_id` retornado para `wrangler.jsonc` (substitua o placeholder).

3. Crie as tabelas no banco remoto:

```bash
npm run db:init:remote
```

4. Publique:

```bash
npm run deploy
```

O Worker serve a API em `/api/*` e os arquivos estáticos da PWA. O app abre no
domínio publicado e pode ser instalado na tela inicial (Add to Home Screen).

## Estrutura

```
wrangler.jsonc      config do Worker (assets + D1)
schema.sql          schema do D1
src/index.js        rotas da API (Hono)
src/db.js           persistência D1 + aplicação idempotente de operações
public/domain.js    regras de negócio (compartilhado client/server)
public/app.js       SPA mobile
public/store.js     IndexedDB (estado + outbox)
public/sync.js      engine de sincronização
public/sw.js        service worker (offline)
public/styles.css   design mobile-first (laranja/preto)
test/domain.test.js testes das regras
```

## Notas

- **IDs são UUID gerados no cliente**, para permitir criar fila/partida offline sem colisão.
- **Conflitos:** cada evento tem uma `version`; a API usa um guard otimista com retry.
  Se outro aparelho escreveu antes, o cliente adota o estado mais recente do servidor.
- **Sem autenticação/pagamentos** — fora do escopo deste app. A identidade (nome/telefone)
  é usada apenas para o log de auditoria e fica salva no dispositivo.
- O `database_id` placeholder (`00000000-...`) só funciona localmente; troque antes do deploy.
