# YieldAgent — Full Architecture Flow

> Traced from source (`yieldagent-api-gateway/`, `agent402/`, `tee-signer/`, compat workers).
> Updated 2026-04-05.

## Platform Map

| Layer | Worker / Platform | Domain |
|-------|-------------------|--------|
| **Landing / Docs** | `yieldagent-landing` | `yieldagentx402.app` |
| **Gateway / API** | `yieldagent-api-gateway` | `api.yieldagentx402.app` |
| **Agent Brain** | `agent402` | `agent.yieldagentx402.app` |
| **TEE** | **NEAR AI Cloud** (`cloud.near.ai`) — Intel TDX hardware enclave | — |
| **TEE Transport** | `tee-signer` | `tee-signer.yieldagentx402.app` |
| **TEE Enclave** | `shade-agent` on NEAR AI Cloud | `shade-agent.yieldagentx402.app` |

```
Landing (yieldagentx402.app)
        ↓
Gateway (api.yieldagentx402.app)
        ↓
Agent Brain (agent.yieldagentx402.app)
        ↓
TEE Transport (tee-signer.yieldagentx402.app)  ← Cloudflare Worker
        ↓
NEAR AI Cloud TEE (cloud.near.ai)              ← Hardware-attested enclave (Intel TDX)
  └─ shade-agent (shade-agent.yieldagentx402.app)
        └─ NEAR MPC (v1.mpc-signer.near)       ← Key never leaves MPC network
```

**Full registry + discovery (on-chain IDs, payTo, scanners, CDP Bazaar, Flippt/Kite/0G, deploy index):** [`X402_ACTIVATION/REGISTRY_AND_DISCOVERY_FULL_SCOPE.md`](X402_ACTIVATION/REGISTRY_AND_DISCOVERY_FULL_SCOPE.md)

---

## Workers and hostnames

| Worker | Hostname | Role |
|--------|----------|------|
| **yieldagent-api-gateway** | `api.yieldagentx402.app` | Public API, x402 gate, intents DO, adapters, cron |
| **agent402** | `agent.yieldagentx402.app` | TEE brain: x402 verify, settlement, attestation, intent/LZ verify |
| **tee-signer** | `tee-signer.yieldagentx402.app` | Managed wallets, signing (EVM/Stacks/etc.), Chain Signatures x402 |
| **shade-agent** | `shade-agent.yieldagentx402.app` (TEE) / `localhost:3000` (local) | NEAR Shade Agent — chain-signature signing via **NEAR AI Cloud TEE** (Intel TDX). Two modes: **human/local** (whitelist, dev) and **autonomous/TEE** (attestation, prod). See `shade-agent/README.md` |
| **yieldagent-landing** | `yieldagentx402.app` | Landing page / docs |
| **\*-compat-worker** (x8) | `{chain}-compat.yieldagentx402.app` | Edge adapters: Solana, Sui, Starknet, Tron, BNB, XRPL, NEAR, Stacks |
| **stacks-x402-worker** | `stacks.yieldagentx402.app` | Stacks-native x402 compat |
| **near-auto-bidder** | (workers.dev) | NEAR intent auto-bidder (cron every 15 min) |
| **btc-yield-proxy** | (workers.dev) | BTC yield data proxy with TEE attestation |

---

## Flow A — x402 Paid API Access (micropayment per call)

This is the core monetization gate. Every route in `X402_DISCOVERY_PATHS` (34 resources) requires payment.

```
CLIENT (browser, AI agent, or Casper auto-pay bot)
  │
  │ ① GET or POST  https://api.yieldagentx402.app/api/<route>
  │    No payment header
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  GATEWAY  (yieldagent-api-gateway)                              │
│                                                                 │
│  isX402DiscoveryResource(pathname) → true                       │
│  requireX402Payment(request) →                                  │
│    getX402PaymentHeader() → empty                               │
│    → return 402 + JSON body:                                    │
│       {                                                         │
│         version: 1, x402Version: 2,                             │
│         accepts: [                                              │
│           { scheme: "exact", network: "eip155:8453",            │
│             amount: "10000", payTo: "0x97d7...",                │
│             asset: "0x8335... (USDC)", ... },                   │
│           { network: "solana:mainnet", ... },                   │
│           { network: "starknet:mainnet", ... },                 │
│           { network: "sui:mainnet", ... },                      │
│           { network: "tron:mainnet", ... },                     │
│           { network: "filecoin:mainnet", ... },                 │
│           { network: "eip155:314" (FEVM), ... },                │
│           { network: "eip155:56" (BNB), ... }                   │
│         ],                                                      │
│         resources: [ ...34 URLs... ],                           │
│         verifyUrl: ".../api/x402/verify",                       │
│         extensions: { bazaar: { info, schema } }                │
│       }                                                         │
│       Header: X-Payment-Required: <base64 of body>             │
└─────────────────────────────────────────────────────────────────┘
  │
  │  Client reads accepts[], picks a rail (e.g. Base USDC),
  │  sends on-chain payment to payTo address
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  PAYMENT (two paths)                                            │
│                                                                 │
│  Path A: Manual — client signs and submits tx, captures txHash  │
│                                                                 │
│  Path B: Chain Signatures (Casper auto-pay) ────────────────    │
│    POST https://tee-signer.yieldagentx402.app/x402/sign         │
│      Header: x-internal-key: <INTERNAL_SHARED_KEY>              │
│      Body: {                                                    │
│        path: "x402-base-usdc",                                  │
│        payload: {                                               │
│          domain: { name, chainId, verifyingContract },          │
│          types: { ... EIP-712 ... },                            │
│          primaryType: "...",                                    │
│          message: { from, to, amount, ... }                     │
│        }                                                        │
│      }                                                          │
│    TEE-SIGNER:                                                  │
│      chain-signatures.ts → signX402Payment()                    │
│        ├─ HTTP: Shade Agent (NEAR AI Cloud TEE) → MPC request_signature │
│        └─ SDK fallback: @neardefi/shade-agent-js                │
│      Derives EVM address from NEAR account + derivation path    │
│      Returns: { signature, address, path }                      │
│                                                                 │
│    GET /x402/address?path=x402-base-usdc                        │
│      → returns derived EVM address to pre-fund                  │
└─────────────────────────────────────────────────────────────────┘
  │
  │ ② Retry same request with payment proof
  │    Headers (checked in priority order):
  │      PAYMENT-SIGNATURE | x402-payment | X-PAYMENT | x-payment
  │    Optional: X-Payment-Chain (rail hint: "sol", "stacks", "bnb", ...)
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  GATEWAY — requireX402Payment()                                 │
│                                                                 │
│  1. Internal bypass: X-Internal-Key matches INTERNAL_SHARED_KEY │
│     → skip payment entirely (service-to-service calls)          │
│                                                                 │
│  2. Local pre-check (no upstream call):                         │
│     • isValidPaymentFormat() — regex structure check            │
│     • Decode base64 → JSON: validate from, amount > 0,         │
│       timestamp within ±120s                                    │
│     → 402 immediately on format/expired failure                 │
│                                                                 │
│  3. hasValidX402Payment() — live mode:                          │
│     POST → X402_VERIFY_URL (agent.yieldagentx402.app/x402/verify)│
│       Headers: x-internal-key, authorization (optional API key) │
│       Body: { paymentHeader, resource, method, chain?, ts }     │
│       Timeout: X402_VERIFY_TIMEOUT_MS (default 5s)              │
│                                                                 │
│  4. Trust contract: response must have                          │
│       verified === true  AND  teeAttested === true              │
│     Both false → 402 with specific failure reason               │
│                                                                 │
│  5. Payment accepted → null (pass-through) → route handler      │
│     → 200 + JSON data                                           │
└─────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  AGENT402 — handleX402Verify (the verify endpoint)              │
│                                                                 │
│  Step 1: Format check on paymentHeader                          │
│                                                                 │
│  Step 2: Replay protection (fail-closed)                        │
│    • SHA-256 digest of token + resource + method                │
│    • REPLAY_DO (Durable Object) → atomic claim                  │
│    • REPLAY_KV → durable audit log                              │
│    • Already-used proof → 409                                   │
│    • DO unavailable → 503 (never pass-through)                  │
│                                                                 │
│  Step 3: TEE attestation gate (mandatory)                       │
│    • fetchAndValidateAttestation(env, { nonce })                │
│    • NEAR AI Cloud attestation report                           │
│    • mrEnclave hash comparison (NEAR_AI_AGENT_HASH)             │
│    • Missing/invalid attestation → 503                          │
│                                                                 │
│  Step 4: On-chain settlement verification                       │
│    Rail detection: x-payment-chain hint OR detectRail(token)    │
│    ┌──────────────────────────────────────────────────┐         │
│    │  Rail        │ Verifier function                 │         │
│    ├──────────────┼───────────────────────────────────┤         │
│    │ base         │ verifyBaseSettlement (ERC-20 log)  │         │
│    │ evm:*        │ verifyEvmSettlement (15+ chains)   │         │
│    │ near         │ verifyNearSettlement (NEAR RPC)    │         │
│    │ stacks       │ verifyStacksSettlement (Hiro API)  │         │
│    │ sol          │ verifySolanaSettlement (JSON-RPC)   │         │
│    │ trx          │ verifyTronSettlement (TronGrid)     │         │
│    └──────────────┴───────────────────────────────────┘         │
│    Checks: recipient, asset contract, amount, tx success        │
│                                                                 │
│  Step 5: Record replay → confirm in DO + KV                     │
│                                                                 │
│  → { verified: true, teeAttested: true, rail, txHash, ... }    │
└─────────────────────────────────────────────────────────────────┘

```

---

## Flow B — Intent Lifecycle (cross-chain DeFi execution)

```
CLIENT / SOLVER
  │
  │ ① POST /api/intents/create  (x402-gated)
  │    Body: { chain, fromToken, toToken, amount, userAddress, ... }
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  GATEWAY → IntentAuctionDO (Durable Object, SQLite-backed)     │
│                                                                 │
│  Creates intent:                                                │
│    • id, status: "open", expiresAt, chain, adapter              │
│    • Stored in DO with auction window                           │
│                                                                 │
│  Intent surfaces: GET /api/intents, /api/intents/feed,          │
│    /api/intents/stats (public), /api/intents/:id/status         │
└─────────────────────────────────────────────────────────────────┘
  │
  │ ② Solvers bid (external or platform autobidder)
  │    POST /api/intents/:id/bid  (x402-gated)
  │    Body: { solverAddress, bidPrice, ... }
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  IntentAuctionDO:                                               │
│    • Collects bids during auction window                        │
│    • Selects winner (best price, reputation score)              │
│    • Status → "awarded" / "won"                                 │
└─────────────────────────────────────────────────────────────────┘
  │
  │ ③ Execution (two paths)
  │
  ├─► PLATFORM AUTO-SOLVER (cron, every minute) ──────────────────
  │   Gateway cron → runMultiChainAutoSolver(env)                 │
  │                                                               │
  │   multiChainScan(env):                                        │
  │     • Queries INTENTS_DO for open intents                     │
  │     • Filters: isMcIntent() → solana, sui, starknet,         │
  │       stacks, filecoin, xrpl chains + known adapters          │
  │     • For each winning intent:                                │
  │       1. Quote via /api/adapters/plan (internal key)          │
  │       2. signWithPlan → POST /api/wallets/sign                │
  │          (proxied to tee-signer: executeWithWallet)            │
  │          ⚠ XRPL excluded: "xrpl_managed_sign_not_supported"  │
  │       3. Record to MARKET_KV: mc_exec:{intentId}              │
  │                                                               │
  │   pollAndSettleMultiChain(env):                               │
  │     • List MARKET_KV mc_exec:* entries                        │
  │     • For each with txHash + status != "settled":             │
  │       getTxConfirmed(chain, txHash) via RPC:                  │
  │         Solana, Sui, Starknet, Stacks, Filecoin, XRPL        │
  │     • On confirmed: mark settled in KV + DO                   │
  │                                                               │
  │   Also runs in parallel:                                      │
  │     • nearAutoSubmitBids → NEAR intent bidder                 │
  │     • pollAndSettleNearSwaps → NEAR ChainDefuser 1Click       │
  │     • runTronAutoSolver → Tron auto-solver                    │
  │     • runErrorRateAlert, runHubHealthCheck                    │
  │                                                               │
  ├─► EXTERNAL SOLVER (submits settlement proof) ─────────────────
  │   POST /api/intents/:id/settlement  (x402-gated)             │
  │     Body: { txHash, settledBy, ... }                          │
  │                                                               │
  │   Gateway forwards to agent402:                               │
  │     POST /tee/verify-settlement → handleVerifySettlement      │
  │       Chains: near, bitcoin, stacks, sui, starknet, tron,    │
  │         solana, xrpl, + 15 EVM chains                         │
  │     POST /tee/verify-intent → handleVerifyIntent              │
  │       Raw tx checks: Solana, Sui, Starknet, Filecoin, XRPL   │
  │                                                               │
  │   On verified → intent status: "settled"                      │
  └───────────────────────────────────────────────────────────────┘
```

---

## Flow C — Managed Wallet Signing (TEE Signer)

```
GATEWAY (or auto-solver)
  │
  │ POST https://api.yieldagentx402.app/api/wallets/sign
  │   (proxied internally → tee-signer.yieldagentx402.app/sign)
  │   Header: x-internal-key: <INTERNAL_SHARED_KEY>
  │   Body: {
  │     walletId, chain, action, amount, destination,
  │     requestId, timestamp, callerId,
  │     controlClass: "ghost" | "autonomous" | "human" | "shadow",
  │     secondApprovalId, secondApprovalHash  (required in prod for ghost)
  │   }
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  TEE-SIGNER — executeWithWallet()                               │
│                                                                 │
│  Wallet policy engine:                                          │
│    • WALLET_KV: wallet definitions, freeze state, limits        │
│    • Control class gates: ghost requires second approval         │
│    • Chain routing: chain → signer (EVM, Stacks, NEAR, etc.)   │
│    • Action types: transfer, approve, stake, bridge, etc.       │
│    • Amount limits, rate limits, audit logging                  │
│                                                                 │
│  On approved:                                                   │
│    → Sign tx with managed private key (KV-stored, TEE-scoped)  │
│    → Broadcast (or return signed tx for client to broadcast)    │
│    → Audit log in WALLET_KV: audit:{epochMs}:{requestId}       │
│                                                                 │
│  Returns: { status: "signed" | "dry-run" | "rejected", ... }   │
└─────────────────────────────────────────────────────────────────┘

GATEWAY pre-flight checks (before proxying to tee-signer):
  • Ghost second approval validation (GHOST_SECOND_APPROVAL_REQUIRED)
  • Live TEE attestation probe (probeTeeLiveVerifiedForSign)
  • Treasury approval verification (TREASURY_STATE_DO)
```

---

## Flow D — Bridge / Cross-Chain Execution

Eleven bridge integrations are live:

| Bridge | Status | Protocol | Chains | Endpoint |
|--------|--------|----------|--------|----------|
| **LayerZero V2** | ✅ live | Omnichain messaging | ETH, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche, Solana, Filecoin | `/api/bridge/layerzero/quote` + `/verify` |
| **BitcoinOS** | ✅ live | Bitcoin zk-rollup | Bitcoin ↔ EVM | `/api/bridge/bitcoinos/quote` |
| **Charms** | ✅ live | Bitcoin 1-click bridge | Bitcoin ↔ multi-chain | `/api/bridge/charms/quote` |
| **NEAR Intents** | ✅ live | Defuse 1-Click relay | Multi-chain | `/api/intents/near/*` |
| **Secured Finance** | ✅ live | Filecoin bridge/lend | Filecoin | `ADAPTER_SECURED_QUOTE_URL` → GLIF fallback |
| **Navi** | ✅ live | Sui liquidity bridge | Sui | `ADAPTER_NAVI_QUOTE_URL` |
| **Rhea Finance** | ✅ live | Rainbow + Allbridge | NEAR ↔ EVM | `/api/rhea/bridge/routes` |
| **Relay** | ✅ live | Cross-chain relayer | ETH, Base, Arbitrum, Optimism, Polygon, Zora + EVM L2s | `/api/bridge/relay/quote` — relay.link API |
| **Gas.zip** | ✅ live | Gas refuel bridge | 130+ chains | `/api/bridge/gaszip/quote` — gas.zip API |
| **Axelar** | ✅ live | Axelar GMP bridge | ETH, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB | `/api/bridge/axelar/quote` — `ADAPTER_AXELAR_*` |
| **Rubic** | ✅ live | Cross-chain swap/bridge aggregator | Multi (via LayerZero, Stargate, etc.) | `/api/adapters/rubic/quote` — `ADAPTER_RUBIC_*` |

```
CLIENT (or auto-solver)
  │
  │ Bridge quote:
  │   POST /api/bridge/layerzero/quote   → LAYERZERO_QUOTE_URL
  │   POST /api/bridge/bitcoinos/quote   → BITCOINOS_QUOTE_URL
  │   POST /api/bridge/charms/quote      → CHARMS_QUOTE_URL
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  GATEWAY routes quote to agent402:                              │
│    LayerZero → agent.yieldagentx402.app/bridge/layerzero/…     │
│    BitcoinOS → agent.yieldagentx402.app/bridge/bitcoinos/…     │
│    Charms    → agent.yieldagentx402.app/bridge/charms/…        │
│                                                                 │
│  Agent402 returns: estimated fee, route, time                   │
└─────────────────────────────────────────────────────────────────┘
  │
  │ Execution (if approved):
  │   → Gateway builds sign payload
  │   → POST /api/wallets/sign  (see Flow C)
  │   → TEE signer gates: PHALA_TEE_ENABLED, PHALA_TEE_MODE  (NEAR AI Cloud TEE)
  │   → Signed message broadcast to bridge protocol
  │
  │ Verification:
  │   POST agent402/tee/verify-lz → handleVerifyLayerZero
  │     (LayerZero message hash + nonce check via LZ_ENDPOINT scan API)
  │
  │ Status:
  │   GET /api/bridge/layerzero/status
  │   GET /api/bridge/bitcoinos/status (BITCOINOS_STATUS_URL)
  │   GET /api/bridge/charms/status (CHARMS_STATUS_URL)
```

**Env vars required (wrangler.jsonc / secrets):**
- `LAYERZERO_QUOTE_URL`, `LAYERZERO_VERIFY_URLS`, `LZ_ENDPOINT`
- `BITCOINOS_QUOTE_URL`, `BITCOINOS_STATUS_URL`
- `CHARMS_QUOTE_URL`, `CHARMS_STATUS_URL`
- **Adapter routing** (Cloudflare secrets — not vars, due to bridge var conflict):
  `ADAPTER_LAYERZERO_QUOTE_URL`, `ADAPTER_LAYERZERO_PLAN_URL`,
  `ADAPTER_CHARMS_QUOTE_URL`, `ADAPTER_CHARMS_PLAN_URL`

---

## Flow E — Adapter Quotes and Plans (DeFi protocols)

```
CLIENT
  │
  │ POST /api/adapters/quote  (x402-gated)
  │   Body: { adapter: "aave", chain: "base", amount: "1000", ... }
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  GATEWAY — handleAdapterQuote()                                 │
│                                                                 │
│  1. Look up adapter in ADAPTER_DEFS (86 key entries)            │
│  2. Determine mode: sim (simulated) | live | auto               │
│     • sim: return hardcoded/estimated quote                     │
│     • live: forward to ADAPTER_{KEY}_QUOTE_URL                  │
│       (→ agent.yieldagentx402.app/adapters/{key}/quote)         │
│     • auto: try live, fall back to sim on 4xx/5xx               │
│  3. Return: { apy, tvl, risk, steps, provenance, ... }         │
│                                                                 │
│  POST /api/adapters/plan  (x402-gated)                          │
│    → Same routing, ADAPTER_{KEY}_PLAN_URL                       │
│    → Returns executable payload for tee-signer                  │
│                                                                 │
│  Discovery:                                                     │
│    GET /api/adapters            — full registry (groupBy=chain) │
│    GET /api/adapters/discover   — filter by chain, category     │
│    GET /api/adapters/health     — per-adapter liveness           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Flow F — Compat Workers (edge chain adapters)

```
EXTERNAL CLIENT (e.g. wallet on Sui)
  │
  │ Any API call to https://sui-compat.yieldagentx402.app/api/…
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│  COMPAT WORKER (sui-compat-worker)                              │
│                                                                 │
│  1. Passes through allowed headers                              │
│  2. Sets x-payment-chain: "sui" on all forwarded requests       │
│  3. Proxies to api.yieldagentx402.app (gateway)                 │
│                                                                 │
│  Same pattern for: solana, starknet, tron, bnb, xrp, near,     │
│    stacks compat workers                                        │
│                                                                 │
│  Purpose: CORS for chain-specific frontends + rail hint         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Cron Schedule (gateway)

Trigger: `* * * * *` (every minute)

| Task | Function | What it does |
|------|----------|--------------|
| `bidder` | `nearAutoSubmitBids` | Bids on open NEAR intents |
| `settle` | `pollAndSettleNearSwaps` | Settles ChainDefuser 1Click swaps |
| `tron-solve` | `runTronAutoSolver` | Tron intent auto-execution |
| `mc-solve` | `runMultiChainAutoSolver` | Solana/Sui/Starknet/Stacks/Filecoin/XRPL scan + settle |
| `alerting` | `runErrorRateAlert` | Error-rate monitoring |
| `hub-health` | `runHubHealthCheck` | Federation hub liveness |

Near-auto-bidder (separate worker): `*/15 * * * *`

---

## Key Environment Secrets (cross-worker)

| Secret | Where | Purpose |
|--------|-------|---------|
| `INTERNAL_KEY_VERIFY` | Gateway + Agent402 | Gateway → agent402 per-surface auth (preferred) |
| `INTERNAL_KEY_SIGN` | Gateway + TEE-signer + compat workers | Gateway → tee-signer per-surface auth (preferred) |
| `INTERNAL_SHARED_KEY` | All workers | Fallback service-to-service auth (compat) |
| `NEAR_AI_API_KEY` | Agent402 | NEAR AI Cloud TEE attestation |
| `CHAIN_SIGNATURES_ENABLED` | TEE-signer | Gates Chain Signatures x402 signing |
| `CHAIN_SIGNATURES_X402_ENABLED` | Gateway | Gates product use of Casper auto-pay |
| `ADMIN_KEY` | Gateway | Full admin access |
| `TEE_PLATFORM_SIGN_URL` | Gateway | NEAR AI Cloud TEE live signing endpoint |

---

## Observability

Structured JSON logs are emitted at key decision points. Compatible with CF Logpush, Tail Workers, or external sinks (Datadog, Loki).

| Event | Worker | Fields |
|-------|--------|--------|
| `x402_verified` | agent402 | `rail`, `chain`, `txHash`, `amount`, `latencyMs`, `teeAttested` |
| `x402_payment_accepted` | gateway | `rail`, `chain` |
| `verify_rejected` | gateway | `verified`, `teeAttested`, `rejectReason` |
| `tee_gate_blocked` | agent402 | `reason` |
| `attestation_circuit_open` | agent402 | (circuit breaker tripped) |
| `replay_kv_missing` | agent402 | (REPLAY_KV binding absent) |

PII policy: `txHash` and wallet addresses are public on-chain data. Internal keys, API secrets, and bearer tokens are never logged. See `structured-log.js` for the redaction list.

---

## Audit notes and change freeze

Pre-change audit backlog and the **BLUE** review gate live in [`AUDIT_CONCERNS_NOTES.md`](AUDIT_CONCERNS_NOTES.md). No changes from that list until you say **BLUE** after uploads.
