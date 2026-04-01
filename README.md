
# YieldAgent x402 — Verifiable Execution Markets
**TEE-secured execution marketplace for DeFi intents and AI-agent capital routing.** Solvers compete with crypto-bound proofs; settlements are verified across many chains (Bitcoin-related rails, Stacks, NEAR, Sui, Solana, TRON, multiple EVMs, and more). **Dual payment story:** x402 micropayments plus native-chain settlement where each rail supports it.
**Live:** [yieldagentx402.app](https://yieldagentx402.app) · **API:** [api.yieldagentx402.app](https://api.yieldagentx402.app)
---
## Repository 

Worker	Domain
#	Folder	Notes
1	agent402	agent.yieldagentx402.app
2	yieldagent-api-gateway	api.yieldagentx402.app
3	yieldagent-landing	yieldagentx402.app
4	stacks-compat-worker	stacks-compat.yieldagentx402.app
5	near-compat-worker	near-compat.yieldagentx402.app
6	bnb-compat-worker	bnb-compat.yieldagentx402.app
7	starknet-compat-worker	starknet-compat.yieldagentx402.app
8	tron-compat-worker	tron-compat.yieldagentx402.app
9	sui-compat-worker	sui-compat.yieldagentx402.app
10	solana-compat-worker	solana-compat.yieldagentx402.app
11	xrp-compat-worker	xrp-compat.yieldagentx402.app
12	rootstock-compat-worker	rootstock-compat.yieldagentx402.app
13	tee-signer	tee-signer (see wrangler for host)
14	btc-yield-proxy	workers.dev / ops base
15	near-auto-bidder	cron
16	stacks-x402-worker	stacks.yieldagentx402.app
17	jingswap-signal-autointent	cron
18	flippt-agent-worker	cron
19	kite-agent-worker	cron
20	0g-agent-worker	cron
21	tron-agent-worker	cron
22	sui-agent-worker	cron
23	starknet-agent-worker	cron
24	xrp-agent-worker	cron
Quick links
Resource	URL
Live site	https://yieldagentx402.app
API / health	https://api.yieldagentx402.app/health
x402 discovery	https://api.yieldagentx402.app/.well-known/x402
A2A / ERC-8004	https://api.yieldagentx402.app/.well-known/agent-registration.json
Chains (live)
The exact live adapter counts are returned by GET /health (adapters.total, enabled, live, etc.). Treat any fixed number in marketing copy as illustrative unless you attach a current /health snapshot.

Representative rails (ecosystem): NEAR, Base (EVM), Solana, BitcoinOS, LayerZero, Sui, Starknet, Tron, Filecoin, Stacks, Bitcoin (Babylon / BitcoinOS), Sei, and many EVM networks.

Decentralization
Solver nodes as peers — Run a solver that bids on intents; stake and reputation align incentives. The hub routes; it does not own solver fleets.
TEE + attestation — Sensitive paths are designed for TEE-backed verification and attestation workflows (see /api/tee/report and verifier integration).
Discovery — Public: GET /api/solvers. x402: /.well-known/x402. Agents / A2A: /.well-known/agent-registration.json.

Gateway layout
yieldagent-api-gateway/src/
  index.js               ← Main gateway (entry)
  x402.js                ← Payment verification + discovery
  adapters.js            ← Protocol adapters
  intent-auction-do.js   ← Durable Object for intent auctions
Security fixes (index / x402 references)
ID	Description
FIX-1	x402 verify wired to TEE brain — strict trust contract on verifier response
FIX-2	timingSafeEqualAsync export name matches imports
FIX-3	KV-backed rate limiting
FIX-4	Partner API keys stored as SHA-256 hash
FIX-5	CORS locked to configured origins
FIX-6	Intent create / bid / status / settlement x402-protected where enforced
FIX-7	x402 discovery coordinated with x402.js
FIX-8	fetchJsonDetailed on upstreams (real 4xx/5xx)
FIX-9	/api/intents/tick requires internal/admin auth
FIX-10	TEE report wired to TEE_REPORT_URL + attestation fallbacks
FIX-11	Zero-enclave guard on TEE verify + report
FIX-12	BitcoinOS quote does not leak upstream URL
FIX-13	safeJsonBody on sensitive POST routes
FIX-14	Solver register input clamped/sanitized before KV write
Environment variables
Live x402 (examples — match your wrangler)
X402_BASE_PAYTO=0x97d794dB5F8B6569A7fdeD9DF57648f0b464d4F1
X402_BASE_ASSET=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
X402_BASE_CAIP2=eip155:8453
X402_BASE_AMOUNT=10000
X402_NEAR_PAYTO=faircat1401.near
X402_NEAR_ASSET=near
X402_NEAR_CAIP2=near:mainnet
X402_NEAR_AMOUNT=10
X402_VERIFY_MODE=live
Verifier URL (read carefully)
If X402_VERIFY_URL is set → gateway uses that HTTPS URL.
Else if TEE_BRAIN_URL is set → gateway calls {TEE_BRAIN_URL}/x402/verify (not /verify).
Optional:

TEE_BRAIN_URL=https://agent.yieldagentx402.app
TEE_REPORT_URL=<your attestation/report endpoint if not defaulted>
Secrets (Wrangler)
wrangler secret put ADMIN_KEY
wrangler secret put INTERNAL_SHARED_KEY
wrangler secret put X402_VERIFY_API_KEY
Integrations (examples)
LAYERZERO_ENABLED=true
LAYERZERO_QUOTE_URL=<your lz quote endpoint>
BITCOINOS_ENABLED=true
BITCOINOS_QUOTE_URL=<your bitcoinos quote endpoint>
AGENT_URL=https://agent.yieldagentx402.app
FEDERATION_HUB_ID=hub-yieldagentx402
Production CORS_ALLOWED_ORIGINS is usually a comma-separated list of allowed web origins, not a single URL.

KV / Durable Objects (wrangler.jsonc)
Configure SOLVER_KV, PARTNER_KV, WL_KV, RATE_KV, and INTENTS_DO (IntentAuctionDO) per your deployment IDs.


Verify live
curl -sS https://api.yieldagentx402.app/health
curl -sS https://api.yieldagentx402.app/.well-known/x402
curl -sS https://api.yieldagentx402.app/.well-known/agent-registration.json
curl -sS https://yieldagentx402.app/.well-known/agent-registration.json
curl -sS https://api.yieldagentx402.app/api/tee/report
curl -sS https://api.yieldagentx402.app/api/agents
curl -sS https://api.yieldagentx402.app/api/solvers
Health: expect x402.verifyMode (e.g. live) and x402.verifyUrl (explicit | tee-brain-inferred | none) when configured.

x402 payment flow (live)
Client sends a payment proof in a supported header: payment-signature, X-PAYMENT, and/or x402-payment.
Gateway POSTs to X402_VERIFY_URL or {TEE_BRAIN_URL}/x402/verify with the token and bound resource/method context.
In live mode, payment is accepted only if the verifier returns verified: true and teeAttested: true (both required).
If accepted, the handler runs; otherwise 402 with payment-required style headers/body.
Internal service calls may use X-Internal-Key on routes that allow bypass (not a substitute for user micropayments on strict execution routes).

Solver registration
POST /api/solvers/register is listed in x402 discovery: callers must pass valid x402 payment (or use an approved internal path with X-Internal-Key — operations only).

After payment, registration still requires either:

X-Admin-Key: <ADMIN_KEY>, or
Authorization: Bearer <agent-token> from a registered agent.
Do not document “admin key only” without also documenting the payment header (or internal ops flow).

A2A (ERC-8004)
Property	Value
Endpoint	GET /.well-known/agent-registration.json
Spec	EIP-8004
Auth	None (public)
Landing and API both expose registration JSON; HTML may include <link rel="alternate"> for crawlers.

Intent lifecycle
Step	Route	Notes
Create	POST /api/intents/create	x402-gated
Bid	POST /api/intents/:id/bid	x402-gated
Tick	POST /api/intents/tick	internal / admin
Proof	POST /api/intents/:id/proof	internal / admin
Settlement	POST /api/intents/:id/settlement or .../settlement-webhook	x402 + internal/admin where enforced
Attestations	GET /api/intents/:id/attestations	read
