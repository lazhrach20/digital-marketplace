# Digital Marketplace MVP — Implementation Plan

**Source:** `prds/tz_main.md` (union backend + fullstack). Greenfield repo: no Nest, Prisma, `apps/web`, tests, Docker, `package.json`, or README yet.

**Goal:** Catalog → order → webhook payment → exactly-once key delivery (timeout ≠ failure, A→B fallback, recoverable empty pool + retry-delivery) + vanilla Figma storefront + race scripts. Tests T1–T10.

**Out of scope:** B1–B4 (see §5). Do not invent bonus work.

---

## 1. Ordered layers of work

Layers are sequential. Each numbered item is sized for a later atomic 5–10 min task. Do not start Docker/Nest/static servers in worker tasks; shared runtime is orchestrator-owned (§4).

### Layer 1 — Domain (`apps/api/src/domain/`)

Pure TypeScript. No Prisma, no Nest HTTP. This is the source of truth for transitions and policies.

1.1 Repo bootstrap (minimal, no app logic): root `package.json` workspaces (`apps/api`, `apps/web`), Nest CLI app under `apps/api`, TypeScript strict, `class-validator` / `class-transformer` / `@nestjs/common`. Empty `apps/web` placeholder. Do **not** add React/Next/Vue/Tailwind/Playwright-as-app-dep.

1.2 Enums (explicit, named as in stack/domain rules):
- `OrderStatus`: `created` | `paid` | `delivering` | `delivered` | `payment_failed` | `out_of_stock` | `delivery_failed`
- `ProductType`: `topup` | `key` | `subscription` | `giftcard`
- `ProviderId`: `A` | `B`
- `PaymentStatus`: `paid` | `failed`
- `FulfillmentOutcome`: `ok` | `timeout` | `error` | `out_of_stock`

1.3 Order id helper: generate `ord_` + nanoid/uuid. Optional parse/validate `ord_[A-Za-z0-9_-]+` for buffered webhook apply.

1.4 State machine (pure functions): allowed transitions only:
- Happy: `created → paid → delivering → delivered`
- `created → payment_failed`
- `paid | delivering → out_of_stock`
- `paid | delivering → delivery_failed`
- Terminal: `delivered`, `payment_failed` (reject further payment/fulfillment side effects)
- Recoverable: `out_of_stock`, `delivery_failed` → via retry-delivery only (`→ delivering → delivered` or back to recoverable)
- Stuck `delivering` may be resumed by retry-delivery

1.5 Payment apply policy (pure): first **durable** payment outcome wins. Ignore `failed` after `paid`/`delivered`. Ignore `paid` after `payment_failed`. Duplicate `event_id` is a no-op at this layer (flag `duplicate`).

1.6 Fulfillment policy (pure, no I/O):
- At most one successful `issue` result per order
- Timeout ≠ failure: retry **same** `request_id` on A
- Fallback B only after A retries exhausted or A hard-down; B gets a **new** `request_id`
- Request id scheme: A = `req_{orderId}-A`, B = `req_{orderId}-B` (never mix providers on one request_id)
- Config: timeout ms, A retry count, short backoff (env later; domain accepts numbers)

1.7 Ports (interfaces only): `IssueProvider.issue({ requestId, sku, orderId })` → `{ status: 'ok', requestId, code }` | `{ status: 'error', reason }` | timeout. `InventoryPort`, `OrderPort`, `PaymentEventPort` — implementations in later layers.

1.8 Logging event names as constants: `payment.accepted`, `fulfillment.attempt`, `order.status_changed` (field lists in error-handling rule). Never log full `code` in production notes.

**Produces:** `OrderStatus`, `canTransition()`, `applyPaymentEvent()`, `nextFulfillmentAction()`, provider ports. Later tasks import these; they do not re-define enums.

---

### Layer 2 — Database (`prisma/` + PostgreSQL)

Prisma only. Domain logic stays out of the schema.

2.1 `docker-compose.yml` **Postgres only** for now (service `db`, port 5432). API/web processes are not started by workers. Full compose (db + api) is Layer 7.

2.2 `.env.example`: `DATABASE_URL`, `PORT=3000`, `PROVIDER_TIMEOUT_MS=3000`, `PROVIDER_A_RETRIES=2`, `PROVIDER_A_ERROR_RATE`, `PROVIDER_A_TIMEOUT_RATE`, `PROVIDER_B_ERROR_RATE` (document defaults). No secrets.

2.3 Prisma schema entities (names can map 1:1):
- `Product`: `sku` unique, name, type (`ProductType`), price, currency (`RUB`), image
- `InventoryKey`: `code` unique, `sku` (or null if shared pool — **use shared pool**: sku nullable or a sentinel; keys are not SKU-locked in the TZ pool), `orderId` nullable unique (one code ≤ one order)
- `Order`: `id` (string pk, `ord_…`), sku, amount, currency, status, `code` nullable, timestamps
- `PaymentEvent`: `eventId` unique, `orderId` **string** (not required FK — buffer before order exists), status, payload JSON, `processedAt` nullable
- `ProviderRequest`: `requestId` unique, orderId, provider (`A`|`B`), outcome, `code` snapshot nullable

2.4 Indexes: `Order.status`, `PaymentEvent.orderId`, free keys (`orderId IS NULL` on `InventoryKey`).

2.5 Constraints: unique `eventId`, unique `requestId`, unique `InventoryKey.code`, unique bound `InventoryKey.orderId` (partial unique where not null).

2.6 Initial migration.

2.7 `prisma/seed.ts`:
- 12 products from PRD catalog (STEAM-TOPUP-500 … GIFT-ROBLOX-800; prices/images as in `prds/tz_main.md`)
- 50 keys **verbatim** from `prds/Тестовое задание Бэкенд разработчик.md` (starts `LFXC-TNCS-BPCD`, ends `7EQM-K09J-XKUO`)
- Helper or documented SQL/script to **restock** extra keys for T10 / F12 (README will point here)

2.8 PrismaService Nest module (thin). No business rules in Prisma middleware.

**Produces:** migrated DB + seed. Integration tests in Layer 5 use Testcontainers **or** this Postgres via `DATABASE_URL` — never SQLite.

---

### Layer 3 — API (NestJS REST, prefix `/api`)

Thin controllers. DTOs + `class-validator`. Global `ValidationPipe({ whitelist: true, transform: true })`. Global exception filter per `.cursor/rules/error-handling.mdc`. Errors: 400 validation / unknown sku missing fields; 404 order or sku; 409 illegal status transition. Webhook duplicates → **200**, never 5xx for business dup.

3.1 `main.ts`: listen `:3000`, CORS origin of static web (`http://localhost:8080`), filter + pipe. `x-trace-id` on error body.

3.2 Modules: `CatalogModule`, `OrdersModule`, `PaymentsModule`, `FulfillmentModule` (port only until Layer 4), `CommonModule`.

3.3 `GET /api/products` — sku, name, type, price, currency, image, available key count if cheap (count unbound `InventoryKey`).

3.4 `POST /api/orders` body `{ sku, id? }`:
- Unknown sku → 404
- Price/currency **from Product**, not client
- Status `created`
- If `id` omitted → server generates `ord_…`
- If `id` provided → validate format, 409 if exists (**T5 only**; UI never sends id)
- After insert, **same transaction**: load buffered `PaymentEvent`s for that `orderId` and apply (Layer 1 policy)

3.5 `GET /api/orders/:id` — 404 if missing. Return `code` only when `delivered`, else `null`.

3.6 Payment handler **single function** `handlePaymentWebhook(dto)` used by both routes:
- Persist `event_id` with unique constraint **before** (or in same tx as) first apply
- Duplicate `event_id` → 200, log `payment.accepted` with `duplicate: true`, no side effects
- Unknown order_id → persist PaymentEvent (buffer), 200, no fulfillment
- `paid` on `created` → `paid` then start fulfillment (Layer 4)
- `failed` on `created` → `payment_failed`
- Terminal orders: no-op 200
- Amount in payload is informational; do not trust client amount to change order

3.7 `POST /api/webhooks/payment` — contract:
```
{ event_id, order_id, status: paid|failed, amount?, currency?, created_at? }
```
No signature check.

3.8 `POST /api/orders/:id/simulate-payment` `{ status: paid|failed }` — generate `event_id`, set `order_id` from path, call **the same** `handlePaymentWebhook`. 404 if order missing (simulate is UI/scripts against an existing order; T5 uses the raw webhook to buffer).

3.9 `POST /api/orders/:id/retry-delivery` — allowed from `out_of_stock` | `delivery_failed` | stuck `delivering`. Idempotent: if already `delivered`, return same `code`. One code per order after restock.

3.10 Structured logs: `payment.accepted` (`eventId`, `orderId`, `status`, `duplicate`); `order.status_changed` (`orderId`, `from`, `to`).

**Produces:** all six MVP endpoints. Fulfillment calls a port; real A/B in Layer 4.

---

### Layer 4 — Fulfillment stubs (A/B + 50-key pool)

In-process adapters simulating HTTP `POST /issue` (no extra listen). Document in README.

4.1 Shared inventory allocate: pick unbound key (`SELECT … FOR UPDATE SKIP LOCKED` or equivalent in Prisma `$transaction`). Bind `orderId`. Unique `code`. If none → `out_of_stock`.

4.2 `ProviderRequest` row created **before** calling adapter, with stable `requestId`. On retry, reuse row; return stored `code` if already `ok`.

4.3 Adapter A (primary): configurable error rate (5xx-like `error`) and timeout rate (delay > `PROVIDER_TIMEOUT_MS` or hang). On success, allocate from shared pool **keyed by request_id** so retry returns the **same** code (even if the HTTP-like call timed out after allocate — persist allocate before returning so timeout path still has a code on retry).

4.4 Adapter B (fallback): same contract, own `request_id`, own error rate. Same shared `InventoryKey` pool.

4.5 Orchestrator in `fulfillment/` (domain policy + ports):
- Move `paid → delivering`
- Call A with `req_{orderId}-A`, retries with backoff, same request_id
- If A `ok` → bind code, `delivered`
- If A `out_of_stock` → `out_of_stock` (do not call B for empty pool — pool is shared)
- If A exhausted timeout/5xx → B with `req_{orderId}-B`
- If B `ok` → `delivered` (still one code; if A later “completes” a timed-out issue, unique `InventoryKey.orderId` / “order already has code” wins — do not attach a second code)
- If both fail → `delivery_failed`
- Log `fulfillment.attempt` (`orderId`, `requestId`, `provider`, `outcome`) — no full code

4.6 Parallel `paid` webhooks: take a row lock / `UPDATE … WHERE status = 'created'` so one winner starts issue; others see in-progress or terminal.

4.7 Env-driven failure injection for scripts (T6/T7): e.g. force A timeout-then-success-on-retry; force A always-down.

**Produces:** F4, F5, F7, F12 behavior behind existing endpoints.

---

### Layer 5 — Tests (T1–T10) and race scripts (`scripts/`)

Jest + Nest testing module. **PostgreSQL only** (Testcontainers preferred; dedicated test DB allowed). No in-memory SQLite. Do not listen a second Nest on `:3000` — Testcontainers boots its own API in-process or a random port.

5.1 Test harness: Prisma migrate + seed (or truncated seed) per suite.

5.2 T1 — `POST /orders` → `created`, amount from server.

5.3 T2 — webhook `paid` → `delivered`, one `code`.

5.4 T3 — 50 parallel `paid` (different `event_id`, same `order_id`) → one delivery, one key consumed.

5.5 T4 — duplicate `event_id` → 200, state unchanged.

5.6 T5 — webhook **before** `POST /orders`: buffer then create with matching `id` → apply once, no duplicate issue.

5.7 T6 — A timeout after it issued; retry same `request_id` → same code, no second key.

5.8 T7 — A unavailable/5xx → B → one delivery.

5.9 T8 — empty pool → `out_of_stock`, process stays up.

5.10 T9 — `failed` → `payment_failed`, no code.

5.11 T10 — restock → `retry-delivery` → one key; second retry-delivery → same code.

5.12 Scripts (same webhook contract as UI simulate-payment):
- `scripts/race-webhooks.ts` — 50× paid
- `scripts/dup-event.ts`
- `scripts/webhook-before-order.ts`
- `scripts/timeout-same-request-id.ts`
- `scripts/fallback-a-to-b.ts`
- `scripts/empty-pool-retry.ts`
- npm scripts in README: one command for T1–T10; documented commands for race + fallback

5.13 Double-click buy: client disable is Layer 6; server: two `POST /orders` = two orders; two simulate-payment on **one** `order_id` = T3/T4.

---

### Layer 6 — Storefront from named Figma nodes (`apps/web/`)

Vanilla HTML / CSS / JS only. **No** React, Next, Vue, Angular, Svelte, Tailwind, Axios-in-framework.

**fileKey:** `G7WwIhdchy0cbkdTbfIR1d`  
**Main frame:** Home V3 closed catalog `1:4` (MVP top ≈ y=1000, artboard 1920, content column 1280).  
**Open catalog:** `1:864`.

**Mandatory implementer workflow (every UI task):**
1. Load skill `figma-design-to-code`.
2. Call MCP `get_design_context` per node below (`fileKey=G7WwIhdchy0cbkdTbfIR1d`, nodeId with colon e.g. `1:598`; `clientLanguages`: html,css,javascript; `clientFrameworks`: none).
3. Treat output as **reference** (React+Tailwind) → rewrite to vanilla.
4. Download assets (`download_assets` or curl of MCP URLs) into `apps/web/assets/`. Do not hand-draw replacement icons.
5. Optional composition check: `get_screenshot` on `1:4` (top) and `1:864`.

**Nodes to implement (in this order):**

6.1 Tokens + layout shell: Montserrat (Bold/SemiBold/ExtraBold), page chrome (dark sides, light 1280 column), tokens from PRD (`#fff`, `#f2f4f7`, CTA `#000`, prices `#4c9a2a` / `#9ca3af`, Steam outline `#1482b3`, etc.). Cut page at ~y=1000.

6.2 Header `1:598` + catalog button `1:610` (logo from `1:4` if missing in header). Search and profile: visual only.

6.3 Banner carousel `1:641` (arrows `1:659`/`1:664`, 6 dots `1:645`): auto and/or arrows, click dots, active dot synced.

6.4 Service card `1:494` + icons list `1:495` (11 cells; download icons). Hover lift/outline. Click icon does **not** need to switch Steam block.

6.5 Steam block `1:547`: currency `$ / ₸ / ₽` active state only — **no recalc**, do **not** fix ₽ vs $ mismatch. Steam login field visual. Promo button **visual only** (`1:557` logic is B3). «Оплатить» in this block does **not** have to create an order.

6.6 Popular products `1:145` + card `1:223`: 5 cards, hover shadow/`translateY`. Titles/prices from **seed catalog** (not Figma “DOOM 2016” stub). **Buy** → `POST /api/orders` `{ sku }`, disable button after click (double-click), then go to order status page.

6.7 Catalog dropdown `1:864` + `1:1193`: open on catalog button, close on second click or outside. Sidebar + columns may be simplified; open/close is required.

6.8 `order.html` (or hash route) — F9: design **not** from Figma. Show status, sku, amount, `code` if delivered, messages for `out_of_stock` / `payment_failed` / `delivery_failed`. Buttons: simulate success / fail → `POST /api/orders/:id/simulate-payment`. Optional retry-delivery control for recoverable states.

6.9 `app.js` (or split): `API_BASE=http://localhost:3000/api`, `fetch` only. CORS already on API.

**Do not implement:** `1:753`, `1:59` reviews; `1:6` footer; promo **logic**; mobile/dark themes; pixel-perfect; admin UI.

**Five interactives (AC-UI):** (1) carousel (2) catalog menu (3) currency switcher no recalc (4) icon hover (5) card hover. Buy on card → POST /api/orders.

---

### Layer 7 — Infra (shared runtime wiring)

7.1 `docker-compose.yml`: service `db` (Postgres) + optional `api` (Nest on 3000). Web is **not** required in compose — static server on 8080 is orchestrator-started.

7.2 Compose/API env: `DATABASE_URL`, CORS `http://localhost:8080`, provider rates.

7.3 Prisma migrate + seed documented as the boot path.

7.4 Ports (fixed for Phase 6): API `http://localhost:3000` (`/api` prefix), web `http://localhost:8080`.

7.5 Workers **must not** start compose/Nest/serve. If a worker needs HTTP, use `runtime.apiUrl` / `runtime.webUrl` from `.execution/2026-08-31-11-33/context.json` (orchestrator fills these). Jest+Testcontainers is OK (ephemeral DB, no second `:3000`).

---

### Layer 8 — README

8.1 How to run: compose db, migrate, seed, API :3000, static web :8080.

8.2 How to run T1–T10 (one npm test command).

8.3 How to reproduce races (50 webhooks) and A timeout / A→B fallback — **same webhook contract** as simulate-payment.

8.4 Key decisions (short): exactly-once (unique event_id + row lock + unique key bind); timeout ≠ failure (same request_id on A); fallback new request_id on B; webhook-before-order buffer; how you’d scale (indexes, later queue — not built).

8.5 **Explicit:** «промокоды не реализованы».

8.6 Restock keys for F12/T10.

8.7 Stub providers are in-process; no real acquiring.

8.8 Hours spent placeholder line (deliverable).

8.9 Do not log full codes in prod (demo GET order only when delivered).

---

## 2. Key architectural decisions

1. **Order ids:** server-generated `ord_…` for the UI. `POST /api/orders` may accept optional `id` so T5 can create the order that matches a buffered webhook. UI never sends `id`.

2. **Webhook before order:** persist `PaymentEvent` by unique `event_id` with `orderId` as a **string** (no required FK). HTTP 200. Apply in the same transaction as order insert when ids match. Do not issue a code without an order.

3. **First durable payment outcome wins:** ignore `failed` after `paid`/`delivered`; ignore `paid` after `payment_failed`. Document in README.

4. **simulate-payment ≡ webhook:** one `handlePaymentWebhook`. Simulate generates `event_id` and reuses the path order id. Race scripts use the webhook URL (or simulate) — same handler.

5. **No message broker / queue in MVP.** Synchronous fulfillment inside the payment transaction/request (short retries). Background sweeper is B1 — not built.

6. **Providers A/B are in-process adapters** honoring the `issue` JSON contract. Shared `InventoryKey` table (50 seeded codes). Unique `code`; bind to at most one `orderId`.

7. **request_id:** A keeps `req_{orderId}-A` across retries. B uses **new** `req_{orderId}-B`. Never share request_id across providers.

8. **Timeout ≠ failure:** on timeout, retry A with the same request_id (adapter must return the same code). Do not treat timeout as `delivery_failed` until retries are exhausted. If A issued during a timeout, the retry retrieves that code; unique bind prevents a second key even if B was also attempted (prefer: do not start B until A is exhausted).

9. **Empty pool:** `out_of_stock` (recoverable). `retry-delivery` after restock; idempotent; still one code per order. Stuck `delivering` is also retryable.

10. **Parallel paid webhooks:** unique `event_id` + conditional status update / row lock so one winner runs issue. Duplicates of the same `event_id` are 200 no-ops.

11. **Domain vs Prisma:** state machine, retry/fallback, and “one code per order” live in `domain/`. Prisma is persistence only.

12. **Errors:** global exception filter; webhook 200 on duplicates and on successful buffer; 400/404/409 as specified; business `out_of_stock` is order status, not webhook 4xx.

13. **Frontend:** vanilla `apps/web`; Figma `G7WwIhdchy0cbkdTbfIR1d`; get_design_context per listed node; assets downloaded to `apps/web/assets/`. Promocode button is visual only.

14. **Tests:** Jest + real PostgreSQL (Testcontainers or test DB). Playwright is **not** an app dependency; it is Phase 6 orchestrator visual QA only.

15. **Shared runtime:** one Compose Postgres, one Nest `:3000`, one static `:8080`. Workers do not boot servers.

---

## 3. Integration points

| Point | Contract |
|--------|----------|
| **Webhook = simulate-payment** | Both call `handlePaymentWebhook`. Webhook body includes `event_id` + `order_id`. Simulate: server-made `event_id`, `order_id` from URL. Scripts must use this same path (not a second payment stub). |
| **issue (A/B)** | `{ request_id, sku, order_id }` → 200 `{ status: "ok", request_id, code }` or error `{ status: "error", reason: "out_of_stock" \| … }` or no response until timeout. In-process; persist by `request_id`. |
| **UI → API** | Storefront `fetch` to `http://localhost:3000/api`. Buy → `POST /orders`. Status page GET order + `POST …/simulate-payment`. CORS from `:8080`. |
| **Seed** | 12 SKUs + 50 keys from backend TZ. Cards on the storefront use seed names/prices/images (`assets/*.png` from Figma or listed stubs). Restock path for T10 documented. |
| **Tests ↔ API** | T1–T10 hit the same endpoints. T3/T11 scripts = 50 parallel webhooks. T5 uses webhook-then-create with optional order `id`. T6/T7 toggle provider env/flags. Isolated Testcontainers DB; race scripts against shared runtime `apiUrl` when orchestrator has started it. |
| **retry-delivery ↔ inventory** | Same allocate/bind path as first fulfillment; no second code if `delivered`. |
| **Logs** | `payment.accepted`, `fulfillment.attempt`, `order.status_changed` — for debugging races without dumping codes. |

---

## 4. Shared runtime + Phase 6 visual QA

**One stack for the whole run (orchestrator-owned):**

| Service | URL | Who starts |
|---------|-----|------------|
| PostgreSQL | compose `db` | Orchestrator, once |
| Nest API | `http://localhost:3000` (`/api`) | Orchestrator, once, after migrate+seed |
| Static web | `http://localhost:8080` | Orchestrator, once (`npx serve apps/web -p 8080` or equivalent) |

Workers: **do not** run `docker compose up/down`, `npm run start`, Vite, live-server, or kill foreign processes. If `context.json` `runtime.status` is `running`, use `runtime.apiUrl` / `runtime.webUrl`. If dead, return `{ "needsRestart": true }` and stop.

Jest + Testcontainers: allowed (own DB, in-process Nest). Must **not** bind a second listener on 3000.

**Phase 6 visual QA (not per-task):** Playwright MCP against `runtime.webUrl` (not a worker-spawned server). Compare to Figma screenshots of `1:4` (top) and `1:864`. Exercise: carousel, catalog open/close, currency, icon hover, card hover, Buy → simulate pay → status. Save shots under `.execution/2026-08-31-11-33/screenshots/`. Max 3 fix rounds. Do **not** add Playwright to Nest or `apps/web` `package.json`.

---

## 5. What NOT to build

**Bonuses (follow-up PRDs only):**

- **B1** — Reconciliation, “paid but not delivered” sweeper, monetary ledger that always balances, background catch-up jobs.
- **B2** — Admin UI list of stuck orders / login token. (`retry-delivery` **API** is MVP F12; UI admin is not.)
- **B3** — Promocode apply, `max_uses` under concurrency, server-side discount. README: **«промокоды не реализованы»**. Button `1:557` is visual only.
- **B4** — Thousands of SKUs, hot stock query, EXPLAIN plan.

**Non-goals from PRD:**

- Real acquiring, real suppliers, webhook signatures.
- Auth (except nothing for MVP).
- Reviews (`1:753`, `1:59`), footer (`1:6`), mobile/dark, pixel-perfect.
- Steam login validation; currency conversion; fixing ₽ vs $ copy.
- Redis/Bull/queues; file storage instead of Postgres.
- React/Next/Vue/Angular/Svelte/Tailwind on the storefront.
- Playwright (or any UI test runner) as an application dependency.
- Client-trusted amount on orders.
- Merging two `POST /orders` (double Buy) into one order — those are two purchases; exactly-once is per `order_id` / `event_id`.

---

## File map (for Phase 4 decomposition)

```
apps/api/src/domain/           # Layer 1
apps/api/src/catalog/          # Layer 3 F1
apps/api/src/orders/           # Layer 3 F2, F12 endpoint
apps/api/src/payments/         # Layer 3 F3 (shared handler)
apps/api/src/fulfillment/      # Layer 4
apps/api/src/common/           # filter, logger, pipes
apps/web/                      # Layer 6 index.html, css, js, order page
apps/web/assets/               # Figma downloads
prisma/schema.prisma           # Layer 2
prisma/seed.ts                 # Layer 2
scripts/                       # Layer 5 F11
docker-compose.yml             # Layer 2 (db) + Layer 7 (db+api)
README.md                      # Layer 8
```

**MVP feature coverage:** F1 catalog, F2 orders, F3 webhook+simulate, F4 stubs+pool, F5 exactly-once, F6 lifecycle, F7 timeout/retry/fallback, F8 storefront, F9 status page, F10 logs, F11 scripts, F12 retry-delivery. Tests T1–T10.
