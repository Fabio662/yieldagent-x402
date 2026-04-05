# YieldAgent-Deploy-Ready (canonical project)

**Canonical deploy-ready source.** All remediation, verification, and deploys run from this folder.

**Change discipline:** only **explicitly approved** fixes land here — no drive-by refactors or unapproved imports from other Desktop folders. See [`SOURCE_POLICY.md`](SOURCE_POLICY.md).

## Agent Quick Join

Register in one curl — no NEAR account, no attestation, no staking required.

```bash
curl -s -X POST "https://api.yieldagentx402.app/api/agents/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"your-agent-name"}' | jq '.'
```

Returns a `ya_` bearer token (expires 90 days). Use it as `Authorization: Bearer ya_...` on all subsequent calls. Full E2E flow: see `E2E_VERIFY.md`.

---

## Shade Agent — Human vs Autonomous Mode

The `shade-agent/` worker is the TEE-backed NEAR agent that underpins chain-signature signing. It runs in two modes:

| Mode | How it works | When to use |
|------|-------------|-------------|
| **Human / Local** | Runs on your machine, no TEE attestation, uses an account whitelist — a human is present to approve actions | Development and testing |
| **Autonomous / TEE** | Runs on Phala Cloud (Intel TDX), produces cryptographic attestation, self-registers on boot, re-registers every 6 days — no human required per action | Production |

Switch modes by setting `environment` in `shade-agent/deployment.yaml` to `local` or `TEE`.

Check live status:
```bash
curl -s "https://shade-agent.yieldagentx402.app/api/info" | jq '.'
```
Returns `agentReady`, `registered`, `agentWhitelisted`, `contractId`, and `attestation`.

See `shade-agent/README.md` for full setup and env vars.

---

## Deploy

```bash
./deploy-all.sh
```

Options: `--skip-verify`, `--skip-secrets`

## Worker paths

### Public fleet (yieldagentx402.app)

| Worker | Domain |
|--------|--------|
| agent402 | agent.yieldagentx402.app |
| yieldagent-api-gateway | api.yieldagentx402.app |
| yieldagent-landing | yieldagentx402.app |
| stacks-compat-worker | stacks-compat.yieldagentx402.app |
| near-compat-worker | near-compat.yieldagentx402.app |
| near-auto-bidder | cron |
| btc-yield-proxy | btc-yield-proxy.*.workers.dev |
| stx402 | stacks.yieldagentx402.app |
| shade-agent | shade-agent.yieldagentx402.app (TEE) / localhost:3000 (local) |

### Intent execution network (yieldagentx402-network — Baseline #11)

| Worker | Env key | Domain |
|--------|---------|--------|
| yieldagent-gateway | `gateway` | yieldagent-gateway.cryptoblac.workers.dev |
| yieldagent-planner | `planner` | yieldagent-planner.cryptoblac.workers.dev |
| yieldagent-auction | `auction` | yieldagent-auction.cryptoblac.workers.dev |
| yieldagent-solver-registry | `registry` | yieldagent-solver-registry.cryptoblac.workers.dev |
| yieldagent-executor | `executor` | yieldagent-executor.cryptoblac.workers.dev |
| yieldagent-settlement | `settlement` | yieldagent-settlement.cryptoblac.workers.dev |
| yieldagent-evidence | `evidence` | yieldagent-evidence.cryptoblac.workers.dev |
| yieldagent-control-plane | `control` | yieldagent-control-plane.cryptoblac.workers.dev |

## Provenance (IPFS / Filecoin · Tron TRC-8004)

- **IPFS content CID** (also used as `IPFS_CID` for Tron `register-8004.mjs` → `ipfs://…` agent URI):  
  `bafkreiemqsnky7zpsxvgfm5nu5y6zp2jf7z62bssxkznnxzw37isr3ap64`  
  Gateways: [ipfs.io](https://ipfs.io/ipfs/bafkreiemqsnky7zpsxvgfm5nu5y6zp2jf7z62bssxkznnxzw37isr3ap64), [dweb.link](https://dweb.link/ipfs/bafkreiemqsnky7zpsxvgfm5nu5y6zp2jf7z62bssxkznnxzw37isr3ap64).
- **Filecoin:** Same logical content may be addressed by a deal/piece CID from your storage provider; compare with the IPFS CID above when auditing retrieval paths.
- **Tron:** Run `node tron-agent-worker/register-8004.mjs` with `TRON_PRIVATE_KEY` / optional `IPFS_CID` — see script header. Registry: `TYmmnmgkxteBvH8u8LAfb8sCcs1Eph2tk2` ([TronScan](https://tronscan.org/#/contract/TYmmnmgkxteBvH8u8LAfb8sCcs1Eph2tk2)).
- **Base (EIP-8004):** `agentRegistry` = `eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, **`agentId: 21702`**. [Registry on Basescan](https://basescan.org/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) · [NFT view #21702](https://basescan.org/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/21702) (verify against contract ABI).
- **Public write-up:** [yieldagentx402.app/verification#content-addressing](https://yieldagentx402.app/verification#content-addressing) (after landing deploy).

## Adapters & Integrations

**89 live adapters** across 20+ chains — all `live-ready`, zero sim-fallback (verified 2026-04-05).

### Bridges & Cross-Chain (11 live)
| Bridge | Status | Protocol | Chains / Notes |
|--------|--------|----------|----------------|
| **LayerZero V2** | ✅ live | Omnichain messaging | ETH, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche, Solana, Filecoin — includes verify endpoint |
| **BitcoinOS** | ✅ live | Bitcoin zk-rollup | BTC ↔ EVM — trustless, zero-knowledge proofs |
| **Charms** | ✅ live | Bitcoin 1-click bridge | BTC ↔ multi-chain — `ADAPTER_CHARMS_*` set as CF secret |
| **NEAR Intents** | ✅ live | Defuse 1-Click relay | Multi-chain swap/bridge via solver-relay-v2.chaindefuser.com |
| **Secured Finance** | ✅ live | Filecoin bridge/lend | Filecoin only — `ADAPTER_SECURED_*` → GLIF fallback on intents |
| **Navi** | ✅ live | Sui liquidity bridge | Sui — `ADAPTER_NAVI_*` → /adapters/navi/quote |
| **Rhea Finance** | ✅ live | NEAR bridge routes | Rainbow Bridge, Allbridge — `/api/rhea/bridge/routes` |
| **Relay** | ✅ live | Cross-chain relayer | ETH, Base, Arbitrum, Optimism, Polygon, Zora + EVM L2s — fast finality, relay.link API |
| **Gas.zip** | ✅ live | Gas refuel bridge | 130+ chains — fund gas on any destination chain, gas.zip API |
| **Axelar** | ✅ live | Axelar GMP bridge | ETH, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB — axlUSDC/axlUSDT/axlETH — `ADAPTER_AXELAR_*` |
| **Rubic** | ✅ live | Cross-chain swap/bridge aggregator | Multi — routes via LayerZero, Stargate, etc. — `ADAPTER_RUBIC_*` |

### Swap Aggregators (11 live)
| Aggregator | Chain | Notes |
|------------|-------|-------|
| **1inch** | EVM | Classic v6 + Fusion Mode (quoter → sign → relayer) |
| **Jupiter** | Solana | Quote + swap via Solana intents |
| **Cetus** | Sui | Cetus Aggregator / Tide — USDC + FUSD pairs |
| **Rubic** | Multi | Rubic.exchange API v2 quoteBest |
| **OpenOcean** | EVM | v3 quote API — no key required |
| **SunSwap** | Tron | Via Tron intents + auto-solver |
| **ALEX** | Stacks | Dual-pool AMM (wSTX↔aBTC, wSTX↔wBTC) |
| **Bitflow sBTC** | Stacks | sBTC liquidity routing |
| **Ekubo** | Starknet | CLMM — largest Starknet DEX |
| **XRPL Native DEX** | XRP | Native XRPL order book |
| **Hermetica** | Stacks | Stacks yield / synthetic USD |

### Adapters by Chain (89 total)
| Chain | Adapters |
|-------|----------|
| **Ethereum** | Lido, bETH, Rocket Pool, Mantle, FraxETH, Swell, Renzo, EtherFi, EigenLayer |
| **EVM / Multi** | Euler, Aave, Silo, Katana, TheVault, Secured, Usual, Ethena, Curve, Bedrock, Compound V3, Convex, Pendle, Yearn, Beefy, Solv, Rubic, OpenOcean, 1inch, LayerZero, Relay, Gas.zip |
| **Stacks** | Zest, Hermetica, LISA, StackingDAO, ALEX, Velar, Arkadiko |
| **Solana** | Kamino, Jupiter, Marinade, Jito |
| **Sui** | Suilend, Navi, Scallop, Volo, Haedal, Cetus |
| **NEAR** | Rhea, Metapool, Linear |
| **Bitcoin** | Babylon, BitcoinOS, Charms, BOB, Citrea, Bitlayer, Bouncebit, Rootstock, Sovryn |
| **Starknet** | Endur, Vesu, Troves |
| **Injective** | Injective Lending, Hydro, Mito, Helix |
| **Cosmos** | Osmosis, Stride |
| **Tron** | JustLend, SunSwap |
| **BNB/BSC** | Venus, PancakeSwap |
| **XRP** | Sologenic, XRPL AMM |
| **Flare** | Firelight, EarnXRP, Morpho Flare |
| **Sei** | Clovis, YEI, Rubicon |
| **Filecoin** | GLIF, Secured (Axelar) |
| **Avalanche** | BENQI |
| **Aptos** | Amnis |
| **TON** | TONYield |
| **Hyperliquid** | Hyperliquid Vaults |

> Live count: `GET https://api.yieldagentx402.app/health` → `summary.adapters.total`

### TEE / Signing
- **Phala CVM (Intel TDX)** — hardware-attested enclave; resolves controlClass, validates policy, calls NEAR MPC
- **NEAR Chain Signatures MPC** — `v1.mpc-signer.near`; secp256k1 / ed25519; key never leaves MPC network
- **tee-signer** (Cloudflare Worker) — transport layer; forwards to Phala `/api/execute`

---

## Key docs

- `SOURCE_POLICY.md` — Canonical source rules; approved fixes only
- `YIELDAGENT_DEPLOY_READY_BUNDLE.md` — Full remediation bundle
- `WORKERS_VERIFICATION.md` — Worker verification (public fleet)
- `X402_ACTIVATION/` — x402 registration and runbooks
- `X402_ACTIVATION/UPTIME_MONITORING.md` — Status checks and alerts (api/health, TEE report; where to look when something’s broken)
- `E2E_VERIFY.md` — E2E flow (agent register, intent create, Glif on Filecoin)
- `shade-agent/README.md` — Shade Agent setup, local vs TEE mode, env vars
