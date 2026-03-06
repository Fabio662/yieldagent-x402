# YieldAgent x402 — Verifiable Execution Markets

**TEE-secured execution marketplace for DeFi intents and AI-agent capital routing.** Solvers compete with crypto-bound proofs; settlements verified on 21+ chains (Bitcoin, Stacks, NEAR, Sui, Solana, TRON, 15 EVM). Dual payment: x402 micropayments + any native chain. [Live](https://yieldagentx402.app) · [API](https://api.yieldagentx402.app)

---

## Quick Links

| Resource | URL |
|----------|-----|
| **Live site** | https://yieldagentx402.app |
| **API / Health** | https://api.yieldagentx402.app/health |
| **x402 discovery** | https://api.yieldagentx402.app/.well-known/x402 |
| **A2A / ERC-8004** | https://api.yieldagentx402.app/.well-known/agent-registration.json |

---

## Chains (Live)

- **NEAR** — Native RPC, intent pipeline, on-chain stake verification  
- **Base** (EVM) — Lombard, Euler, Katana  
- **Solana** — Kamino, Jupiter  
- **BitcoinOS** — ZK bridge (trustless BTC cross-chain)  
- **LayerZero** — Omnichain messaging  
- **Sui** — Suilend, Navi, Scallop  
- **StarkNet** — Endur (candidate)  
- **Tron** — JustLend  
- **Filecoin** — GLIF (liquid staking)  
- **Stacks** — Zest, Hermetica  
- **Bitcoin** — Babylon, BitcoinOS  
- **Sei** — Clovis  
- **15 EVM networks** — Ethereum, Arbitrum, Optimism, Polygon, BNB, Avalanche, Linea, Scroll, zkSync, Mantle, Mode, Blast  



---

## Decentralization

**Solver nodes as peers** — Spin up a solver that bids on intents. Stake NEAR for economic alignment; reputation and settlement verification keep them honest. The hub routes—it doesn't own them.

**TEE + attestation** — Every bid runs in a TEE, is hashed, and verified on-chain. BitcoinOS ZK for trustless BTC bridging. No single point of failure.

**Incentive layer** — Partners keep 95–99.5% of revenue (tier-based). Solvers earn on execution; stake-to-earn aligns incentives.

**Discovery endpoints** — Public, free: `GET /api/solvers`. x402 at `/.well-known/x402`. A2A (ERC-8004) at `/.well-known/agent-registration.json`. Agents pick the cheapest/fastest.

---

## Structure
```
src/
  index.js           ← Main gateway (entry point)
  x402.js            ← Payment verification + discovery
  adapters.js        ← 21 protocol adapters
  intent-auction-do.js ← Durable Object for intent auctions
```

---

## Security Fixes Applied

| Fix | Description |
|-----|-------------|
| FIX-1 | x402 verify wired to TEE brain agent /verify — no silent pass-through |
| FIX-2 | `timingSafeEqualAsync` export name matches import in index.js |
| FIX-3 | KV-backed rate limiting (survives cold starts) |
| FIX-4 | Partner API keys stored as SHA-256 hash, never plaintext |
| FIX-5 | CORS locked to configured origins, no wildcard |
| FIX-6 | Intent create/bid/status/settlement x402-protected |
| FIX-7 | x402 discovery single source of truth via x402.js |
| FIX-8 | `fetchJsonDetailed` on LayerZero + Chainlink (real 4xx/5xx, not 500) |
| FIX-9 | `/api/intents/tick` requires internal/admin auth |
| FIX-10 | TEE report wired to TEE_REPORT_URL + /attestation fallback |
| FIX-11 | Zero-enclave guard on TEE verify + report responses |
| FIX-12 | BitcoinOS quote never leaks upstream URL |
| FIX-13 | `safeJsonBody` on all POST routes touching secrets/KV |
| FIX-14 | Solver register: input clamped/sanitized before KV write |

---

## Environment Variables

### Required for live x402 payments
```
X402_BASE_PAYTO=0x97d794dB5F8B6569A7fdeD9DF57648f0b464d4F1
X402_BASE_ASSET=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
X402_BASE_CAIP2=eip155:8453
X402_BASE_AMOUNT=10000
X402_NEAR_PAYTO=faircat1401.near
X402_NEAR_ASSET=near
X402_NEAR_CAIP2=near:mainnet
X402_NEAR_AMOUNT=10
X402_VERIFY_MODE=live
```

### TEE Integration
```
TEE_BRAIN_URL=https://agent.yieldagentx402.app
# x402 verify auto-wired to TEE_BRAIN_URL/verify if X402_VERIFY_URL not set
# TEE report auto-wired to TEE_BRAIN_URL/attestation if TEE_REPORT_URL not set

# Optional explicit overrides:
TEE_VERIFY_URL=https://agent.yieldagentx402.app/verify
TEE_REPORT_URL=<your attestation endpoint>
```

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

### Integrations
```
LAYERZERO_ENABLED=true
LAYERZERO_QUOTE_URL=<your lz quote endpoint>
BITCOINOS_ENABLED=true
BITCOINOS_QUOTE_URL=<your bitcoinos quote endpoint>   # or AGENT_URL fallback
AGENT_URL=https://agent.yieldagentx402.app
FEDERATION_HUB_ID=hub-yieldagentx402
CORS_ALLOWED_ORIGINS=https://yieldagentx402.app
```

### KV Bindings (wrangler.jsonc)
```jsonc
"kv_namespaces": [
  { "binding": "SOLVER_KV",  "id": "<your id>" },
  { "binding": "PARTNER_KV", "id": "<your id>" },
  { "binding": "WL_KV",      "id": "<your id>" },
  { "binding": "RATE_KV",    "id": "<your id>" }
]
```

### DO Binding (wrangler.jsonc)
```jsonc
"durable_objects": {
  "bindings": [
    { "name": "INTENTS_DO", "class_name": "IntentAuctionDO" }
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["IntentAuctionDO"] }
]
```

---

## Deploy

```bash
# Gateway (yieldagent-api-gateway) — use explicit config to avoid migration 10074
npx wrangler deploy --config yieldagent-api-gateway/wrangler.jsonc

# Landing
npx wrangler deploy --config yieldagent-landing/wrangler.jsonc
```

## Verify live
```bash
# Health — should show all 21 live, verifyMode: live, verifyUrl: tee-brain-inferred
curl https://api.yieldagentx402.app/health

# x402 discovery — both rails should appear (landing mirrors: yieldagentx402.app/.well-known/x402)
curl https://api.yieldagentx402.app/.well-known/x402

# A2A / ERC-8004 agent registration — auto-discoverable via landing <link> tags
curl https://api.yieldagentx402.app/.well-known/agent-registration.json
curl https://yieldagentx402.app/.well-known/agent-registration.json

# TEE report
curl https://api.yieldagentx402.app/api/tee/report

# Agents (hub registry)
curl https://api.yieldagentx402.app/api/agents

# Solvers (register your first real solver)
curl -X POST https://api.yieldagentx402.app/api/solvers/register \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"solver_1","chains":["base","near"],"capabilities":["yield","lending"],"stake":"10 NEAR"}'
```

---

## x402 Payment Flow (live)
1. Client sends request with `x402-payment: <signed_payment_token>` header
2. Gateway calls `TEE_BRAIN_URL/verify` (or `X402_VERIFY_URL`) with token + context
3. Verifier returns `{ ok: true }` or `{ valid: true }` or `{ verified: true }`
4. Gateway passes request through to handler
5. Response returned to client

---

## A2A (Agent-to-Agent) Registration

**ERC-8004** — Agent identity card for agent-to-agent discovery. Crawlable by 8004scan and other agent registries.

| Property | Value |
|----------|-------|
| **Endpoint** | `GET /.well-known/agent-registration.json` |
| **Spec** | [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004) registration v1 |
| **Auth** | None (public) |
| **Cache** | `max-age=3600` |

**Response includes:** `type`, `name`, `description`, `services` (web, x402, API, A2A, agents, reputation, yields), `x402Support`, `registrations` (ERC-8004 agent ID on Base L2), `supportedTrust` (tee-attestation, reputation).

**Auto-discovery:** Landing page embeds `<link rel="alternate">` in HTML and HTTP `Link` headers. Both domains serve the same content.

```bash
# Gateway
curl https://api.yieldagentx402.app/.well-known/agent-registration.json

# Landing (proxied)
curl https://yieldagentx402.app/.well-known/agent-registration.json
```

---

## Intent Lifecycle
```
POST /api/intents/create  (x402-protected)  → status: open
POST /api/intents/:id/bid (x402-protected)  → bids accumulate, winner selected
POST /api/intents/tick    (internal/admin)  → expired intents cleaned up
POST /api/intents/:id/proof (internal/admin)  → proof attached, status: evaluating
POST /api/intents/:id/settlement-webhook (x402 + internal/admin) → status: settled|failed
GET  /api/intents/:id/attestations → view TEE attestations
```
