# YieldAgent x402 — Verifiable Execution Market for Autonomous Agents

YieldAgent x402 is a verifiable execution market for DeFi intents and autonomous agents.

Agents pay for routes with x402, discover execution surfaces through public manifests, compete through solver auctions, execute under managed trust controls, and settle with verifiable receipts across supported chains. The system is built to make agent execution inspectable instead of opaque: payment, routing, bidding, proof, attestation, and settlement all expose public surfaces or machine-readable artifacts.

**Live surfaces**
- App: https://yieldagentx402.app
- API: https://api.yieldagentx402.app
- x402 discovery: https://api.yieldagentx402.app/.well-known/x402
- ERC-8004 / agent registration: https://api.yieldagentx402.app/.well-known/agent-registration.json

---

## What this is

YieldAgent x402 is not just a yield bot or portfolio copilot.

It is market infrastructure for agent execution:
- agents pay for execution and route access with x402 micropayments
- solvers compete to fulfill intents
- managed signer and policy rails constrain execution
- proof and settlement artifacts are exposed for verification
- multichain rails support verification and execution across supported ecosystems

The goal is simple: let autonomous agents act like economic actors without turning execution into a black box.

---

## Quick Links

| Resource | URL |
|----------|-----|
| **Live site** | https://yieldagentx402.app |
| **Gateway health** | https://api.yieldagentx402.app/health |
| **Adapter registry health** | https://api.yieldagentx402.app/api/adapters/health |
| **Platform status (live)** | https://yieldagentx402.app/api/public/platform-status |
| **Stacks x402 worker health** | https://stacks.yieldagentx402.app/health |
| **TEE signer health** | https://tee-signer.yieldagentx402.app/health |
| **x402 discovery** | https://api.yieldagentx402.app/.well-known/x402 |
| **A2A / ERC-8004** | https://api.yieldagentx402.app/.well-known/agent-registration.json |

---

## Health & status JSON (current contracts)

**Do not hardcode adapter counts or “green” wording in docs** — always read live JSON.

| Surface | Field | Values | Meaning |
|--------|--------|--------|---------|
| Gateway `GET /health` | top-level `status` | `operational` \| `degraded` | Platform posture (e.g. kill switches). |
| Gateway `GET /health` | nested `signer.status` | from tee-signer, often `ok` \| `degraded` \| fallback | Mirrors **tee-signer**; `degraded` can mean missing recent KV signing evidence, not necessarily “down”. Prefer `statusBadge` / `liveVerifiedRecently` on tee-signer when debugging. |
| `GET /api/adapters/health` | top-level `status` | `operational` \| `degraded` | Registry list fetch succeeded vs degraded. Per-adapter rows keep their **own** `status` fields. |
| `GET /api/tee/status` | `status` | `operational` \| `degraded` | Derived from tee report success (gateway). |
| Stacks x402 `GET /health` | `status` | `operational` | Worker liveness (aligned with gateway vocabulary). |
| Landing `GET /api/public/platform-status` | `healthEndpointSemantics` | object of strings | Operator-facing map of **which endpoint uses which vocabulary** (`gatewayRootHealth`, `adaptersRegistryHealth`, `teeSignerDirect`, `stacksX402Worker`). |

```bash
curl -sS https://api.yieldagentx402.app/health
curl -sS https://api.yieldagentx402.app/api/adapters/health
curl -sS https://yieldagentx402.app/api/public/platform-status
curl -sS https://stacks.yieldagentx402.app/health
curl -sS https://tee-signer.yieldagentx402.app/health
```

---

## Phala Shade Agent signer (autonomous vs human mode)

YieldAgent separates **who holds signing keys** and **whether a human is in the loop** across three layers: the **gateway**, **tee-signer**, and the **Shade Agent** (NEAR + Chain Signatures) when deployed on **Phala** (Intel TDX CVM via dstack).

### What the Shade Agent does

- The **tee-signer** worker (`tee-signer.yieldagentx402.app`) performs managed signing and policy enforcement.
- When **Phala Shade Agent** integration is enabled (`SHADE_AGENT_ENABLED`), signing for **Chain Signatures** / x402 payment flows can route through a **Phala CVM** over HTTPS (`/api/sign`, `/api/derive-address`). The Shade Agent holds MPC / chain-signature material inside the TEE; **tee-signer does not see private keys** for that path.
- Configuration lives in **`tee-signer/wrangler.jsonc`** (e.g. `SHADE_AGENT_ENABLED`, `SHADE_AGENT_URL`, `CHAIN_SIGNATURES_ENABLED`, `AGENT_CONTRACT_ID`). The live CVM URL is tied to your Phala deployment and may change after redeploy — update `SHADE_AGENT_URL` (var or secret) accordingly.

### Autonomous mode (production TEE)

- Shade Agent runs on **Phala Cloud** in a **TEE** (Intel TDX), with **attestation** and **registration** against the NEAR agent contract (e.g. `ac-sandbox-yieldagent-x402.near`).
- Intended for **unattended** automation: agents or services that must sign **without a human per request** (e.g. autonomous x402 pay / “Casper”-style flows), still bounded by **tee-signer policy** (allowed callers, destinations, caps).
- Verify readiness: `GET https://tee-signer.yieldagentx402.app/health` and, when the Shade Agent is exposed on your custom domain, `GET https://shade-agent.yieldagentx402.app/api/info` (fields such as `agentReady`, `registered`, `agentWhitelisted`, `attestation`).

### Human mode (local / development)

- Shade Agent can run **on a developer machine** (`environment: local` in deployment config): **whitelist**-based, **no production TEE attestation** posture — a **human operator** is expected to be present for development, testing, or manual approval workflows.
- Use this mode for integration testing; use **Autonomous / TEE** for production unattended signing.

### Gateway: personal vs managed wallet routing (related idea)

- **Personal** wallet paths use the user’s own keys (human- or wallet-controlled).
- **Managed** paths route to **tee-signer**, where policy + (when configured) **Phala Shade Agent** signing apply — this is the usual stack for **autonomous** execution under operator policy.

For detailed Phala env, sponsor keys, and redeploy steps, see your canonical deploy tree’s `X402_ACTIVATION/PHALA_SHADE_AGENT_SETUP.md` and `X402_ACTIVATION/SHADE_AGENT_NOTES.md` (or equivalent runbooks).

---

## What is live

The repo and live deployment currently expose:

- x402 payment-gated API gateway
- public x402 discovery
- ERC-8004 / A2A registration surface
- intent creation, bidding, proof, and settlement routes
- solver discovery and registration surfaces
- multichain compatibility workers and adapters
- TEE report / verifier integration surfaces
- DAO governance endpoints
- live NEAR operator infrastructure and validator-backed credibility

Adapter totals and enabled/live counts should always be read from the live health endpoint rather than hardcoded into static copy.

---

## Core thesis

Most “AI finance” demos stop at recommendations, dashboards, or unverifiable automation.

YieldAgent x402 is built around a different model:

1. **pay** — agents unlock routes and services with x402  
2. **discover** — agents and solvers expose machine-readable capabilities  
3. **bid** — solvers compete to fulfill intents  
4. **execute** — managed trust controls and verification paths constrain execution  
5. **settle** — outcomes are written and verified across supported chains  
6. **inspect** — public artifacts expose receipts, reports, status, and registration

This is why the project is framed as a **verifiable execution market** rather than a simple DeFi frontend.

---

## Architecture at a glance

### Public surfaces
- `yieldagentx402.app` — landing page, verification surface, product interface
- `api.yieldagentx402.app` — gateway, intents, solvers, health, reports, DAO, registration
- `agent.yieldagentx402.app` — agent / verifier / brain-related surface

### Gateway core
- x402 discovery and payment verification
- protocol adapters
- intent auction Durable Object
- solver discovery and registration
- settlement and proof routes
- TEE report / verifier integration

### Execution model
- client or agent creates an intent
- gateway enforces x402 where required
- intent auction collects bids
- solver wins based on route / score / policy
- proof and settlement routes complete the lifecycle
- evidence surfaces expose verification artifacts

### Trust model
- x402 binds paid access to execution surfaces
- ERC-8004 / A2A registration exposes agent identity metadata
- managed signing allows constrained execution
- sensitive verification paths are designed for TEE-backed workflows
- settlement verification is exposed per supported rail where available

---

## Supported ecosystems

Representative supported rails and ecosystems include:

- NEAR
- Stacks
- Starknet
- Solana
- Sui
- Tron
- XRP / Flare-style rails
- Rootstock
- Filecoin
- Base and multiple EVM networks
- Bitcoin-related rails including Babylon / BitcoinOS-style integrations
- LayerZero-connected routing surfaces
- Sei and other compatible environments as enabled

Do not rely on fixed adapter counts in README copy. Use `GET /health` for the current live totals.

---

## Why this matters

Autonomous agents need more than wallets and prompts.

They need:
- payment rails
- route discovery
- identity
- trust signals
- execution controls
- settlement proofs
- public receipts

YieldAgent x402 combines these into a single execution fabric so agents can request, pay, route, and verify real actions across chains without collapsing back into centralized custody or unverifiable backend logic.

---

## Live verification checklist

Use the live endpoints directly.

```bash
curl -sS https://api.yieldagentx402.app/health
curl -sS https://api.yieldagentx402.app/api/adapters/health
curl -sS https://yieldagentx402.app/api/public/platform-status
curl -sS https://api.yieldagentx402.app/.well-known/x402
curl -sS https://api.yieldagentx402.app/.well-known/agent-registration.json
curl -sS https://yieldagentx402.app/.well-known/agent-registration.json
curl -sS https://api.yieldagentx402.app/api/tee/report
curl -sS https://api.yieldagentx402.app/api/agents
curl -sS https://api.yieldagentx402.app/api/solvers
curl -sS https://api.yieldagentx402.app/api/dao/info
curl -sS https://api.yieldagentx402.app/api/dao/proposals
```

x402 payment model

YieldAgent x402 uses a dual payment story:
	•	x402 micropayments for paid route access and protected API surfaces
	•	native-chain settlement where the rail supports direct settlement semantics

Payment flow
	1.	client sends payment proof using a supported payment header
	2.	gateway validates payment using configured verifier flow
	3.	in live mode, strict verifier conditions are enforced on protected routes
	4.	if verification succeeds, handler executes
	5.	otherwise the gateway returns payment-required style response semantics

Supported request headers include variants such as:
	•	payment-signature
	•	X-PAYMENT
	•	x402-payment

Verification behavior

If X402_VERIFY_URL is configured, the gateway uses that explicit verifier URL.

Otherwise, if TEE_BRAIN_URL is configured, the gateway uses:
	•	{TEE_BRAIN_URL}/x402/verify

Protected routes do not treat internal service bypasses as a substitute for user micropayments on strict execution flows.

⸻

ERC-8004 / A2A surface

YieldAgent x402 exposes public registration metadata through:
GET /.well-known/agent-registration.json

This surface is intended for:
	•	agent identity discovery
	•	operator association
	•	trust / coordination compatibility
	•	DevSpot / ERC-8004 style inspection

Landing and API surfaces may both expose registration JSON.

⸻

Intent lifecycle

Routes
	•	POST /api/intents/create
	•	POST /api/intents/:id/bid
	•	POST /api/intents/tick
	•	POST /api/intents/:id/proof
	•	POST /api/intents/:id/settlement
	•	POST /api/intents/:id/settlement-webhook
	•	GET /api/intents/:id/attestations

Lifecycle
	1.	Create — protected intent enters the system
	2.	Bid — solvers submit bids
	3.	Tick — internal/admin progression drives auction state
	4.	Proof — execution proof surfaces are attached
	5.	Settlement — settlement or webhook finalizes outcome
	6.	Attestations — read-side evidence can be queried

This is the execution heartbeat of the system.

⸻

Solver model

YieldAgent x402 is designed around solver competition.

Public surfaces
	•	GET /api/solvers
	•	POST /api/solvers/register

Registration

Solver registration is listed in x402 discovery and is intended to be payment-aware.

After payment, registration still requires an approved authorization path such as:
	•	X-Admin-Key: <ADMIN_KEY>
	•	Authorization: Bearer <registered-agent-token>

Network design

The long-term model is an open solver network:
	•	solvers act as peers
	•	staking and reputation align incentives
	•	the hub coordinates routing and discovery

For bootstrap, first-party solver coverage can guarantee liveness and baseline bids until broader external participation matures.

⸻

DAO governance surface

YieldAgent x402 includes a public governance API.

Public routes
	•	GET /api/dao/info
	•	GET /api/dao/proposals
	•	GET /api/dao/proposals/:id

Write routes
	•	POST /api/dao/proposals
requires x-admin-key
	•	POST /api/dao/proposals/:id/vote
requires X-User-Address

Governance model

Governance is proposal-driven and publicly inspectable. Proposals and votes are exposed through public endpoints, while write paths are constrained through authorization and downstream policy controls.

This makes governance auditable even when not every control path is fully onchain.

⸻

Live worker surfaces

Public-facing workers
	1.	agent402 → agent.yieldagentx402.app
	2.	yieldagent-api-gateway → api.yieldagentx402.app
	3.	yieldagent-landing → yieldagentx402.app

Chain compatibility workers
	4.	stacks-compat-worker → stacks-compat.yieldagentx402.app
	5.	near-compat-worker → near-compat.yieldagentx402.app
	6.	bnb-compat-worker → bnb-compat.yieldagentx402.app
	7.	starknet-compat-worker → starknet-compat.yieldagentx402.app
	8.	tron-compat-worker → tron-compat.yieldagentx402.app
	9.	sui-compat-worker → sui-compat.yieldagentx402.app
	10.	solana-compat-worker → solana-compat.yieldagentx402.app
	11.	xrp-compat-worker → xrp-compat.yieldagentx402.app
	12.	rootstock-compat-worker → rootstock-compat.yieldagentx402.app
	13.	stacks-x402-worker → stacks.yieldagentx402.app

Internal / special workers
	13.	tee-signer → see wrangler for host
	14.	btc-yield-proxy → workers.dev / ops base
	15.	near-auto-bidder → cron
	16.	jingswap-signal-autointent → cron
	17.	flippt-agent-worker → cron
	18.	kite-agent-worker → cron
	19.	0g-agent-worker → cron
	20.	tron-agent-worker → cron
	21.	sui-agent-worker → cron
	22.	starknet-agent-worker → cron
	23.	xrp-agent-worker → cron

⸻

Gateway layout
yieldagent-api-gateway/src/
├── index.js              # main gateway entry
├── x402.js               # payment verification + discovery
├── adapters.js           # protocol adapters
└── intent-auction-do.js  # Durable Object for intent auctions

This is the core public execution gateway:
	•	payment gating
	•	discovery
	•	adapter orchestration
	•	auction coordination

⸻

Security posture

Recent hardening and operational safeguards include:
	•	strict verifier trust wiring for x402 verification paths
	•	timing-safe comparison helpers aligned with imports/exports
	•	KV-backed rate limiting
	•	hashed partner API keys
	•	configured-origin CORS restrictions
	•	x402 protection on intent and settlement routes where enforced
	•	coordinated x402 discovery and verification logic
	•	upstream fetch handling that preserves real 4xx / 5xx behavior
	•	authenticated internal tick path
	•	TEE report wiring with fallback handling
	•	zero-enclave guards on TEE verify/report paths
	•	quote sanitization to avoid leaking upstream details
	•	safe JSON parsing on sensitive POST routes
	•	sanitized and clamped solver registration input before KV writes

This section is not a formal audit report, but it reflects active defensive work in the codebase.

⸻

Environment variables

x402 examples
X402_BASE_PAYTO=0x97d794dB5F8B6569A7fdeD9DF57648f0b464d4F1
X402_BASE_ASSET=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
X402_BASE_CAIP2=eip155:8453
X402_BASE_AMOUNT=10000

X402_NEAR_PAYTO=faircat1401.near
X402_NEAR_ASSET=near
X402_NEAR_CAIP2=near:mainnet
X402_NEAR_AMOUNT=10

X402_VERIFY_MODE=live

TEE_BRAIN_URL=https://agent.yieldagentx402.app
TEE_REPORT_URL=<attestation/report endpoint if not defaulted>

**Managed signing + Phala (tee-signer worker):** production deployments configure **`SHADE_AGENT_ENABLED`**, **`SHADE_AGENT_URL`**, and **`CHAIN_SIGNATURES_ENABLED`** on **tee-signer** so x402 / Chain Signatures signing can use the **Phala Shade Agent** CVM. See [Phala Shade Agent signer (autonomous vs human mode)](#phala-shade-agent-signer-autonomous-vs-human-mode) above.

### x402 Verify API Key (secret)
```bash
wrangler secret put X402_VERIFY_API_KEY
# Use a new strong secret — NOT the same as INTERNAL_SHARED_KEY
```

### Secrets (set via wrangler secret put)
```bash
wrangler secret put ADMIN_KEY
wrangler secret put INTERNAL_SHARED_KEY
wrangler secret put X402_VERIFY_API_KEY
```

Integrations
LAYERZERO_ENABLED=true
LAYERZERO_QUOTE_URL=

BITCOINOS_ENABLED=true
BITCOINOS_QUOTE_URL=

AGENT_URL=https://agent.yieldagentx402.app
FEDERATION_HUB_ID=hub-yieldagentx402


These integrations vary by environment and deployment configuration



⸻

KV and Durable Objects

Configure the following per deployment:
	•	SOLVER_KV
	•	PARTNER_KV
	•	WL_KV
	•	RATE_KV
	•	INTENTS_DO (IntentAuctionDO)

The Durable Object layer coordinates auction state; KV namespaces support solver, partner, rate, and other shared state surfaces.

⸻

Representative NEAR credibility

YieldAgent x402 is not only a web surface. It is backed by live operator infrastructure.

The project runs a live NEAR validator / pool footprint with meaningful delegation and real validator telemetry. This matters because the project is built by someone already operating production blockchain infrastructure, not just shipping a frontend demo.

Use that operator proof as part of the trust story, not as a substitute for settlement, auction, or attestation proof.

⸻

Positioning

YieldAgent x402 is best understood as:
	•	not just an AI yield bot
	•	not just a treasury copilot
	•	not just a multichain dashboard

It is:
	•	a verifiable execution market
	•	for autonomous agents and DeFi intents
	•	using x402 for paid access
	•	exposing ERC-8004-compatible identity surfaces
	•	coordinating solver competition
	•	enforcing managed trust controls
	•	and surfacing public receipts across chains

⸻
⸻

Development notes

This repository contains both product and infrastructure surfaces:
	•	live public apps
	•	compatibility workers
	•	internal cron workers
	•	auction coordination
	•	x402 verification
	•	agent registration
	•	DAO governance surfaces
	•	multichain adapter and settlement logic

Because live counts and enabled rails can change, rely on runtime health/status endpoints rather than README copy for current totals.

⸻

Summary

YieldAgent x402 is an execution market for autonomous agents.

Agents pay for routes.
Solvers compete.
Execution is constrained.
Settlement is verified.
Proofs are inspectable.

That is the system.

### Health

```bash
curl -sS https://api.yieldagentx402.app/health
curl -sS https://api.yieldagentx402.app/.well-known/x402
curl -sS https://api.yieldagentx402.app/api/adapters/health
curl -sS https://yieldagentx402.app/api/public/platform-status
curl -sS https://stacks.yieldagentx402.app/health
curl -sS https://tee-signer.yieldagentx402.app/health
```

### Example: register a solver

```bash
curl -sS -X POST https://api.yieldagentx402.app/api/solvers/register \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"solver_1","chains":["base","near"],"capabilities":["yield","lending"],"stake":"10 NEAR"}'
```
