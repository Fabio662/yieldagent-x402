# Shade Agent Framework — Maintenance Guide
## Post-April 19 Support Notes

> **Why this file exists:** The upstream `NearDeFi/shade-agent-framework` repo is losing
> active support after April 19, 2026. This document pins every version, explains every
> component, and tells you exactly what to do to keep your Shade Agent running with zero
> dependency on the upstream repo.

---

## 1. What You Own

All source code is already saved in `Baseline #11/`. You do NOT need the upstream GitHub
repo to build, run, or redeploy.

| Directory | What it is |
|---|---|
| `shade-agent/` | Your deployed Phala CVM — the actual TEE agent |
| `shade-agent-framework/` | Snapshot of the upstream framework (read-only reference) |
| `tee-signer/` | Cloudflare Worker that proxies to the Shade Agent |

---

## 2. Pinned Versions (Do Not Change Without Testing)

### shade-agent/package.json — Production Dependencies

| Package | Pinned Version | What it does |
|---|---|---|
| `@neardefi/shade-agent-js` | **2.0.0** | Core SDK — ShadeClient, register, sign |
| `chainsig.js` | **1.1.14** | NEAR Chain Signatures MPC signing |
| `@hono/node-server` | **1.19.9** | HTTP server adapter |
| `hono` | **4.11.9** | Web framework (routes) |
| `ethers` | **6.16.0** | EVM address derivation |
| `dotenv` | **16.6.1** | Env var loading |
| `tsx` | **4.21.0** | TypeScript runner |
| `cors` | **2.8.6** | CORS middleware |

### shade-agent/package.json — Dev Dependencies

| Package | Pinned Version |
|---|---|
| `typescript` | **5.9.3** |
| `@types/node` | **20.19.33** |

### shade-agent-js (upstream library, v2.0.0 — already in node_modules)

| Package | Version |
|---|---|
| `@phala/dstack-sdk` | 0.5.7 |
| `@near-js/accounts` | 2.5.1 |
| `@near-js/crypto` | 2.5.1 |
| `@near-js/providers` | 2.5.1 |
| `@near-js/signers` | 2.5.1 |
| `@near-js/tokens` | 2.5.1 |
| `@near-js/transactions` | 2.5.1 |
| `@near-js/types` | 2.5.1 |
| `near-seed-phrase` | 0.2.1 |
| `@hackylabs/deep-redact` | 3.0.4 |

### Docker Image

| Tag | Digest |
|---|---|
| `cryptoblac/yieldagent-x402:latest` | `sha256:3753ba073172e7ec76ea31170afc7113acc591d99cf5ba2ab2448bce95453352` |
| `cryptoblac/yieldagent-x402:2026-04-04-v2` | `sha256:3753ba073172e7ec76ea31170afc7113acc591d99cf5ba2ab2448bce95453352` |

> **Important:** When rebuilding the Docker image after any code change, always push with
> both `latest` AND a dated tag so you can roll back:
> ```bash
> docker build --platform linux/amd64 \
>   -t cryptoblac/yieldagent-x402:latest \
>   -t cryptoblac/yieldagent-x402:2026-04-04 .
> docker push cryptoblac/yieldagent-x402:latest
> docker push cryptoblac/yieldagent-x402:2026-04-04
> ```

---

## 3. How the Shade Agent Works (Plain English)

```
Browser / Agent caller
        |
        v
Cloudflare Worker (tee-signer.yieldagentx402.app)
  - Auth check (x-internal-key)
  - Rate limiting (KV)
  - Routes POST /x402/sign → Phala CVM /api/execute
        |
        v
Phala CVM (Intel TDX — hardware TEE)
  shade-agent/src/routes/execute.ts
  - resolveControlClass() ← mode gate runs HERE inside enclave
  - validateAgainstPolicy() ← policy gate runs HERE inside enclave
  - agent.call({ methodName: "request_signature" })
        |
        v
NEAR Chain Signatures MPC (v1.mpc-signer.near)
  - Produces secp256k1 / ed25519 signature
  - Key never leaves MPC network
        |
        v
Returns { signature, address, resolvedControlClass, attestation }
```

---

## 4. Key Environment Variables

### shade-agent/.env (Phala CVM secrets)

| Variable | Description |
|---|---|
| `AGENT_CONTRACT_ID` | `ac-sandbox-yieldagent-x402.near` — your NEAR agent contract |
| `SPONSOR_ACCOUNT_ID` | NEAR account that funds new agent registrations |
| `SPONSOR_PRIVATE_KEY` | Private key for sponsor account (`ed25519:...`) |
| `PORT` | Server port (default: 3000) |
| `NEAR_RPC_URL` | Optional custom NEAR RPC (defaults to mainnet) |
| `PHALA_ATTESTATION` | Set by Phala at runtime — do not set manually |

### tee-signer wrangler secrets

| Variable | Description |
|---|---|
| `SHADE_AGENT_URL` | Phala CVM URL (`https://39f8f5b1...phala.network`) |
| `SHADE_AGENT_ENABLED` | `"true"` |
| `CHAIN_SIGNATURES_ENABLED` | `"true"` |
| `AGENT_CONTRACT_ID` | Same as above |
| `INTERNAL_KEY_SIGN` | Shared key between CF Worker and tee-signer |

---

## 5. Build & Deploy Procedure

### Every Time You Change shade-agent/ Code

```bash
# 1. From Baseline #11/shade-agent/
npm run build          # TypeScript compile — must pass with 0 errors

# 2. Build Docker image (linux/amd64 required for Phala)
docker build --platform linux/amd64 \
  -t cryptoblac/yieldagent-x402:latest \
  -t cryptoblac/yieldagent-x402:YYYY-MM-DD .

# 3. Push to Docker Hub
docker push cryptoblac/yieldagent-x402:latest
docker push cryptoblac/yieldagent-x402:YYYY-MM-DD

# 4. Go to Phala Cloud dashboard → your CVM → Update → pull new image
#    CVM will restart and re-register with NEAR contract automatically
```

### Every Time You Change tee-signer/ Code

```bash
# From Baseline #11/tee-signer/
npx wrangler deploy
```

---

## 6. How to Maintain @neardefi/shade-agent-js Without the Upstream Repo

The library source is in `shade-agent-framework/shade-agent-js/src/`. You own this code.
If you ever need to patch it:

```bash
# 1. Make changes in shade-agent-framework/shade-agent-js/src/

# 2. Build the library
cd shade-agent-framework/shade-agent-js
npm run build        # outputs to dist/

# 3. Point shade-agent to local copy instead of npm
# In shade-agent/package.json change:
#   "@neardefi/shade-agent-js": "2.0.0"
# to:
#   "@neardefi/shade-agent-js": "file:../shade-agent-framework/shade-agent-js"

# 4. Re-install and rebuild
cd ../shade-agent
npm install
npm run build
```

### Key files in shade-agent-js you might need to patch

| File | What it does |
|---|---|
| `src/utils/agent.ts` | ShadeClient.create(), register(), call() |
| `src/utils/tee.ts` | TEE attestation generation |
| `src/utils/near.ts` | NEAR account setup, funding |
| `src/utils/attestation-transform.ts` | Converts Phala attestation → contract format |
| `src/api.ts` | Public API surface |

---

## 7. How to Maintain the Agent Contract

Source: `shade-agent/agent-contract/` (Rust / NEAR contract)

The contract is already deployed at `ac-sandbox-yieldagent-x402.near`. You only need to
redeploy the contract if you change its logic.

```bash
# Install cargo-near if not already installed
cargo install cargo-near

# Build the contract
cd shade-agent/agent-contract
cargo near build --release

# Deploy (requires NEAR CLI and account with keys)
near deploy ac-sandbox-yieldagent-x402.near \
  --wasmFile target/near/agent_contract.wasm

# After deploying new contract, re-approve measurements
shade approve-measurements  # or do it manually via NEAR CLI
```

### Key contract functions

| Function | Who calls it | What it does |
|---|---|---|
| `register_agent` | Shade Agent on startup | Registers TEE agent after attestation check |
| `request_signature` | Shade Agent | MPC signing via NEAR Chain Signatures |
| `approve_measurements` | Owner only | Approves new agent code after update |
| `approve_ppids` | Owner only | Approves specific Phala hardware |
| `whitelist_agent_for_local` | Owner only | For local dev mode |

---

## 8. How Agent Re-Registration Works

When the Phala CVM restarts (e.g. after you push a new Docker image), the agent:

1. Generates a fresh ephemeral NEAR keypair (in-memory only)
2. Calls `register_agent` on the NEAR contract with a real TEE attestation
3. Contract verifies: attestation valid + measurements match approved list
4. Agent is registered → can now call `request_signature`
5. Every 6 days, the agent re-registers automatically (see `src/index.ts`)

**If registration fails:**
- Check `AGENT_CONTRACT_ID` matches the deployed contract
- Check `SPONSOR_ACCOUNT_ID` has enough NEAR balance (needs ~0.3 NEAR)
- Check approved measurements match the Docker image — if you changed code and pushed
  a new image, you must run `shade approve-measurements` or the new agent won't register

---

## 9. Phala CVM Configuration

Your agent runs on Phala's `tdx.small` (1 vCPU, 2 GB RAM) using DStack `0.5.7`.

**To update after framework deprecation:**
- The DStack version is pinned in `shade-agent/phala.toml`
- Phala will continue supporting existing DStack versions after deprecation
- You do NOT need to upgrade DStack unless Phala removes old versions
- If you must upgrade: check `phala.toml` → update version → rebuild image → redeploy

**Your phala.toml is at:** `shade-agent/phala.toml`

---

## 10. Enclave Routes Added by YieldAgent

These are YOUR custom routes added to the upstream template:

| Route | File | What it does |
|---|---|---|
| `POST /api/execute` | `src/routes/execute.ts` | Full enclave reasoning + MPC sign |
| *(existing)* `POST /api/sign` | `src/routes/sign.ts` | Raw MPC sign (no mode gate) |
| *(existing)* `POST /api/derive-address` | `src/routes/deriveAddress.ts` | Derive EVM address |
| *(existing)* `GET /api/info` | `src/index.ts` | Agent status + attestation |

The `/api/execute` route is the critical one — it runs `resolveControlClass` and
`validateAgainstPolicy` inside the TEE before allowing any MPC signing.

---

## 11. Emergency Procedures

### Freeze all signing immediately
```bash
# POST to tee-signer with internal key
curl -X POST https://tee-signer.yieldagentx402.app/wallets/freeze \
  -H "x-internal-key: YOUR_INTERNAL_KEY" \
  -H "content-type: application/json" \
  -d '{"walletId": "compat-attest-wallet"}'
```

### Roll back Docker image to previous version
```bash
# On Phala dashboard: update CVM → set image to dated tag
# e.g. cryptoblac/yieldagent-x402:2026-04-04
```

### Force re-registration after contract update
```bash
# Restart the Phala CVM from the dashboard
# The agent init loop in src/index.ts handles registration automatically
```

---

## 12. Dependency Update Policy (Post-April 19)

Since upstream is no longer maintained, only update a dependency if:

1. There is a **security CVE** — check `npm audit` monthly
2. Phala **removes DStack 0.5.7** support — update `@phala/dstack-sdk`
3. NEAR **removes v2.5.x RPC support** — update `@near-js/*` packages

**Never run `npm update` blindly.** Always update one package at a time and rebuild + test.

```bash
# Check for security issues monthly
npm audit

# Update only a specific package with exact version
npm install @neardefi/shade-agent-js@2.1.0 --save-exact
```

---

*Last updated: 2026-04-04 | Baseline #11*
