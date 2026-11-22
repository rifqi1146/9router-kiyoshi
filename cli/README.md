<div align="center">
  <img src="./images/9router-kiyoshi.png" alt="9Router Kiyoshi" width="100%" style="max-width:100%;height:auto"/>

  # 9Router-Kiyoshi

  AI routing gateway and local proxy for coding agents (Cline, OpenCode, Codex, Claude Code), based on [9Router Plinian](https://github.com/Azhar457/9router) (by Azhar457) and [9Router](https://github.com/decolua/9router) (by decolua). Includes Antigravity anti-ban protection with native agy CLI 1.5.11 parity, Live Provider Pulse telemetry, and an AMOLED dashboard.

  [![Version](https://img.shields.io/badge/version-v0.6.900--kiyoshi-blue.svg)](./CHANGELOG.md)
  [![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
  [Install](#installation) • [Features](#features-in-kiyoshi-edition) • [Antigravity Anti-Ban](#antigravity-anti-ban-protection) • [Pulse Telemetry](#live-provider-pulse-telemetry) • [Acknowledgments](#acknowledgments)

</div>

---

## Lineage and Project History

9Router-Kiyoshi is an independently maintained edition built on three projects:
1. **[9Router Plinian](https://github.com/Azhar457/9router)** (`Azhar457/9router`, v0.6.900): introduced the Go entry proxy, Red Team Toolkit, external payload registry, custom payload trees, `/v1/models` memoization, and lazy executor loading.
2. **[9Router](https://github.com/decolua/9router)** (`decolua/9router`): the original project providing the multi-provider routing engine, translator core, combo fallback, and Next.js dashboard.
3. **[OmniRoute](https://github.com/cheaper-inference/OmniRoute)** (`cheaper-inference/OmniRoute`): source of the multi-layer Antigravity header scrubbing, 429 guard, family-level cooldown, and pacing patches.

### Problems Addressed in This Fork
Coding agents (Cline, OpenCode, Codex) frequently send prompts ranging from 100k to 380k tokens per turn. Under these workloads, standard gateways encounter several concrete edge cases:
- **Premature socket closes**: Strict clients like OpenCode and `@ai-sdk` close TCP sockets immediately upon receiving `data: [DONE]`. Standard W3C streams trigger `cancel()` instead of `flush()`, which leaves streams unfinalized and yields empty console summaries with 0-token recorded usage.
- **Upstream bans and prompt cache misses**: Random project ID generation and leaking Chromium or Stainless headers trigger Google Cloud abuse heuristics and invalidate upstream prompt cache keys.
- **Silent non-streaming failures**: Upstream Gemini endpoints emit SSE payloads that fail non-streaming JSON parsers, returning empty strings or 502 Bad Gateway responses.
- **Lack of latency percentiles**: Standard dashboards omit TTFT p50 and p95 distributions, error code breakdowns, and per-account health tracking.

9Router-Kiyoshi handles these edge cases while maintaining standard OpenAI (`/v1/*`) and Anthropic format compatibility.

---

## Features in Kiyoshi Edition

| Feature / Mod | What it does | Origin |
| --- | --- | --- |
| **Live Provider Pulse (`/dashboard/pulse`)** | Real-time telemetry: sample window (50, 100, 200, 500), TTFT p50/p95, total roundtrip duration, cache-hit percentage, HTTP status distribution (`200`, `400`, `401`, `5xx`), and recent error decoder with browser-local timestamps (WIB). | **Kiyoshi** |
| **9-Layer Antigravity Armor** | Anti-ban protection for Antigravity and Google Cloud: Layers 1 to 5 ported from OmniRoute (header scrubbing, 429 refusal guard, 429 engine, family lockout, jittered pacing); Layers 6 to 9 built by Kiyoshi (authentic `aicode-consumers` project ID, 5m quota polling, `agy` 1.5.11 binary parity, 120s first-token watchdog). | **OmniRoute** (L1-L5) + **Kiyoshi** (L6-L9) |
| **Official `agy` 1.5.11 Parity** | Full protocol parity with official `/root/.local/bin/agy` (v1.5.11, `cl=1024248524`): PKCE S256 with 43-character verifier, pinned redirect `https://antigravity.google/oauth-callback`, `auth/aicode` scope, `request.labels` telemetry generation, stripped `x-request-source` headers, and `Accept-Encoding: gzip` lifecycle requests. | **Kiyoshi** |
| **First-Token Watchdog** | Caps the silent wait for the first usable chunk at 120 s measured from request start. Counts `content`, `reasoning_content`, `tool_calls`, and `finish_reason` as progress, ignores role-only and empty-content frames, and replays every buffered byte. On timeout the turn rotates to the next account or model instead of pinning the client. | **Kiyoshi** |
| **Kiyoshi Motion System & Mobile Layout** | Unified `motion/react` spring physics (`PageTransition`, `StaggerGrid`, `AnimatedNumber`, `ScrollReveal`, `useAutoAnimate` lists), `createPortal` modal/drawer rendering without CSS `filter` containing-block traps, responsive mobile header/drawer with 44px touch targets, sticky table columns, and mobile-optimized topology edges. | **Kiyoshi** |
| **Dashboard Performance & Font Subsetting** | Subset Material Symbols Outlined font to 249 used icons / 330 ligatures (`31.1 KiB` vs `3.87 MiB`) with `FILL` axis, coalesced `?summary=1` endpoints for `/api/settings` and `/api/providers`, ref-based `AnimatedNumber` updates, `en` i18n DOM-walk bypass, lazy-loaded charts/modals, and parallel async `/api/overview/specs`. | **Kiyoshi** |
| **Stream Passthrough Sentinel Finalize** | Detects `data: [DONE]` directly inside the passthrough transform loop and invokes `finalizeStream()` immediately, guaranteeing usage accounting and console logs even when strict clients abort on EOF. | **Kiyoshi** |
| **Native Antigravity SSE-to-JSON & Gzip Bypass** | `parseSSEToOpenAIResponse()` decodes native Gemini `{response:{candidates:[...]}}` SSE frames for non-streaming requests, and `createBypassResponse()` transparently decompresses `gzip`/`deflate`/`br` responses on MITM-bypassed hosts (fixing 502 errors on `/v1/images/generations` with `ag/gemini-3.1-flash-image`). | **Kiyoshi** |
| **Upstream-Accurate 429 Cooldown** | Reads the real reset from the Cloud Code error body (`quotaResetTimeStamp`, `RetryInfo.retryDelay`, `"reset after XhYmZs"`) instead of guessing. A per-model image quota that Google says resets in 4h is locked for 4h, not 4 seconds (which retried a dead model thousands of times) and not 24h (the plan-level default). | **Kiyoshi** |
| **Server Overview Dashboard (`/dashboard/overview`)** | Sidebar system monitor showing CPU, RAM, disk, load averages, thermals, listening ports, network interfaces, Tailscale/Cloudflare status, and uptime. | **Kiyoshi** |
| **Access Keys Injection Switch and Quotas** | Master ON/OFF toggle per API key to selectively bypass system prompt steering and jailbreaks, plus daily/lifetime token quotas and key expiry. | **Kiyoshi** |
| **AMOLED Black, Charcoal, and Paper Themes** | AMOLED black (`#000000`), Charcoal, and Paper palettes. Badges and chips use solid design tokens (Forest Green `brand`, Warm Brass `brass`, Terracotta `clay`) without translucent overlays or glowing orb decorations. | **Kiyoshi** |
| **Process-Isolated CLI Lifecycle** | `killAllAppProcesses()` inspects `/proc/$pid/cwd` before terminating `next-server` instances, preventing 9router cleanups from killing unrelated Next.js applications on the same host. | **Kiyoshi** |
| **CodeBuddy and WorkBuddy Identity** | Passes through user and developer prompts without Tencent static identity overrides, adds UUIDv7 conversation header family, and provides fallback prompts for headless requests. | **Kiyoshi** |
| **Red Team Toolkit** | Global Injection, external jailbreak payload registry, transparency console, and custom payload repo-scan tree. | **Plinian** |
| **Go Entry Proxy** | Public port handled by a Go reverse proxy (client-IP stamping, TTFB logging, RTK sidecar). | **Plinian** |
| **Memoized `/v1/models` & Lazy Executors** | Fingerprinted `/v1/models` cache (888 ms to 13 ms median) publishing `thinking_levels`, plus on-demand async executor loading (`getExecutor`) reducing idle RSS. | **Plinian** |
| **DPI-Resilient Transport & Socket Recovery** | Configurable `X25519` ECDH curve, RFC 8305 happy-eyeballs, stale keep-alive fresh-socket replay, and `undici` 7.30.2 externalized in Next.js standalone builds. | **Plinian** |
| **Expanded Provider & Model Catalog** | Added `syn` (`api.synthetic.new`), `sensenova-intl` (`token.sensenova.ai`), Claude Fable 5.2 / Haiku 5.5, Gemini 4 Carbon, GPT Image 2.6, and updated NVIDIA NIM catalog. | **Plinian** |
---

## Antigravity Anti-Ban Protection

This 9-layer defense system combines core anti-ban primitives ported from [OmniRoute](https://github.com/cheaper-inference/OmniRoute) (Layers 1 to 5) with native protocol parity, project preservation, and stall protection engineered in **9Router-Kiyoshi** (Layers 6 to 9):

### Ported from OmniRoute (Layers 1 to 5)
1. **Layer 1: Header Scrubbing** *(OmniRoute)*: Strips 24 leaking proxy and Chromium headers (`x-forwarded-for`, `sec-ch-ua`, `sec-ch-ua-platform`, `sec-fetch-*`, Stainless SDK signatures) before sending to upstream Google endpoints. Outbound requests serialize `Authorization` last to match the Go binary header order *(Kiyoshi refinement)*.
2. **Layer 2: 429 Refusal Guard** *(OmniRoute)*: Caches prompts that trigger refusal 429s locally for 2 to 30 minutes, preventing agent hammer-loops from degrading account reputation.
3. **Layer 3: 429 Engine and Cooldown** *(OmniRoute)*: Differentiates temporary rate limits from 24-hour quota exhaustions, triggering automated 24-hour cooldowns to prevent repeated retries against exhausted accounts.
4. **Layer 4: Family-Level Lockout** *(OmniRoute)*: Isolates quota locks per model family (`gemini`, `claude`, `argon`). A Gemini quota exhaustion does not lock Claude models on the same account.
5. **Layer 5: Jittered Account Pacing** *(OmniRoute)*: Enforces a 1200ms ±30% jitter pacing per account to eliminate parallel request bursts.

### Engineered by Kiyoshi (Layers 6 to 9)
6. **Layer 6: Authentic Project ID Preservation** *(Kiyoshi)*: Preserves the authentic `aicode-consumers` project ID returned by `loadCodeAssist` and removes all random project ID generators. Eliminates random project generation that fragmented Google prompt caching and triggered bot detection.
7. **Layer 7: Quota Polling Throttling** *(Kiyoshi)*: Reduces background quota polling from 30 seconds to 5 minutes per account, cutting automated polling traffic by 10x.
8. **Layer 8: Official CLI (`agy` 1.5.11) Parity** *(Kiyoshi)*: Matches the native Google Go binary (`/root/.local/bin/agy`):
   - User-Agent matches `antigravity/cli/1.5.11 (aidev_client; os_type=linux; arch=amd64; cl=1024248524; auth_method=consumer)`.
   - OAuth flow uses PKCE S256 with a 43-character verifier, pinned redirect `https://antigravity.google/oauth-callback`, and `auth/aicode` scope. The authorization code (`4/0A...`) is pasted into the UI with the verifier bound server-side to the single-use `state`.
   - Outbound chat requests inject `request.labels` telemetry containing `cascade_id`, `trajectory_id`, `root_cascade_id`, `last_step_index`, and `model_enum` (`MODEL_PLACEHOLDER_M318` / `M400`).
   - Preflight lifecycle requests (`loadCodeAssist`, `fetchAdminControls`, `fetchUserInfo`, `listExperiments`, `writeTrajectoryAcls`) enforce `Accept-Encoding: gzip` to avoid Node.js Brotli (`br`) signature leaks.
   - Removes non-standard `x-request-source: local` headers from OAuth token exchange and account setup.
   - Relocates large caller system prompts out of `systemInstruction` into the first user turn (#9030) to prevent detail-free `429 RESOURCE_EXHAUSTED` errors.
9. **Layer 9: First-Token Watchdog** *(Kiyoshi)*: Protects client turns from silent upstream stalls (up to 120s from request start). Treats `content`, `reasoning_content` (thinking tokens), and `tool_calls` as valid progress, ignores role-only frames, and rotates to the next account or model if the deadline expires.
---

## Live Provider Pulse Telemetry

Accessible directly from the sidebar navigation at `/dashboard/pulse`:

- **Sample Window**: Toggle between the last 50, 100, 200, or 500 requests on the fly.
- **Overall Health**: Classified based on global success rate:
  - Healthy: 90% or higher success rate.
  - Degraded: 70% to 89% success rate.
  - Down: below 70% success rate.
  *(Latency is prominently reported but does not downgrade a provider, since large-context agent loops of 100k to 380k tokens require 4 to 8s TTFT).*
- **Multi-Dimensional Breakdowns**:
  - **Per Provider**: Request counts, success rate, TTFT p50/p95, total duration p50, cache hit percentage, input/output tokens, and localized last seen time.
  - **Per Model**: Track performance across individual models (such as `gemini-3.8-flash-high` vs `claude-sonnet-4-6`).
  - **Per Account / Key**: Uses SQLite `LEFT JOIN providerConnections` to map internal connection IDs to actual account names and emails (such as `mynameaws99@gmail.com`).
- **HTTP Status Distribution**: Response code breakdown (`200 OK`, `400 Bad Request`, `401 Unauthorized`, `500 Upstream Error`, `unknown`).
- **Recent Failures Decoder**: Displays recent upstream errors with HTTP status codes and truncated error previews.
- **Latency Sparkline Chart**: Area chart visualizing median (p50) versus tail (p95) TTFT using theme tokens.

---

## Installation

### Prerequisites
- **Node.js**:
  - **Minimum Engine**: Node.js `>= 20.18.1`.
  - **Runtime**: Node.js 22.5 or higher (Node 24 recommended) to activate the native C++ `node:sqlite` driver.
  - **Build**: Node.js 20 recommended for compiling Next.js 16 without SWC bus errors.
- **Git**

### Step 1: Clone Repository
```bash
git clone https://github.com/rifqi1146/9router-kiyoshi.git
cd 9router-kiyoshi
```

### Step 2: Environment Configuration
```bash
cp .env.example .env
```
*(Optional: configure port, hostname, or override `INITIAL_PASSWORD` (default: `123456`) and `JWT_SECRET` in `.env`)*

### Step 3: Install Dependencies and Build
```bash
# Install dependencies
npm install

# Build Next.js dashboard
npm run build

# Build CLI package
npm run cli:pack
```

### Step 4: Start the Server

**Option A: Run via npm (Recommended for Servers / VPS)**
```bash
PORT=20128 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run start
```

**Option B: Install as Global CLI Launcher**
```bash
cd cli
npm install -g .

# Launch background daemon
9router-kiyoshi -p 20128 --host 0.0.0.0 --skip-update --no-browser
```

Common CLI flags:
```bash
9router-kiyoshi --port 20128     # port (default: 20128)
9router-kiyoshi --host 0.0.0.0   # bind address
9router-kiyoshi --no-browser     # disable opening browser automatically
9router-kiyoshi --skip-update    # bypass startup version check
```

**Option C: Configure Remote CLI Tools (`npx 9router connect`)**
```bash
# Configure Claude Code tiers against a running gateway
npx 9router connect http://<server-host>:20128 --tools claude \
  --fable cc/claude-fable-5-2 --opus cc/claude-opus-5-5 \
  --sonnet cc/claude-sonnet-5-5 --haiku cc/claude-haiku-4-5-20251001

# Configure non-Claude tools
npx 9router connect http://<server-host>:20128 --tools codex,opencode,kilo --model ocg/deepseek-flash
```

The dashboard will be accessible at:
`http://localhost:20128/dashboard` (Default login password: `123456`)

---

## Request Lifecycle and Architecture

```
Cline / OpenCode / Codex / Claude Code
        │  POST http://localhost:20128/v1/chat/completions
        ↓
┌────────────────────────────────────────────────────────┐
│ 9Router-Kiyoshi (Go Reverse Proxy + Next.js Server)    │
│  • Custom Server: socket IP extraction & cf-ip trust   │
│  • RTK Pre-Translate Token Saver (cursor tool_results) │
│  • Translator Engine (OpenAI ↔ Claude ↔ Gemini ↔ ...)  │
│  • 9-Layer Antigravity Armor & agy CLI OAuth Parity    │
│  • Combo Fallback & Round-Robin Load Balancer          │
│  • Stream Passthrough Sentinel Finalizer               │
│  • RequestDetails & Live Telemetry Storage (SQLite)    │
└───────┬────────────────────────────────────────────────┘
        │
        ├─► Antigravity (Google Cloud / Gemini 3.8)
        ├─► CodeBuddy (DeepSeek v4.1 / Qwen 3.5)
        ├─► Kiro / Claude 4.5 Sonnet
        └─► OpenCode Free / Vertex AI / Custom Endpoints
```

Full architecture specifications: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and [`agent.md`](./agent.md).

---

## Data and Persistence

State is persisted to SQLite (`src/lib/db/`) with a fallback adapter chain (`driver.js`):
`bun:sqlite` → `better-sqlite3` → `node:sqlite` (Node 22.5+, default) → `sql.js` (pure JS fallback).
During Next.js build phases (`NEXT_PHASE`), `driver.js` and `initOutboundProxy.js` isolate builds to an in-memory `sql.js` instance, and `sqljsAdapter.js` refuses to overwrite a database with an active `-wal` file so builds never corrupt a live `node:sqlite` database.
| Platform | Default Path |
| --- | --- |
| Linux / macOS | `~/.9router/db/data.sqlite` |
| Windows | `%APPDATA%\9router\db\data.sqlite` |
| Custom | Set `DATA_DIR` environment variable |

Security-relevant environment variables (see `.env.example`):
- `JWT_SECRET`: Dashboard session cookie signing secret.
- `INITIAL_PASSWORD`: Initial dashboard login password (default `123456`, override immediately).
- `API_KEY_SECRET`: Encryption key for provider credentials.
- `MACHINE_ID_SALT`: Salt for machine ID fingerprinting.

---

## Documentation

- **Single Source of Truth:** [`agent.md`](./agent.md): complete log of modifications, build procedures, and deployment rules.
- **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md): version history and release notes.
- **Full Architecture:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Engine Rules:** [`open-sse/AGENTS.md`](./open-sse/AGENTS.md)

---

## Acknowledgments

9Router-Kiyoshi stands on the work of:

- **[Azhar457](https://github.com/Azhar457)** and **[9Router Plinian](https://github.com/Azhar457/9router)**: the upstream fork providing the Go entry proxy, Red Team Toolkit, custom payloads scan tree, and provider curation.
- **[OmniRoute](https://github.com/cheaper-inference/OmniRoute)**: creators of Layers 1 to 5 of the Antigravity anti-ban defense system (header scrubbing, 429 refusal guard, 429 engine, family lockout, and jittered pacing).
- **[decolua](https://github.com/decolua)** and all contributors to **[9Router](https://github.com/decolua/9router)**: the foundational AI routing gateway project.
- **[CLIProxyAPI](https://github.com/1rgs/CLIProxyAPI)**: original Go implementation that inspired 9Router.
- **[RTK](https://github.com/rtk-ai/rtk)**, **[Headroom](https://github.com/chopratejas/headroom)**, **[Caveman](https://github.com/JuliusBrussee/caveman)**, and **[Ponytail](https://github.com/DietrichGebert/ponytail)**: token-saving compression utilities.
- Authors of the **AI-Jailbreaks** and **BlackFriday-GPTs-Prompts** research collections.

---

## License

MIT (see [LICENSE](./LICENSE)).
