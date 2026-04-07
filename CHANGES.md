# Change log

## 2026-04-08

- **Docs — x402 discovery counts:** [`docs/X402_DISCOVERY.md`](docs/X402_DISCOVERY.md) documents live `/.well-known/x402` **resource** totals (baseline 76 / 42 skills / 34 non-skill), verification `curl` + Python snippet, and a short checklist to refresh **README** when discovery changes. [`README.md`](README.md) x402 section links to it; Lighthouse bullet expanded for `filecoinProof*` + gateway verify paths; swap aggregators table includes **1inch** (12 live) and EVM/Multi row lists 1inch.

- **Docs — 1inch vs AllBridge:** Clarified in [`README.md`](README.md), [`docs/X402_DISCOVERY.md`](docs/X402_DISCOVERY.md) (*Related*), and [`docs/LIGHTHOUSE_X402_AUDIT_BRIEF.md`](docs/LIGHTHOUSE_X402_AUDIT_BRIEF.md) (*Out of scope*): **1inch** (classic + **Fusion** where enabled, `oneinch-evm` / `ADAPTER_ONEINCH_*`) and **AllBridge** are **both** live; AllBridge is an additional cross-chain path, not a doc-level replacement for 1inch.

## 2026-04-06

- **Skills catalog sync:** Root [`shared/skills-catalog.js`](shared/skills-catalog.js) aligned with [`agent402-clean-deploy/shared/skills-catalog.js`](agent402-clean-deploy/shared/skills-catalog.js) so anything importing repo-root `shared/` matches the 42-skill gateway/agent402 clean deploy.

- **Filecoin proof alias (x402 verify pin):** On successful Lighthouse upload after verify, [`agent402-clean-deploy/worker.js`](agent402-clean-deploy/worker.js) now sets `filecoinProofCid` / `filecoinProofUrl` (same CID/URL as IPFS proof; Lighthouse Filecoin-backed storage) and response headers `x-filecoin-proof-cid` plus CORS expose. [`gateway-clean-deploy/src/index.js`](gateway-clean-deploy/src/index.js) forwards the header; [`docs/LIGHTHOUSE_X402_AUDIT_BRIEF.md`](docs/LIGHTHOUSE_X402_AUDIT_BRIEF.md) and landing `/verification` + apply copy updated.

- **Landing copy (/verification, /apply):** `yieldagent-landing/worker.js` — settlement rails text aligned with compat workers + Filecoin; clarified execution vs x402 read APIs; Lighthouse receipt pinning tied to agent402 `LIGHTHOUSE_API_KEY` + fail-open behavior; DAO curl examples use `API_BASE`; apply page notes discover on public allowlist vs x402-gated market tools.

- **Landing 404 fix:** `yieldagent-landing/public/` had only Finder-renamed files (`index 4.html`, etc.) and no `index.html` / `app.js` / `og-image.png` / `treasury.html`, so Workers Assets served 404 at `/`. Restored canonical filenames by copying the latest numbered variants; redeploy `yieldagent-landing`.

- **Safe skills / market-data alignment:** `agent402-clean-deploy` — added `fetchSpotUsd` + `adapterSupportsAsset`; fixed `market-data` call order and `reason({ prompt }, env)` usage across DCA, debt, rebalance, gas-optimizer, yield-rotation, IL, stop-loss, leverage-yield; `parseLlmJson` accepts `reason()` objects and returns null on parse failure; `swap-tokens` prefers agent `/adapters/oneinch|openocean/quote` with `X-Internal-Key` then falls back to direct APIs; `fetchGatewayGet` forwards `X-Internal-Key` when set so production gateway x402 bypass applies to `/api/market/price` and other tool GETs; replaced four stub skills with discover-based or advisory implementations; **`gateway-clean-deploy`** — `oneinch-evm` adapter def + `ADAPTER_ONEINCH_*` URLs in `wrangler.jsonc`. Re-deploy: `bash deploy-all.sh` from repo root.

- **Lighthouse MVI:** Successful `agent402-clean-deploy` `POST /x402/verify` optionally pins a trimmed settlement+TEE receipt to Lighthouse (**`POST https://upload.lighthouse.storage/api/v0/add`**, multipart `file`, documented API); response adds `ipfsProofCid`, `ipfsProofUrl`, and header `x-ipfs-proof-cid`. (Replaced prior `node.lighthouse.storage` `upload-text` call.) **`gateway-clean-deploy`** (production `deploy-all.sh` step 2) mirrors the same `/api/x402/verify` proxy header + CORS expose as `yieldagent-api-gateway`. Landing `/verification` and `/apply` (docs) reference the flow. Secret: `wrangler secret put LIGHTHOUSE_API_KEY` (optional, non-blocking if unset).
- **Lighthouse test helper:** [`scripts/verify-x402-lighthouse.sh`](scripts/verify-x402-lighthouse.sh) — curl `POST /api/x402/verify` with a **fresh** payment header, prints `x-ipfs-proof-cid` and `ipfsProofUrl` when verify succeeds and `LIGHTHOUSE_API_KEY` is set on agent402.
- **Lighthouse secret (local):** [`scripts/set-lighthouse-secret.sh`](scripts/set-lighthouse-secret.sh) — secure prompt → `wrangler secret put LIGHTHOUSE_API_KEY` for `agent402-clean-deploy`; then redeploy agent402.

## 2026-04-07

- **Lighthouse E2E:** [`scripts/e2e-lighthouse-pin.mjs`](scripts/e2e-lighthouse-pin.mjs) — same multipart upload as agent402, then fetch via `gateway.lighthouse.storage`; [`docs/LIGHTHOUSE_E2E_VERIFICATION.md`](docs/LIGHTHOUSE_E2E_VERIFICATION.md) — standalone test, Worker log events (`ns: lighthouse`), full-stack verify checklist. Audit brief links to that doc.
- **Lighthouse observability:** agent402 `uploadReceiptToLighthouse` / `maybePinVerifyReceipt` emit structured `lighthouse` logs (`upload_ok`, `upload_http_error`, `upload_no_cid`, `verify_receipt_pinned`, `verify_receipt_pin_skipped`, etc.). (Renamed from misleading `uploadToFilecoin` — upload is Lighthouse IPFS API, not native Filecoin RPC.)
- **Lighthouse upload:** agent402 receipt pin now uses documented **`POST https://upload.lighthouse.storage/api/v0/add`** (multipart `file`); audit brief + README updated; Desktop `Lighthouse audit.md` refreshed. Deploy **Version ID** `952a3459-4cf7-4718-856c-c0caddf72ddc`.
- **Audit:** Added [`docs/LIGHTHOUSE_X402_AUDIT_BRIEF.md`](docs/LIGHTHOUSE_X402_AUDIT_BRIEF.md) — Cloudflare secret binding, code paths, flow, non-blocking semantics, local `curl` vs Worker egress, auditor checklist (no secret values).
- **Ops:** `LIGHTHOUSE_API_KEY` configured on Cloudflare Worker `agent402`; redeploy **Version ID** `b76e6881-b3ad-4996-a8d9-d558e4ca5373`.
- **Deploy fix:** Corrected `agent402-clean-deploy` skill imports from `../../shared/` to `../shared/` (`skills/analyze-risk.js`, `skills/index.js`) so Wrangler resolves `protocol-risk-db.js` and `skills-catalog.js` under `agent402-clean-deploy/shared/`.
