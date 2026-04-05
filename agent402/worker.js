/**
 * YieldAgent TEE Brain (agent.yieldagentx402.app)
 *
 * The execution + verification layer. Handles:
 *   - x402 payment verification with NEAR AI attestation proof
 *   - TEE attestation reports from NEAR AI Cloud (Intel SGX)
 *   - Bridge/adapter/integration requests via NEAR AI agent (live: @yieldagent_x402)
 *   - Stake/unstake operations via NEAR AI agent
 *
 * No Python. No proxy. This IS the brain.
 *
 * ENV (wrangler.jsonc vars):
 *   NEAR_AI_URL        = https://cloud-api.near.ai
 *   NEAR_AI_AGENT_ID   = REPLACE_WITH_NEAR_AGENT_ID
 *   NEAR_AI_AGENT_HASH = 9b6179895328155b199bf2ffd97dc3a19dfdad026decd140df5e7830d4a5296d
 *
 * SECRETS (wrangler secret put):
 *   NEAR_AI_API_KEY    = sk-...
 */

import { dispatchAgentSkill, AVAILABLE_SKILLS } from "./skills/index.js";
import { attachVerificationBinding, parseJsonBodyWithRequestHash } from "./verification-binding.js";
import { PUBLIC_API_CONTRACT_VERSION } from "../shared/public-contract.js";

const NEAR_AI_TIMEOUT_MS = 15000;
const ATTESTATION_MAX_AGE_MS = 5 * 60 * 1000;
const AGENT_MESSAGE_MAX_CHARS = 6000;
const RPC_CIRCUIT_THRESHOLD = 3;
const RPC_CIRCUIT_OPEN_MS = 30 * 1000;
const RPC_TOTAL_BUDGET_MS = 12 * 1000;
// [d5225908] Stacks STX settlement: poll Hiro while tx indexes / confirms (12s total, 2.5s between attempts)
const STACKS_SETTLEMENT_POLL_INTERVAL_MS = 2500;

// [M1] Attestation cache — 4-min TTL, within 5-min freshness spec
let _attestCache   = null;
let _attestCacheTs = 0;
const ATTEST_CACHE_TTL_MS = 4 * 60 * 1000;
const _rpcCircuit = new Map();

// ── Timing-safe comparison — [SEC] defense-in-depth for hash comparisons ────
// Uses crypto.subtle SHA-256 digest XOR to prevent JIT string short-circuit
// timing leaks. Applied to all mrEnclave comparisons.
async function timingSafeEqualAsync(a, b) {
  try {
    const enc = new TextEncoder();
    const [da, db] = await Promise.all([
      crypto.subtle.digest("SHA-256", enc.encode(String(a ?? ""))),
      crypto.subtle.digest("SHA-256", enc.encode(String(b ?? ""))),
    ]);
    const va = new Uint8Array(da);
    const vb = new Uint8Array(db);
    let diff = 0;
    for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// [High 4] Body size cap — byte-based 64 KB limit for POST routes
async function safeJsonBody(request, maxBytes = 65536) {
  try {
    const contentType = String(request.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("application/json")) return null;
    const text = await request.text();
    if (new TextEncoder().encode(text).length > maxBytes) return null;
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

function requireJsonContentType(request, corsHeaders) {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.includes("application/json")) {
    return json({ success: false, error: "Content-Type must be application/json" }, corsHeaders, 415);
  }
  return null;
}

// ── PaymentReplayDO ───────────────────────────────────────────────────────────
// Single-threaded Durable Object that provides mathematically atomic replay
// protection for x402 payment proofs. Because DO executes one request at a
// time, there is no concurrency — a get+put here is guaranteed sequential.
// No KV race condition is possible.
const PENDING_CLAIM_TTL_MS = 5 * 60 * 1000; // 5 min — stale pending claims can be re‑claimed

export class PaymentReplayDO {
  constructor(state, env) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const url  = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const { paymentDigest } = body;

    if (!paymentDigest) {
      return Response.json({ error: "paymentDigest required" }, { status: 400 });
    }

    const key = `replay:${paymentDigest}`;

    // ── /replay/claim ── atomic: check + write in single-threaded execution ──
    if (url.pathname === "/replay/claim" && request.method === "POST") {
      const existing = await this.storage.get(key);
      if (existing) {
        const status = typeof existing === "object" ? existing.status : existing;
        const claimedAt = typeof existing === "object" ? existing.claimedAt : null;
        if (status === "pending" && claimedAt) {
          const age = Date.now() - new Date(claimedAt).getTime();
          if (age > PENDING_CLAIM_TTL_MS) {
            await this.storage.delete(key);
            await this.storage.put(key, { status: "pending", claimedAt: new Date().toISOString() });
            return Response.json({ claimed: true });
          }
        }
        return Response.json({ claimed: false, status: existing });
      }
      await this.storage.put(key, { status: "pending", claimedAt: new Date().toISOString() });
      return Response.json({ claimed: true });
    }

    // ── /replay/confirm ── promote pending → confirmed after settlement ───────
    if (url.pathname === "/replay/confirm" && request.method === "POST") {
      await this.storage.put(key, { status: "confirmed", confirmedAt: new Date().toISOString() });
      return Response.json({ ok: true });
    }

    // ── /replay/release ── clear a pending claim after downstream failure ─────
    // Prevents legitimate proofs from being stranded if TEE/RPC/settlement checks
    // fail after the atomic claim succeeds. Confirmed claims are never released.
    if (url.pathname === "/replay/release" && request.method === "POST") {
      const existing = await this.storage.get(key);
      if (existing?.status === "pending") {
        await this.storage.delete(key);
      }
      return Response.json({ released: true, priorStatus: existing?.status || null });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = buildCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const privateRoutes = new Set([
      "/x402/verify",
      "/tee/report",
      "/tee/verify",
      "/tee/sign",
      "/tee/sign-intent",
      "/tee/verify-settlement",
      "/tee/verify-lz",
      "/tee/verify-intent",
      // [H3 FIX] Agent execution routes require X-Internal-Key to prevent credit abuse
      "/bridge",
      "/adapters",
      "/stake",
      "/unstake",
      // [H-2 FIX] Integration routes also require X-Internal-Key
      "/integrations",
      "/skills",
    ]);

    const isPrivate = privateRoutes.has(path)
      || path.startsWith("/bridge/")
      || path.startsWith("/adapters/")
      || path === "/stake"
      || path === "/unstake"
      || path.startsWith("/integrations/")
      || path.startsWith("/skills/");
    if (isPrivate) {
      // [G1] Accept INTERNAL_KEY_VERIFY (preferred) or INTERNAL_SHARED_KEY (compat),
      // including _PREV variants for zero-downtime key rotation.
      const provided = request.headers.get("X-Internal-Key") || "";
      const candidates = [
        env.INTERNAL_KEY_VERIFY,
        env.INTERNAL_SHARED_KEY,
        env.INTERNAL_KEY_VERIFY_PREV,
        env.INTERNAL_SHARED_KEY_PREV,
      ].map(k => String(k || "").trim()).filter(Boolean);
      let authorized = false;
      if (provided && candidates.length) {
        const enc = new TextEncoder();
        const providedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(provided)));
        for (const candidate of candidates) {
          const candidateHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(candidate)));
          let diff = 0;
          for (let i = 0; i < providedHash.length; i++) diff |= providedHash[i] ^ candidateHash[i];
          if (diff === 0) { authorized = true; break; }
        }
      }
      if (!authorized) {
        return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
    }

    try {
      if (path === "/health") return handleHealth(env, corsHeaders);

      if (path === "/x402/verify" && request.method === "POST") {
        // [G5] Post-auth rate limiters — per-IP + optional global cap (REPLAY_KV). 429 before attestation + RPC.
        const rlResp = await checkAgent402VerifyRateLimits(request, env, corsHeaders);
        if (rlResp) return rlResp;
        return handleX402Verify(request, env, corsHeaders);
      }

      if (path === "/tee/report") return handleTeeReport(request, env, corsHeaders);
      if (path === "/tee/verify" && request.method === "POST") {
        return handleTeeVerify(request, env, corsHeaders);
      }

      if (path.startsWith("/bridge/") || path.startsWith("/integrations/")) {
        // GET on /integrations/*/status — live status check, no POST required
        if (request.method === "GET" && path.match(/^\/integrations\/[^/]+\/status$/)) {
          return handleIntegrationStatus(path, env, corsHeaders);
        }
        // POST /bridge/layerzero/quote — real LZ v2 fee estimation
        if (request.method === "POST" && path === "/bridge/layerzero/quote") {
          return handleLayerZeroQuoteDirect(request, env, corsHeaders);
        }
        if (request.method !== "POST") return json({ success: false, error: "Method Not Allowed" }, corsHeaders, 405);
        return handleAgentRequest(request, env, corsHeaders, path);
      }

      if (path === "/adapters/jupiter/quote" && request.method === "POST") {
        return handleJupiterQuote(request, env, corsHeaders);
      }

      if (path === "/adapters/openocean/quote" && request.method === "POST") {
        return handleOpenOceanQuote(request, env, corsHeaders);
      }
      if (path === "/adapters/rubic/quote" && request.method === "POST") {
        return handleRubicQuote(request, env, corsHeaders);
      }

      if (path === "/adapters/allbridge/quote" && request.method === "POST") {
        return handleAllBridgeQuote(request, env, corsHeaders);
      }
      if (path === "/adapters/allbridge/plan" && request.method === "POST") {
        return handleAllBridgePlan(request, env, corsHeaders);
      }

      if (path.startsWith("/adapters/")) {
        if (request.method !== "POST") return json({ success: false, error: "Method Not Allowed" }, corsHeaders, 405);
        const adapterParts = path.split("/").filter(Boolean);
        const adapterName = adapterParts[1];
        const adapterAction = adapterParts[2]; // "quote" or "plan"
        if (adapterAction === "quote" || adapterAction === "plan") {
          return handleAdapterLive(request, env, corsHeaders, adapterName, adapterAction);
        }
        return handleAgentRequest(request, env, corsHeaders, path);
      }

      if ((path === "/stake" || path === "/unstake") && request.method === "POST") {
        return handleAgentRequest(request, env, corsHeaders, path);
      }

      // ── Skills: GET /skills (list); POST /skills/:skillId — both gated by X-Internal-Key above ──
      if (path === "/skills" && request.method === "GET") {
        return new Response(JSON.stringify({ skills: AVAILABLE_SKILLS }, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
        });
      }

      if (path.match(/^\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/) && request.method === "POST") {
        const denyCt = requireJsonContentType(request, corsHeaders);
        if (denyCt) return denyCt;
        const body = await safeJsonBody(request);
        if (body === null) {
          return json({ error: "Invalid or empty JSON body (max 64KB)" }, corsHeaders, 400);
        }
        const skillId = path.slice("/skills/".length);
        if (skillId.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillId)) {
          return json({ success: false, error: "Invalid skill id format" }, corsHeaders, 400);
        }
        if (!AVAILABLE_SKILLS.includes(skillId)) {
          return json({ success: false, error: "Unknown skill", skillId }, corsHeaders, 404);
        }
        const result = await dispatchAgentSkill(skillId, body, env);
        const attestation = await teeAttestationForLiveRoute(env, `skills/${skillId}`);
        const payload =
          result !== null && typeof result === "object" && !Array.isArray(result)
            ? { ...result, ...(attestation ? { teeAttestation: attestation } : {}) }
            : { data: result, ...(attestation ? { teeAttestation: attestation } : {}) };
        return new Response(JSON.stringify(payload, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
        });
      }

      if (path === "/tee/sign" && request.method === "POST") {
        return handleTeeManagedSign(request, env, corsHeaders);
      }

      if (path === "/tee/sign-intent" && request.method === "POST") {
        return handleSignIntent(request, env, corsHeaders);
      }

      if (path === "/tee/verify-settlement" && request.method === "POST") {
        return handleVerifySettlement(request, env, corsHeaders);
      }

      if (path === "/tee/verify-lz" && request.method === "POST") {
        return handleVerifyLayerZero(request, env, corsHeaders);
      }

      if (path === "/tee/verify-intent" && request.method === "POST") {
        return handleVerifyIntent(request, env, corsHeaders);
      }

      return json({
        error: "Unknown endpoint",
        service: "yieldagent-tee-brain",
        available: [
          "/health",
          "/x402/verify (POST)",
          "/tee/report",
          "/tee/verify (POST)",
          "/tee/sign (POST — TEE-attested managed wallet signing, called by tee-signer)",
          "/tee/sign-intent (POST)",
          "/tee/verify-settlement (POST — cross-chain: near, bitcoin, stacks, sui, starknet, + 15 EVM chains)",
          "/tee/verify-lz (POST — LayerZero cross-chain message verification)",
          "/tee/verify-intent (POST — full intent lifecycle validation with TEE proof)",
          "/bridge/* (POST)",
          "/integrations/* (POST)",
          "/adapters/*/quote (POST)",
          "/adapters/*/plan (POST)",
          "/stake (POST)",
          "/unstake (POST)",
          "/skills (GET — list skill ids)",
          "/skills/:skillId (POST + JSON body — same internal auth as /adapters)",
        ],
      }, corsHeaders, 404);

    } catch (err) {
      return json({ error: "Agent error", message: "Internal error" }, corsHeaders, 500); // [L2]
    }
  },
};

// ============================================================================
// [G5] Post-auth rate limiters for /x402/verify — per-IP + optional global ceiling.
// Route is internal-key gated; limits mitigate leaked-key abuse and hot-spot cost.
// ============================================================================

async function checkAgent402VerifyRateLimits(request, env, corsHeaders) {
  const globalResp = await checkAgent402GlobalVerifyRateLimit(env, corsHeaders);
  if (globalResp) return globalResp;
  return checkAgent402PerIpVerifyRateLimit(request, env, corsHeaders);
}

async function checkAgent402GlobalVerifyRateLimit(env, corsHeaders) {
  const cap = Number(env.AGENT402_VERIFY_GLOBAL_PER_MINUTE || "0");
  if (!Number.isFinite(cap) || cap <= 0 || !env.REPLAY_KV) return null;
  const windowMs = 60_000;
  const bucket = `rl:verify:global:${Math.floor(Date.now() / windowMs)}`;
  try {
    const raw = await env.REPLAY_KV.get(bucket);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= cap) {
      return new Response(JSON.stringify({
        success: false,
        verified: false,
        error: "Global verify rate limit exceeded",
        failure: "rate_limit_global",
        retryAfter: Math.ceil(windowMs / 1000),
      }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(Math.ceil(windowMs / 1000)), ...corsHeaders } });
    }
    await env.REPLAY_KV.put(bucket, String(count + 1), { expirationTtl: Math.ceil(windowMs / 1000) + 5 });
  } catch { /* KV failure — don't block */ }
  return null;
}

async function checkAgent402PerIpVerifyRateLimit(request, env, corsHeaders) {
  if (!env.REPLAY_KV) return null;
  const limit = Number(env.AGENT402_VERIFY_RATE_LIMIT || 60);
  const windowMs = 60_000;
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "unknown";
  const bucket = `rl:verify:${ip}:${Math.floor(Date.now() / windowMs)}`;
  try {
    const raw = await env.REPLAY_KV.get(bucket);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= limit) {
      return new Response(JSON.stringify({
        success: false,
        verified: false,
        error: "Rate limit exceeded on verify endpoint",
        failure: "rate_limit_ip",
        retryAfter: Math.ceil(windowMs / 1000),
      }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(Math.ceil(windowMs / 1000)), ...corsHeaders } });
    }
    await env.REPLAY_KV.put(bucket, String(count + 1), { expirationTtl: Math.ceil(windowMs / 1000) + 5 });
  } catch { /* KV failure — don't block */ }
  return null;
}

// ============================================================================
// /health
// ============================================================================

async function handleHealth(env, corsHeaders) {
  const nearAi = await checkNearAi(env);

  // [NEW-L-02] Surface critical bindings — payment replay fails closed when absent
  const replayDo = !!env.REPLAY_DO;
  const replayKv = !!env.REPLAY_KV;
  const bindingsOk = replayDo && replayKv;

  return json({
    service: "yieldagent-tee-brain",
    publicApiContractVersion: PUBLIC_API_CONTRACT_VERSION,
    status: bindingsOk ? "operational" : "degraded",
    nearAi,
    agent: {
      id: env.NEAR_AI_AGENT_ID || null,
      hashConfigured: !!env.NEAR_AI_AGENT_HASH,  // [L1] Omit raw hash from public /health
      configured: !!(env.NEAR_AI_API_KEY && env.NEAR_AI_AGENT_ID),
    },
    bindings: {
      replayDo,  // PaymentReplayDO — atomic replay claim
      replayKv,  // REPLAY_KV — audit + pre-check
    },
    timestamp: new Date().toISOString(),
  }, corsHeaders);
}

async function checkNearAi(env) {
  const nearAiUrl = env.NEAR_AI_URL || "https://cloud-api.near.ai";
  try {
    const headers = {};
    if (env.NEAR_AI_API_KEY) headers["Authorization"] = `Bearer ${env.NEAR_AI_API_KEY}`;
    const resp = await fetch(`${nearAiUrl}/v1/attestation/report`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { status: "down", code: resp.status };
    const data = await resp.json().catch(() => null);
    const mr = data?.gateway_attestation?.info?.mr_aggregated
            || data?.info?.mr_aggregated
            || null;
    return {
      status: "up",
      attestation: !!mr,
      mrEnclave: mr ? mr.slice(0, 16) + "..." : null,
      signingAddress: data?.gateway_attestation?.signing_address || null,
    };
  } catch {
    return { status: "unreachable" };
  }
}

// ============================================================================
// /x402/verify — payment verification with TEE attestation proof
// ============================================================================

async function handleX402Verify(request, env, corsHeaders) {
  const verifyStart = Date.now();
  const ctErr = requireJsonContentType(request, corsHeaders);
  if (ctErr) return ctErr;
  const body = await safeJsonBody(request, 65536);
  if (body === null) {
    return json({ success: false, error: "Invalid or too large JSON body (max 64 KB)" }, corsHeaders, 413);
  }

  const token = String(body?.paymentHeader || "").trim();
  if (!token) {
    return json({ success: false, verified: false, error: "Empty payment header" }, corsHeaders, 400);
  }

  const isValidFormat = token.length >= 16 && (
    /^[A-Fa-f0-9]{32,}$/.test(token) ||
    /^[A-Za-z0-9+/=]{20,}$/.test(token) ||
    /^(0x|near:|pay_|x402_|sk-|pk-)/.test(token) ||
    /^[A-Za-z0-9_.-]{16,}$/.test(token)
  );
  if (!isValidFormat) {
    return json({ success: false, verified: false, error: "Invalid payment header format" }, corsHeaders, 400);
  }

  // [G14] Optional session binding — when X402_SESSION_BINDING_ENABLED is true,
  // include session ID in the payment digest so proofs are tied to a session.
  const sessionId = String(body?.sessionId || "").trim();
  const sessionBindingEnabled = String(env.X402_SESSION_BINDING_ENABLED || "").toLowerCase() === "true";
  if (sessionBindingEnabled && !sessionId) {
    return json({ success: false, verified: false, error: "Session ID required (x402 session binding enabled)" }, corsHeaders, 400);
  }

  const pricingFloor = parseGatewayPricingFloor(body);

  // ── [FIX-1: REPLAY FAIL-CLOSED] ───────────────────────────────────────────
  const resource = String(body?.resource || "");
  const method   = String(body?.method || "GET").toUpperCase();
  const digestInput = sessionBindingEnabled && sessionId
    ? `x402:${token}:${resource}:${method}:${sessionId}`
    : `x402:${token}:${resource}:${method}`;
  const paymentDigest = await sha256Hex(digestInput);
  const replayResult  = await checkReplay(env, paymentDigest);
  if (replayResult.replayed) {
    const isInfra = replayResult.failure === "replay_kv_missing" || replayResult.failure === "replay_kv_error";
    return json({
      success: false, verified: false,
      error:   isInfra ? "Replay protection unavailable — payment blocked" : "Payment proof already used",
      failure: replayResult.failure || "replayed_proof",
      paymentDigest,
      hint:    "Payment was already verified. If you just submitted, your intent may have been created — try GET /api/intents to list intents.",
      recordedAt: replayResult.recordedAt || undefined,
    }, corsHeaders, isInfra ? 503 : 409);
  }

  // ── [ATOMIC REPLAY CLAIM — PaymentReplayDO] ─────────────────────────────
  // Single-threaded DO execution makes this get+put mathematically atomic.
  // No concurrent request can pass this gate with the same paymentDigest.
  // checkReplay + recordReplay (KV) remain as the durable audit log below.
  let claimedReplay = false;
  if (env.REPLAY_DO) {
    try {
      const doId   = env.REPLAY_DO.idFromName("replay-global");
      const doStub = env.REPLAY_DO.get(doId);
      const claim  = await doStub.fetch("https://do/replay/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentDigest }),
      });
      const claimResult = await claim.json();
      if (!claimResult.claimed) {
        return json({
          success: false, verified: false,
          error: "Payment proof already used or in-flight",
          failure: "replay_claimed", paymentDigest,
        }, corsHeaders, 409);
      }
      claimedReplay = true;
    } catch (err) {
      // [BLOCKER 1 FIX] Fail-closed: if REPLAY_DO is unavailable, reject the
      // request rather than falling through to non-atomic KV. Availability drops
      // but double-spend under infra degradation becomes impossible.
      // A legitimate payment during DO downtime gets 503 and can retry.
      console.error(JSON.stringify({ ns: "x402", event: "replay_do_unavailable", error: err?.message, ts: new Date().toISOString() }));
      return json({
        success: false, verified: false,
        error: "Payment verification unavailable — replay gate offline. Please retry.",
        failure: "replay_do_unavailable",
      }, corsHeaders, 503);
    }
  }

  const releaseReplayAndRespond = async (payload, status) => {
    if (claimedReplay && env.REPLAY_DO) {
      try {
        const doId   = env.REPLAY_DO.idFromName("replay-global");
        const doStub = env.REPLAY_DO.get(doId);
        await doStub.fetch("https://do/replay/release", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paymentDigest }),
        });
      } catch (err) {
        console.error(JSON.stringify({ ns: "x402", event: "replay_release_failed", error: err?.message, ts: new Date().toISOString() }));
      }
    }
    return json(payload, corsHeaders, status);
  };

  // ── [FIX-2: TEE GATE] ─────────────────────────────────────────────────────
  // [C1] X402_TEE_REQUIRED=false allows graceful downgrade (e.g. dev/staging without NEAR AI)
  // [Gap 2] Request-bound attestation: generate nonce per verification request
  const teeRequired = String(env.X402_TEE_REQUIRED ?? "true").toLowerCase() !== "false";
  const nonce64 = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
  const attestation = await fetchAndValidateAttestation(env, { nonce: nonce64 });

  if (teeRequired && !attestation.valid) {
    console.error(JSON.stringify({ ns: "x402", event: "tee_gate_blocked", reason: attestation.reason, ts: new Date().toISOString() }));
    return releaseReplayAndRespond({
      success: false, verified: false,
      error:   "TEE attestation unavailable — payment cannot be verified",
      failure: "tee_attestation_missing",
      reason:  attestation.reason,
    }, 503);
  }

  if (!teeRequired && !attestation.valid) {
    console.warn(JSON.stringify({ ns: "governance", event: "tee_gate_degraded", reason: attestation.reason, ts: new Date().toISOString() }));
  }

  // ── [STEP 4: ON-CHAIN SETTLEMENT VERIFICATION] ────────────────────────────
  // Detect which rail the payment token belongs to (Base EVM tx hash or NEAR
  // tx hash), then verify the actual on-chain transaction:
  //   Base: eth_getTransactionReceipt + ERC20 Transfer log parsing
  //         → recipient, asset contract, and amount all checked
  //   NEAR: EXPERIMENTAL_tx_status (no sender ID required) + fallback tx RPC
  //         → receiver, Transfer action deposit, yoctoNEAR amount all checked
  // Returns settled:false with a specific failure code on any mismatch.
  // ──────────────────────────────────────────────────────────────────────────
  // [C-SC1 FIX] Read chain hint forwarded by stacks-compat-worker via X-Payment-Chain header.
  // Stacks txids are 0x+64hex — identical format to Base EVM hashes — so detectRail alone
  // cannot distinguish them. The compat worker sets the hint; Base/NEAR clients never do,
  // so existing flows are completely untouched.
  //
  // [Plan C] Multi-chain routing: resolve CAIP-2 or short-key hint → unified rail dispatcher.
  //   - Hint can be CAIP-2 (e.g. "eip155:42161") or short-key (e.g. "arb") or name (e.g. "stacks")
  //   - EVM chains (including FIL/FEVM) → verifyEvmSettlement(chainKey)
  //   - Base v2 preserved on its own dedicated verifyBaseSettlement()
  //   - SOL → verifySolanaSettlement, TRX → verifyTronSettlement
  //   - No hint + EVM tx hash (0x+64hex) → detectRail() → "base" (backward compat)
  const chainHintRaw = (body?.chain || request.headers?.get?.("x-payment-chain") || "").toLowerCase();
  let resolvedHint   = CAIP2_TO_CHAIN_KEY[chainHintRaw] || chainHintRaw;
  if (resolvedHint === "rsk") resolvedHint = "rootstock";

  const rail = resolvedHint === "stacks"                             ? "stacks"
             : resolvedHint === "sol" || resolvedHint === "solana"   ? "sol"
             : resolvedHint === "trx" || resolvedHint === "tron"     ? "trx"
             : resolvedHint === "near"                               ? "near"
             : EVM_CHAIN_KEYS.has(resolvedHint)                      ? `evm:${resolvedHint}`
             : detectRail(token);  // fallback: "base" (0x+64hex), "near" (base58), null

  if (!rail) {
    return releaseReplayAndRespond({
      success: false, verified: false,
      error: "Unrecognized payment token format — cannot determine settlement rail",
      failure: "unknown_rail",
    }, 400);
  }

  // [G10] Settlement cache — policy version + rail + digest (bust cache when verification rules change).
  const settlementPolicyVersion = String(env.X402_SETTLEMENT_POLICY_VERSION || "1").trim().slice(0, 32) || "1";
  const settlementCacheKey = `settle:${settlementPolicyVersion}:${rail}:${paymentDigest}`;
  let settlement = await getSettlementCache(env, settlementCacheKey);
  let settlementFromCache = !!settlement;
  if (!settlement) {
    if      (rail === "stacks")        settlement = await verifyStacksSettlement(token, env, pricingFloor);
    else if (rail === "near")          settlement = await verifyNearSettlement(token, env, body, pricingFloor);
    else if (rail === "base" || rail === "evm:base")   settlement = await verifyBaseSettlement(token, env, pricingFloor);
    else if (rail.startsWith("evm:"))  settlement = await verifyEvmSettlement(token, env, rail.slice(4), pricingFloor);
    else if (rail === "sol")           settlement = await verifySolanaSettlement(token, env, pricingFloor);
    else if (rail === "trx")           settlement = await verifyTronSettlement(token, env, pricingFloor);
    if (settlement?.settled) {
      await putSettlementCache(env, settlementCacheKey, settlement);
    }
  }

  if (!settlement.settled) {
    return releaseReplayAndRespond({
      success: false, verified: false,
      error:   settlement.error   || "Settlement not confirmed on-chain",
      failure: settlement.failure || "settlement_missing",
      rail,
    }, 402);
  }

  // All gates passed — persist replay record before returning verified.
  // Enterprise payment gating should fail closed if replay persistence fails.
  const replayWrite = await recordReplay(env, paymentDigest, token);
  // Promote DO pending → confirmed now that KV audit log is written
  if (env.REPLAY_DO) {
    try {
      const doId   = env.REPLAY_DO.idFromName("replay-global");
      const doStub = env.REPLAY_DO.get(doId);
      await doStub.fetch("https://do/replay/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentDigest }),
      });
    } catch { /* best-effort — KV record is the authoritative log */ }
  }
  if (!replayWrite.ok) {
    return releaseReplayAndRespond({
      success: false,
      verified: false,
      error: "Replay protection persistence failed — payment blocked",
      failure: replayWrite.failure || "replay_record_failed",
      paymentDigest,
    }, 503);
  }

  // [G15] Structured event — successful x402 verification.
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: "agent402", level: "info",
    event: "x402_verified",
    rail: settlement.rail, chain: settlement.chain,
    txHash: settlement.txHash, amount: settlement.settledAmount,
    latencyMs: Date.now() - verifyStart,
    teeAttested: attestation.valid, cached: settlementFromCache,
  }));

  const verifiedAt = new Date().toISOString();
  const responseBody = {
    success:          true,
    verified:         true,
    ok:               true,
    mode:             "settlement-verified+tee-attested",
    service:          "yieldagent-tee-brain",
    rail:             settlement.rail,
    chain:            settlement.chain,
    txHash:           settlement.txHash,
    recipientMatch:   settlement.recipientMatch,
    assetMatch:       settlement.assetMatch,
    amountMatch:      settlement.amountMatch,
    settledAmount:    settlement.settledAmount,
    paymentDigest,
    nearAiAgent:      env.NEAR_AI_AGENT_ID || null,
    teeAttested:      attestation.valid,
    teeAttestation:   attestation.valid ? attestation.report : null,
    verifiedAt,
  };

  // [G13] HMAC-sign the response so gateway can verify integrity.
  const sig = await signVerifyResponse(env, responseBody);
  if (sig) {
    responseBody._signature = sig.signature;
    responseBody._signedAt  = sig.signedAt;
  }

  return json(responseBody, corsHeaders);
}

// ============================================================================
// [G13] Response signing — HMAC-SHA256 over canonical digest of verify result.
// Uses VERIFY_RESPONSE_SIGNING_KEY (distinct from transport keys per G1).
// ============================================================================

async function signVerifyResponse(env, body) {
  const signingKey = String(env.VERIFY_RESPONSE_SIGNING_KEY || "").trim();
  if (!signingKey) return null;
  const signedAt = new Date().toISOString();
  const digest = `${body.verified}|${body.paymentDigest}|${body.rail}|${body.txHash}|${signedAt}`;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(digest));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    return { signature: hex, signedAt };
  } catch { return null; }
}

// ── [FIX-1] Replay protection — fail-closed on KV missing or read error ──────
// TTL configurable via X402_REPLAY_TTL_SECONDS (default 86400 = 24h)
function getReplayTtl(env) {
  const v = parseInt(String(env.X402_REPLAY_TTL_SECONDS || "86400").trim(), 10);
  return Number.isFinite(v) && v > 0 ? v : 86400;
}

async function checkReplay(env, paymentDigest) {
  if (!env.REPLAY_KV) {
    console.error(JSON.stringify({ ns: "x402", event: "replay_kv_missing", ts: new Date().toISOString() }));
    return { replayed: true, failure: "replay_kv_missing" };
  }
  try {
    const existing = await env.REPLAY_KV.get(`x402-replay:${paymentDigest}`);
    const parsed = existing ? (() => { try { return JSON.parse(existing); } catch { return { token: existing }; } })() : null;
    return existing ? { replayed: true, storedTokenPrefix: parsed?.token || "(raw)", recordedAt: parsed?.recordedAt || null } : { replayed: false };
  } catch (err) {
    console.error(JSON.stringify({ ns: "x402", event: "replay_kv_read_error", error: err?.message, ts: new Date().toISOString() }));
    return { replayed: true, failure: "replay_kv_error" };
  }
}

async function recordReplay(env, paymentDigest, token) {
  if (!env.REPLAY_KV) {
    console.error(JSON.stringify({ ns: "x402", event: "replay_kv_missing_on_write", ts: new Date().toISOString() }));
    return { ok: false, failure: "replay_kv_missing" };
  }
  try {
    await env.REPLAY_KV.put(`x402-replay:${paymentDigest}`,
      JSON.stringify({ token: token.slice(0, 16) + "…", recordedAt: new Date().toISOString() }),
      { expirationTtl: getReplayTtl(env) }
    );
    return { ok: true };
  } catch (err) {
    console.error(JSON.stringify({ ns: "x402", event: "replay_kv_write_error", error: err?.message, paymentDigest, ts: new Date().toISOString() }));
    return { ok: false, failure: "replay_kv_write_error" };
  }
}

// ── [FIX-2] TEE attestation — validates reachability, enclave, freshness ─────
// [Gap 2] opts.nonce: when provided, bypass cache and use request-bound attestation (NEAR AI ?nonce=)
async function fetchAndValidateAttestation(env, opts = {}) {
  const useNonce = typeof opts?.nonce === "string" && opts.nonce.length >= 16;
  if (!useNonce && _attestCache && (Date.now() - _attestCacheTs) < ATTEST_CACHE_TTL_MS) return _attestCache;

  // [G2] Circuit breaker: if NEAR AI has failed repeatedly, fail fast.
  const cbKey = "attestation";
  const cb = _rpcCircuit.get(cbKey);
  if (cb && cb.openUntil > Date.now()) {
    return { valid: false, report: null, reason: "attestation_circuit_open" };
  }

  const nearAiUrl = env.NEAR_AI_URL || "https://cloud-api.near.ai";
  const attestationNonce = useNonce ? (/^[0-9a-fA-F]{64}$/.test(opts.nonce) ? opts.nonce.toLowerCase() : await sha256Hex(opts.nonce)) : null;
  const reportUrl = attestationNonce
    ? `${nearAiUrl}/v1/attestation/report?signing_algo=ed25519&nonce=${attestationNonce}`
    : `${nearAiUrl}/v1/attestation/report`;

  // [G2] Retry with jitter — up to 2 attempts before giving up.
  const maxAttempts = Number(env.ATTESTATION_RETRY_COUNT || 2);
  const timeoutMs = Number(env.ATTESTATION_TIMEOUT_MS || 4000);
  let data = null;
  let lastReason = "attestation_unreachable";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const jitter = 200 + Math.floor(Math.random() * 300);
      await new Promise(r => setTimeout(r, jitter));
    }
    try {
      const headers = {};
      if (env.NEAR_AI_API_KEY) headers["Authorization"] = `Bearer ${env.NEAR_AI_API_KEY}`;
      const resp = await fetch(reportUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) { lastReason = `attestation_http_${resp.status}`; continue; }
      data = await resp.json().catch(() => null);
      if (data) break;
      lastReason = "attestation_invalid_response";
    } catch (err) {
      lastReason = err?.name === "TimeoutError" ? "attestation_timeout" : "attestation_unreachable";
    }
  }

  if (!data) {
    // [L4] Record failure for circuit breaker; open window scales with failure count.
    const failures = (cb?.failures || 0) + 1;
    if (failures >= 3) {
      const openMs = failures * RPC_CIRCUIT_OPEN_MS; // scales: 3×30s, 4×30s, …
      _rpcCircuit.set(cbKey, { openUntil: Date.now() + openMs, failures });
    } else {
      _rpcCircuit.set(cbKey, { openUntil: 0, failures });
    }
    return { valid: false, report: null, reason: lastReason };
  }
  // Reset circuit breaker on success.
  _rpcCircuit.delete(cbKey);
  if (!data) return { valid: false, report: null, reason: "attestation_invalid_response" };
  // [Gap 2] Validate request_nonce when we sent nonce — request-bound attestation
  if (attestationNonce) {
    const echoed = (data?.gateway_attestation?.request_nonce || data?.request_nonce || "").toLowerCase().replace(/^0x/, "");
    // [T-2 FIX] Fail when nonce is present but echo is absent — closes bypass where echoed=="".
    // Previous: `if (echoed && ...)` skipped check when server omitted echo field entirely.
    if (attestationNonce && (!echoed || echoed !== attestationNonce)) {
      return { valid: false, report: null, reason: "attestation_nonce_mismatch" };
    }
  }
  const attestationBinding = verifyAttestationLocalBinding(data, attestationNonce);
  if (!attestationBinding.ok) {
    return { valid: false, report: null, reason: attestationBinding.reason };
  }
  const mr = data?.gateway_attestation?.info?.mr_aggregated || data?.info?.mr_aggregated || data?.mrEnclave || null;
  if (!mr || isZeroEnclave(mr)) return { valid: false, report: null, reason: "attestation_zero_or_missing_enclave" };
  const raw = String(env.TEE_EXPECTED_ENCLAVE_HASH || "").trim();
  // [ENTERPRISE] Enclave pinning: REQUIRED for production. x402 verification fails until set.
  // Set via: wrangler secret put TEE_EXPECTED_ENCLAVE_HASH  (mr_aggregated from /tee/report)
  // Supports comma-separated list — NEAR AI Cloud load-balances across multiple enclave instances.
  const expectedHashes = raw.toLowerCase().split(",").map((h) => h.replace(/^0x/, "").trim()).filter(Boolean);
  if (expectedHashes.length === 0) {
    // [M5] TEE_ENCLAVE_PIN_REQUIRED=false allows warn-only mode (dev/staging without enclave hash)
    if (String(env.TEE_ENCLAVE_PIN_REQUIRED ?? "true").toLowerCase() === "false") {
      console.warn(JSON.stringify({ ns: "x402", event: "attestation_pin_missing_warn", warn: "TEE_EXPECTED_ENCLAVE_HASH not set — enclave pinning bypassed (TEE_ENCLAVE_PIN_REQUIRED=false)", ts: new Date().toISOString() }));
      return { valid: true, report: data, reason: "attestation_pin_bypassed" };
    }
    return { valid: false, report: null, reason: "attestation_pin_missing" };
  }
  const mrNorm = mr.toLowerCase().replace(/^0x/, "");
  let enclaveMatch = false;
  for (const expectedNorm of expectedHashes) {
    if (await timingSafeEqualAsync(mrNorm, expectedNorm)) {
      enclaveMatch = true;
      break;
    }
  }
  if (!enclaveMatch) {
    // [F-11] Invalidate cache on mismatch — avoid serving stale attestation after pin change
    _attestCache = null;
    _attestCacheTs = 0;
    return { valid: false, report: null, reason: "attestation_pin_mismatch" };
  }
  // [T-1 FIX] Agent deployment identity pinning — verify compose_hash (docker-compose SHA-256
  // from gateway_attestation.info.compose_hash) against NEAR_AI_AGENT_HASH. Supports
  // comma-separated list — NEAR AI Cloud runs multiple agent images across instances.
  const rawAgentHash = String(env.NEAR_AI_AGENT_HASH || "").trim();
  if (rawAgentHash) {
    const composeHash = (data?.gateway_attestation?.info?.compose_hash || "").toLowerCase().replace(/^0x/, "");
    if (!composeHash) {
      return { valid: false, report: null, reason: "attestation_compose_hash_missing" };
    }
    const expectedHashes = rawAgentHash.toLowerCase().split(",").map((h) => h.replace(/^0x/, "").trim()).filter(Boolean);
    let agentHashMatch = false;
    for (const expectedNorm of expectedHashes) {
      if (await timingSafeEqualAsync(composeHash, expectedNorm)) {
        agentHashMatch = true;
        break;
      }
    }
    if (!agentHashMatch) {
      _attestCache = null;
      _attestCacheTs = 0;
      return { valid: false, report: null, reason: "attestation_agent_hash_mismatch" };
    }
  }
  // NEAR AI Cloud attestation may omit top-level timestamp; use fetch time when missing
  const reportTs = (data.timestamp ? new Date(data.timestamp).getTime() : 0) || Date.now();
  const ageMs    = Date.now() - reportTs;
  if (ageMs > ATTESTATION_MAX_AGE_MS) {
    return { valid: false, report: null, reason: `attestation_stale_${Math.round(ageMs / 1000)}s` };
  }
  const result = {
    valid:  true,
    report: {
      signingAddress: data?.gateway_attestation?.signing_address || null,
      mrEnclave:      mr,
      composeHash:    data?.gateway_attestation?.info?.compose_hash || null,
      algo:           data?.gateway_attestation?.signing_algo || "ed25519",
      source:         "near-ai-cloud",
      agent:          env.NEAR_AI_AGENT_ID   || null,
      agentHash:      env.NEAR_AI_AGENT_HASH || null,
      reportAge:      reportTs ? `${Math.round(ageMs / 1000)}s` : "unknown",
    },
    reason: "ok",
  };
  if (!useNonce) {
    _attestCache = result;
    _attestCacheTs = Date.now();
  }
  return result;
}

function verifyAttestationLocalBinding(data, expectedNonceHex = null) {
  const ga = data?.gateway_attestation || null;
  if (!ga || typeof ga !== "object") return { ok: false, reason: "attestation_gateway_attestation_missing" };
  const algo = String(ga?.signing_algo || "").toLowerCase();
  if (algo && algo !== "ed25519") return { ok: false, reason: "attestation_signing_algo_invalid" };
  const signingAddress = String(ga?.signing_address || "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(signingAddress)) return { ok: false, reason: "attestation_signing_address_invalid" };
  const reportData = String(ga?.report_data || "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64,128}$/.test(reportData)) return { ok: false, reason: "attestation_report_data_invalid" };
  const nonceEchoed = String(ga?.request_nonce || data?.request_nonce || "").toLowerCase().replace(/^0x/, "");
  if (expectedNonceHex && nonceEchoed !== expectedNonceHex) return { ok: false, reason: "attestation_nonce_mismatch" };
  // dstack format: report_data = signing_address(32b) + request_nonce(32b)
  if (reportData.length >= 64 && !reportData.startsWith(signingAddress)) {
    return { ok: false, reason: "attestation_report_data_signer_mismatch" };
  }
  if (nonceEchoed && reportData.length >= 128 && !reportData.endsWith(nonceEchoed)) {
    return { ok: false, reason: "attestation_report_data_nonce_mismatch" };
  }
  return { ok: true, reason: "ok" };
}

// ── [L-01] BigInt env validation — fail gracefully on malformed amount vars ───
function validateBigIntEnv(val, name) {
  const s = String(val ?? "").trim();
  if (!s) return;
  if (!/^\d+$/.test(s)) throw new Error(`Invalid ${name}: must be non-negative integer`);
}

function validateDecimalEnv(val, name) {
  const s = String(val ?? "").trim();
  if (!s) return;
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid ${name}: must be non-negative number`);
}

// ── Settlement verification — detect rail, verify on-chain ────────────────────

function detectRail(token) {
  // EVM tx hash — 0x + 64 hex chars. Defaults to "base" when no chain hint given.
  // When a chain hint IS given the caller resolves before calling detectRail.
  if (/^0x[0-9a-fA-F]{64}$/.test(token)) return "base";
  if (/^[A-Za-z0-9]{43,44}$/.test(token)) return "near";
  if (token.startsWith("near:")) return "near";
  // [L3 FIX] Removed loose "0x" catch-all — non-64-char 0x tokens return null
  //          to get a clean unknown_rail error instead of silently misrouting.
  return null;
}

/** Parse accepted Base assets. Returns [{asset,amount,symbol},...]. asset="native" for ETH. */
function parseBaseAcceptedAssets(env) {
  const raw = String(env.X402_BASE_ACCEPTED_ASSETS || "").trim();
  const erc20Amount = BigInt(env.X402_BASE_AMOUNT || "10000");
  const ethAmount   = BigInt(env.X402_BASE_ETH_AMOUNT || "10000000000000000");
  if (!raw) {
    const single = String(env.X402_BASE_ASSET || "").trim().toLowerCase();
    if (!single) return [];
    return [{ asset: single, amount: erc20Amount, symbol: "USDC" }];
  }
  const list = [];
  for (const s of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const lower = s.toLowerCase();
    if (lower === "native" || lower === "eth") {
      list.push({ asset: "native", amount: ethAmount, symbol: "ETH" });
    } else if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
      list.push({ asset: lower, amount: erc20Amount, symbol: "ERC20" });
    }
  }
  return list;
}

// ============================================================================
// [G10] Settlement cache — avoids redundant RPC calls for already-verified txs.
// Key is composite (rail + paymentDigest) so different resources/amounts produce
// different cache entries. Short TTL respects reorg risk.
// ============================================================================

const SETTLEMENT_CACHE_TTL = 300; // 5 min — short enough to handle reorgs

async function getSettlementCache(env, cacheKey) {
  if (!env.REPLAY_KV) return null;
  try {
    const raw = await env.REPLAY_KV.get(cacheKey);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function putSettlementCache(env, cacheKey, settlement) {
  if (!env.REPLAY_KV) return;
  try {
    await env.REPLAY_KV.put(cacheKey, JSON.stringify(settlement), {
      expirationTtl: Number(env.SETTLEMENT_CACHE_TTL_SECONDS || SETTLEMENT_CACHE_TTL),
    });
  } catch { /* best-effort */ }
}

// ── [G6] Gateway requireX402Payment sends required.pricing { network, amount, asset } — align settlement minimums.
function parseGatewayPricingFloor(body) {
  const p = body?.required?.pricing;
  if (!p || p.amount == null) return null;
  const amtStr = String(p.amount).trim();
  if (!/^\d+$/.test(amtStr)) return null;
  const min = BigInt(amtStr);
  if (min < 0n) return null;
  return {
    min,
    network: String(p.network || "").trim().toLowerCase(),
    asset: String(p.asset || "").trim().toLowerCase(),
  };
}

function applyPricingFloorToBaseAccepted(accepted, floor) {
  if (!floor || floor.network !== "eip155:8453" || accepted.length === 0) return accepted;
  if (!floor.asset) {
    if (accepted.length !== 1) return accepted;
    const row = accepted[0];
    const need = row.amount > floor.min ? row.amount : floor.min;
    return [{ ...row, amount: need }];
  }
  const fa = floor.asset;
  return accepted.map((row) => {
    const ra = row.asset === "native" ? "native" : String(row.asset).toLowerCase();
    if (ra !== fa) return row;
    const need = row.amount > floor.min ? row.amount : floor.min;
    return { ...row, amount: need };
  });
}

function mergeExpectedAmountWithGatewayPricing(expectedAmountBigInt, expectedAsset, chainCaip2, pricingFloor) {
  if (!pricingFloor?.min) return expectedAmountBigInt;
  const caip = String(chainCaip2 || "").trim().toLowerCase();
  const net = pricingFloor.network;
  if (!net || !caip || net !== caip) return expectedAmountBigInt;
  const pa = pricingFloor.asset;
  if (pa) {
    const a = String(expectedAsset || "");
    const match = a.startsWith("0x") || a.startsWith("0X")
      ? a.toLowerCase() === pa.toLowerCase()
      : a === pa;
    if (!match) return expectedAmountBigInt;
  }
  return expectedAmountBigInt > pricingFloor.min ? expectedAmountBigInt : pricingFloor.min;
}

async function verifyBaseSettlement(txHash, env, pricingFloor = null) {
  validateBigIntEnv(env.X402_BASE_AMOUNT || "10000", "X402_BASE_AMOUNT");
  const rpcUrl = env.ALCHEMY_API_KEY
    ? `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`
    : (env.BASE_RPC_URL || "https://mainnet.base.org");
  const expectedRecipient = String(env.X402_BASE_PAYTO || "").toLowerCase();
  let accepted            = parseBaseAcceptedAssets(env);
  accepted                = applyPricingFloorToBaseAccepted(accepted, pricingFloor);

  if (!expectedRecipient) {
    return { settled: false, failure: "settlement_missing", error: "Base payment config not set (X402_BASE_PAYTO)" };
  }
  if (accepted.length === 0) {
    return { settled: false, failure: "settlement_missing", error: "Base payment config not set (X402_BASE_ASSET or X402_BASE_ACCEPTED_ASSETS)" };
  }

  try {
    const start = Date.now();
    const rpcKey = "base";
    const [receiptResp, txResp] = await Promise.all([
      fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
        signal: AbortSignal.timeout(remainingBudgetMs(start, RPC_TOTAL_BUDGET_MS, 8000)),
      }),
      fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getTransactionByHash", params: [txHash] }),
        signal: AbortSignal.timeout(remainingBudgetMs(start, RPC_TOTAL_BUDGET_MS, 8000)),
      }).catch(() => null),
    ]);
    if (!receiptResp.ok) {
      recordRpcFailure(rpcKey);
      return { settled: false, failure: "settlement_missing", error: "Base RPC error" };
    }
    recordRpcSuccess(rpcKey);
    const receiptData = await receiptResp.json().catch(() => null);
    const receipt     = receiptData?.result;

    if (!receipt) return { settled: false, failure: "settlement_missing", error: "Transaction receipt not found on Base" };
    if (receipt.status !== "0x1") return { settled: false, failure: "settlement_missing", error: "Transaction reverted on-chain" };

    // [H6 FIX] Require minimum block confirmations to guard against reorgs.
    // Base produces ~2s blocks; 3 confirmations = ~6s. Legitimate clients
    // simply retry — nothing that works today breaks, only very-fresh txs
    // get a temporary settlement_pending until confirmations accrue.
    const MIN_CONFIRMATIONS = Number(env.BASE_MIN_CONFIRMATIONS || 3);
    if (MIN_CONFIRMATIONS > 0) {
      if (isRpcCircuitOpen(rpcKey)) {
        return { settled: false, failure: "settlement_pending", error: "Base RPC temporarily unavailable" };
      }
      const blockResp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(remainingBudgetMs(start, RPC_TOTAL_BUDGET_MS, 5000)),
      });
      if (!blockResp.ok) {
        recordRpcFailure(rpcKey);
        return { settled: false, failure: "settlement_pending", error: "Base block height check failed" };
      }
      recordRpcSuccess(rpcKey);
      const blockData   = await blockResp.json().catch(() => null);
      const latestBlock = blockData?.result ? parseInt(blockData.result, 16) : null;
      const txBlock     = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null;
      if (latestBlock !== null && txBlock !== null) {
        const confirmations = latestBlock - txBlock;
        if (confirmations < MIN_CONFIRMATIONS) {
          return { settled: false, failure: "settlement_pending", error: `Insufficient confirmations: ${confirmations}/${MIN_CONFIRMATIONS}` };
        }
      }
    }

    const txData      = txResp ? await txResp.json().catch(() => null) : null;
    const tx          = txData?.result;

    const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    // 1) Check native ETH (direct transfer to payTo)
    for (const { asset, amount } of accepted) {
      if (asset !== "native") continue;
      if (tx?.to && (tx.to || "").toLowerCase() === expectedRecipient) {
        const value = BigInt(tx.value || "0");
        if (value >= amount) {
          return { settled: true, rail: "base", chain: "eip155:8453", txHash, recipientMatch: true, assetMatch: true, amountMatch: true, settledAmount: value.toString(), blockNumber: receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null };
        }
      }
    }

    // 2) Check ERC-20 transfers
    for (const log of receipt.logs || []) {
      if (log.topics?.[0] !== ERC20_TRANSFER_TOPIC) continue;
      const logAddr = (log.address || "").toLowerCase();
      for (const { asset, amount } of accepted) {
        if (asset === "native") continue;
        if (logAddr !== asset) continue;
        const rawTopic = String(log.topics?.[2] || "").replace(/^0x/i, "");
        const toAddr = rawTopic.length >= 40 ? (`0x${rawTopic.slice(-40)}`).toLowerCase() : null;
        if (toAddr !== expectedRecipient) continue;
        const transferAmount = log.data ? BigInt(log.data) : 0n;
        if (transferAmount >= amount) {
          return { settled: true, rail: "base", chain: "eip155:8453", txHash, recipientMatch: true, assetMatch: true, amountMatch: true, settledAmount: transferAmount.toString(), blockNumber: receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null };
        }
      }
    }

    return { settled: false, failure: "wrong_asset", error: "No matching payment to required recipient — pay with an accepted Base asset (USDC, ETH, etc.)" };
  } catch (err) {
    recordRpcFailure("base");
    const errMsg = err?.name === "TimeoutError" ? "Base RPC timeout" : (err?.message || "Base RPC error");
    return { settled: false, failure: "settlement_missing", error: errMsg };
  }
}

// ── [Plan C] verifyEvmSettlement — generic EVM verifier for all non-Base EVM chains ──────────
// Supports all X402_{KEY}_* env-var-gated chains: ETH, ARB, OP, AVAX, BNB, POLY,
// ZKSYNC, LINEA, SCROLL, MANTLE, BLAST, MODE, SEI, FIL (FEVM), etc.
// Uses the same eth_getTransactionReceipt + ERC-20 Transfer log pattern as verifyBaseSettlement.
// chainKey = short-key (e.g. "arb", "fil") — must match EVM_RPC_MAP and X402_{KEY}_* env vars.
async function verifyEvmSettlement(txHash, env, chainKey, pricingFloor = null) {
  const KEY               = chainKey.toUpperCase();
  const rpcUrl            = env[`X402_${KEY}_RPC_URL`] || EVM_RPC_MAP[chainKey] || null;
  const expectedRecipient = String(env[`X402_${KEY}_PAYTO`]  || "").toLowerCase();
  const expectedAsset     = String(env[`X402_${KEY}_ASSET`]  || "").toLowerCase();
  const caip2Raw          = env[`X402_${KEY}_CAIP2`]         || KEY_TO_CAIP2[chainKey] || `eip155:?`;
  const caip2             = String(caip2Raw).toLowerCase();
  let expectedAmount      = BigInt(env[`X402_${KEY}_AMOUNT`] || "1000000");
  expectedAmount          = mergeExpectedAmountWithGatewayPricing(expectedAmount, expectedAsset, caip2, pricingFloor);

  if (!rpcUrl) {
    return { settled: false, failure: "settlement_missing", error: `No RPC configured for chain: ${chainKey}` };
  }
  if (!expectedRecipient || !expectedAsset) {
    return { settled: false, failure: "settlement_missing", error: `${KEY} payment config not set (X402_${KEY}_PAYTO, X402_${KEY}_ASSET)` };
  }

  try {
    const start = Date.now();
    const rpcKey = `evm:${chainKey}`;
    if (isRpcCircuitOpen(rpcKey)) {
      return { settled: false, failure: "settlement_pending", error: `${chainKey} RPC temporarily unavailable` };
    }
    const receiptResp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
      signal: AbortSignal.timeout(remainingBudgetMs(start, RPC_TOTAL_BUDGET_MS, 10000)),
    });
    if (!receiptResp.ok) {
      recordRpcFailure(rpcKey);
      return { settled: false, failure: "settlement_missing", error: `${chainKey} RPC error` };
    }
    recordRpcSuccess(rpcKey);
    const receiptData = await receiptResp.json().catch(() => null);
    const receipt     = receiptData?.result;

    if (!receipt) return { settled: false, failure: "settlement_missing", error: `Transaction receipt not found on ${chainKey}` };
    if (receipt.status !== "0x1") return { settled: false, failure: "settlement_missing", error: "Transaction reverted on-chain" };

    // Min confirmations — default 1 for faster chains (Arb/OP/FIL produce blocks quickly)
    const MIN_CONFIRMATIONS = Number(env[`${KEY}_MIN_CONFIRMATIONS`] || 1);
    if (MIN_CONFIRMATIONS > 0) {
      const blockResp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(remainingBudgetMs(start, RPC_TOTAL_BUDGET_MS, 5000)),
      });
      if (!blockResp.ok) {
        recordRpcFailure(rpcKey);
        return { settled: false, failure: "settlement_pending", error: `${chainKey} block height check failed` };
      }
      recordRpcSuccess(rpcKey);
      const blockData   = await blockResp.json().catch(() => null);
      const latestBlock = blockData?.result ? parseInt(blockData.result, 16) : null;
      const txBlock     = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null;
      if (latestBlock !== null && txBlock !== null) {
        const confirmations = latestBlock - txBlock;
        if (confirmations < MIN_CONFIRMATIONS) {
          return { settled: false, failure: "settlement_pending", error: `Insufficient confirmations: ${confirmations}/${MIN_CONFIRMATIONS}` };
        }
      }
    }

    let recipientMatch = false, assetMatch = false, amountMatch = false, settledAmount = "0";
    const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    for (const log of receipt.logs || []) {
      if (log.topics?.[0] !== ERC20_TRANSFER_TOPIC) continue;
      if ((log.address || "").toLowerCase() !== expectedAsset) continue;
      assetMatch = true;
      const toAddr = log.topics[2] ? ("0x" + log.topics[2].slice(26)).toLowerCase() : null;
      if (toAddr !== expectedRecipient) continue;
      recipientMatch = true;
      const transferAmount = log.data ? BigInt(log.data) : 0n;
      settledAmount = transferAmount.toString();
      if (transferAmount >= expectedAmount) amountMatch = true;
    }

    if (!assetMatch)     return { settled: false, failure: "wrong_asset",     error: "Required asset not found in transaction logs" };
    if (!recipientMatch) return { settled: false, failure: "wrong_recipient", error: "Payment not sent to required recipient" };
    if (!amountMatch)    return { settled: false, failure: "wrong_amount",    error: `Insufficient: got ${settledAmount}, need ${expectedAmount}` };

    return { settled: true, rail: chainKey, chain: caip2, txHash, recipientMatch: true, assetMatch: true, amountMatch: true, settledAmount, blockNumber: receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null };
  } catch (err) {
    recordRpcFailure(`evm:${chainKey}`);
    return { settled: false, failure: "settlement_missing", error: `${chainKey} RPC error` };
  }
}

// ── [Plan C] verifySolanaSettlement — Solana SPL token transfer verification ─────────────────
// Uses getTransaction RPC (jsonParsed) to inspect spl-token transfer/transferChecked instructions.
// X402_SOL_ASSET = USDC SPL mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
// X402_SOL_PAYTO = destination token account or wallet address (base58)
async function verifySolanaSettlement(txSig, env, pricingFloor = null) {
  // [G13] Unified RPC resolution — SOLANA_RPC_URL preferred, X402_SOL_RPC_URL as alias, mainnet fallback
  const primaryRpc        = env.SOLANA_RPC_URL || env.X402_SOL_RPC_URL || "https://api.mainnet-beta.solana.com";
  // [G2] Optional secondary RPC — tried once if primary returns no data or an error
  const fallbackRpc       = env.X402_SOL_RPC_URL_FALLBACK || null;
  // [G6] SOLANA_CAIP2 allows switching between mainnet/devnet without code changes
  const solChain          = env.SOLANA_CAIP2 || env.X402_SOLANA_CAIP2 || "solana:mainnet";
  const expectedRecipient = String(env.X402_SOL_PAYTO || env.X402_SOLANA_PAYTO || "");
  const expectedAsset     = String(env.X402_SOL_ASSET || env.X402_SOLANA_ASSET || "");  // SPL mint
  let expectedAmount      = BigInt(String(env.X402_SOL_AMOUNT || env.X402_SOLANA_AMOUNT || "1000000").trim() || "1000000");
  expectedAmount          = mergeExpectedAmountWithGatewayPricing(
    expectedAmount,
    expectedAsset,
    solChain,
    pricingFloor,
  );

  if (!expectedRecipient || !expectedAsset) {
    return { settled: false, failure: "settlement_missing", error: "Solana payment config not set (X402_SOL_PAYTO, X402_SOL_ASSET)" };
  }

  // [G2] Inner helper — fetch tx from a given RPC URL; returns parsed JSON or null
  async function fetchTxFromRpc(rpcUrl) {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getTransaction",
        // commitment=finalized ensures we only verify settled (non-reorg) txs [G7]
        params: [txSig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    return resp.json().catch(() => null);
  }

  try {
    let data = await fetchTxFromRpc(primaryRpc);

    // [G2] If primary RPC returned nothing or a JSON-RPC error, try fallback once
    if ((!data?.result && !data?.error) || data?.error) {
      if (fallbackRpc && fallbackRpc !== primaryRpc) {
        data = await fetchTxFromRpc(fallbackRpc).catch(() => null);
      }
    }

    const tx = data?.result;

    if (!tx) return { settled: false, failure: "settlement_missing", error: "Solana transaction not found" };
    if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
      return { settled: false, failure: "settlement_missing", error: "Solana transaction failed on-chain" };
    }

    // Collect all instructions (top-level + inner) for SPL token transfer inspection
    const instructions = [
      ...(tx.transaction?.message?.instructions || []),
      ...(tx.meta?.innerInstructions?.flatMap(ii => ii.instructions) || []),
    ];

    let recipientMatch = false, assetMatch = false, amountMatch = false, settledAmount = "0";

    for (const ix of instructions) {
      if (ix.program !== "spl-token") continue;
      const parsed = ix.parsed;
      if (!parsed) continue;
      const type = parsed.type;
      if (type !== "transfer" && type !== "transferChecked") continue;
      const info = parsed.info || {};

      // Check mint (asset) — present in transferChecked; skip if no mint info (cannot verify asset)
      const mint = info.mint || info.tokenMint;
      if (!mint) continue;
      if (mint !== expectedAsset) {
        // [G4] Log mint mismatches so operators can diagnose misconfigured X402_SOL_ASSET without guessing
        console.warn(JSON.stringify({ ns: "x402:sol", event: "mint_mismatch", found: mint, expected: expectedAsset, txSig, ts: new Date().toISOString() }));
        continue;
      }
      assetMatch = true;

      // Destination: info.destination for transferChecked/transfer, info.account as fallback
      const dest = info.destination || info.account || "";
      if (dest !== expectedRecipient) continue;
      recipientMatch = true;

      // Amount: info.tokenAmount.amount (base units) for transferChecked, info.amount for transfer
      const rawAmount = BigInt(info.tokenAmount?.amount || info.amount || "0");
      settledAmount = rawAmount.toString();
      if (rawAmount >= expectedAmount) amountMatch = true;
    }

    if (!assetMatch)     return { settled: false, failure: "wrong_asset",     error: "Required SPL token mint not found in transaction" };
    if (!recipientMatch) return { settled: false, failure: "wrong_recipient", error: "Payment not sent to required recipient" };
    if (!amountMatch)    return { settled: false, failure: "wrong_amount",    error: `Insufficient: got ${settledAmount}, need ${expectedAmount}` };

    return { settled: true, rail: "sol", chain: solChain, txHash: txSig, recipientMatch: true, assetMatch: true, amountMatch: true, settledAmount };
  } catch (err) {
    // [G2] Surface error type to help distinguish timeout vs network vs parse failures
    const errMsg = err?.name === "TimeoutError" ? "Solana RPC timeout" : (err?.message || "Solana RPC error");
    return { settled: false, failure: "settlement_missing", error: errMsg };
  }
}

// ── [Plan C] verifyTronSettlement — Tron TRC-20 transfer verification via TronGrid REST ───────
// Uses GET /v1/transactions/{txId} (TronGrid). Parses trc20_transfers array first;
// falls back to ABI-decoding the data field (selector a9059cbb = transfer(address,uint256)).
// X402_TRX_ASSET = USDT TRC-20 base58: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
// X402_TRX_PAYTO = recipient Tron base58 address
async function verifyTronSettlement(txId, env, pricingFloor = null) {
  const apiUrl            = (env.X402_TRX_RPC_URL || env.X402_TRON_RPC_URL || "https://api.trongrid.io").replace(/\/+$/, "");
  const expectedRecipient = String(env.X402_TRX_PAYTO || env.X402_TRON_PAYTO || "").toLowerCase();
  const expectedAsset     = String(env.X402_TRX_ASSET || env.X402_TRON_ASSET || "").toLowerCase();  // base58 TRC-20 address
  let expectedAmount      = BigInt(String(env.X402_TRX_AMOUNT || env.X402_TRON_AMOUNT || "1000000").trim() || "1000000");
  expectedAmount          = mergeExpectedAmountWithGatewayPricing(
    expectedAmount,
    expectedAsset,
    "tron:mainnet",
    pricingFloor,
  );

  if (!expectedRecipient || !expectedAsset) {
    return { settled: false, failure: "settlement_missing", error: "Tron payment config not set (X402_TRX_PAYTO, X402_TRX_ASSET)" };
  }

  try {
    const headers = { "accept": "application/json" };
    if (env.X402_TRX_API_KEY) headers["TRON-PRO-API-KEY"] = env.X402_TRX_API_KEY;

    const resp = await fetch(`${apiUrl}/v1/transactions/${txId}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const data  = await resp.json().catch(() => null);
    const txArr = data?.data;

    if (!txArr?.length) return { settled: false, failure: "settlement_missing", error: "Tron transaction not found" };
    const tx = txArr[0];

    if (tx?.ret?.[0]?.contractRet !== "SUCCESS") {
      return { settled: false, failure: "settlement_missing", error: "Tron transaction failed or reverted" };
    }

    let recipientMatch = false, assetMatch = false, amountMatch = false, settledAmount = "0";

    // ── Path 1: TronGrid trc20_transfers array (enriched endpoint) ─────────
    const trc20 = tx?.trc20_transfers || [];
    for (const transfer of trc20) {
      const addr = (transfer.token_info?.address || transfer.contract_address || "").toLowerCase();
      if (addr !== expectedAsset) continue;
      assetMatch = true;
      if ((transfer.to_address || "").toLowerCase() === expectedRecipient) recipientMatch = true;
      const amt = BigInt(transfer.amount || "0");
      settledAmount = amt.toString();
      if (amt >= expectedAmount) amountMatch = true;
      break;
    }

    // ── Path 2: ABI-decode data field (a9059cbb = ERC-20 transfer selector) ─
    if (!assetMatch) {
      const contract = tx?.raw_data?.contract?.[0];
      if (contract?.type === "TriggerSmartContract") {
        const value = contract.parameter?.value || {};
        const contractAddr = (value.contract_address || "").toLowerCase();
        // TronGrid returns hex addresses (41-prefixed or without 0x)
        // Compare by stripping "41" prefix vs expectedAsset lower
        const assetHex = expectedAsset.startsWith("0x") ? expectedAsset.slice(2) : expectedAsset;
        if (contractAddr === assetHex || contractAddr.endsWith(assetHex) || contractAddr === expectedAsset) {
          assetMatch = true;
          const dataField = String(value.data || "");
          const selector  = dataField.slice(0, 8);
          if (selector === "a9059cbb" && dataField.length >= 136) {
            // transfer(address _to, uint256 _value)
            // _to  : bytes 9–48 (32-byte word, 12-byte zero-padding + 20-byte addr)
            const toHex     = dataField.slice(32, 72);  // 20 bytes of address
            const toTronHex = "41" + toHex;
            if (toTronHex === expectedRecipient || ("0x" + toHex) === expectedRecipient ||
                toHex === expectedRecipient) {
              recipientMatch = true;
            }
            // _value: bytes 73–136 (32-byte word)
            const amtHex = dataField.slice(72, 136);
            const amt    = amtHex ? BigInt("0x" + amtHex) : 0n;
            settledAmount = amt.toString();
            if (amt >= expectedAmount) amountMatch = true;
          }
        }
      }
    }

    if (!assetMatch)     return { settled: false, failure: "wrong_asset",     error: "Required TRC-20 token not found in transaction" };
    if (!recipientMatch) return { settled: false, failure: "wrong_recipient", error: "Payment not sent to required recipient" };
    if (!amountMatch)    return { settled: false, failure: "wrong_amount",    error: `Insufficient: got ${settledAmount}, need ${expectedAmount}` };

    return { settled: true, rail: "trx", chain: "tron:mainnet", txHash: txId, recipientMatch: true, assetMatch: true, amountMatch: true, settledAmount };
  } catch (err) {
    return { settled: false, failure: "settlement_missing", error: "Tron RPC error" };
  }
}

async function verifyNearSettlement(token, env, verifyBody = {}, pricingFloor = null) {
  if (env.X402_NEAR_AMOUNT) validateDecimalEnv(env.X402_NEAR_AMOUNT, "X402_NEAR_AMOUNT");
  const rpcUrl            = env.NEAR_RPC_URL || "https://rpc.mainnet.near.org";
  const expectedRecipient = String(env.X402_NEAR_PAYTO || "").toLowerCase();
  let expectedAmount      = env.X402_NEAR_AMOUNT
    ? (() => { const [i,d=""] = String(env.X402_NEAR_AMOUNT).split("."); return (BigInt(i) * 10n**24n + BigInt((d+"000000000000000000000000").slice(0,24))).toString(); })() // [M5 FIX] safe BigInt parse
    : null;
  if (expectedAmount && pricingFloor?.network === "near:mainnet") {
    const merged = mergeExpectedAmountWithGatewayPricing(
      BigInt(expectedAmount),
      "near:native",
      "near:mainnet",
      pricingFloor,
    );
    expectedAmount = merged.toString();
  }

  if (!expectedRecipient) {
    return { settled: false, failure: "settlement_missing", error: "NEAR payment config not set (X402_NEAR_PAYTO)" };
  }

  const txHash = token.startsWith("near:") ? token.slice(5) : token;
  const senderId = String(
    verifyBody?.sender || verifyBody?.settledBy || verifyBody?.payer || verifyBody?.from || ""
  ).trim().toLowerCase();
  const senderLooksValid = /^[a-z0-9._-]+(\.near)?$/i.test(senderId);
  if (!senderLooksValid) {
    return {
      settled: false,
      failure: "settlement_missing",
      error: "NEAR verification requires sender_account_id (provide sender/settledBy/payer/from)",
    };
  }

  try {
    // NEAR RPC requires sender_account_id to resolve tx by hash.
    const expResp = await fetch(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "x402-exp", method: "EXPERIMENTAL_tx_status",
        params: { tx_hash: txHash, sender_account_id: senderId, wait_until: "EXECUTED" } }),
      signal: AbortSignal.timeout(8000),
    });
    const expData        = await expResp.json().catch(() => null);
    const useExperimental = expData?.result?.status && !expData?.error;
    const data           = useExperimental ? expData : await nearTxFallback(txHash, senderId, rpcUrl);

    if (!data?.result?.status) return { settled: false, failure: "settlement_missing", error: "NEAR transaction not found" };

    const status    = data.result.status;
    const txSuccess = status.SuccessValue !== undefined || !!status.SuccessReceiptId;
    if (!txSuccess) return { settled: false, failure: "settlement_missing", error: "NEAR transaction failed or pending" };

    const receiverId = (data.result.transaction?.receiver_id || "").toLowerCase();
    if (!receiverId) return { settled: false, failure: "settlement_missing", error: "Cannot determine NEAR receiver" };
    if (receiverId !== expectedRecipient) return { settled: false, failure: "wrong_recipient", error: `Sent to ${receiverId}, expected ${expectedRecipient}` };

    // [Audit Issue 3] Sum all Transfer actions — don't break on first; multi-action txs undercount otherwise
    let settledAmount = "0";
    for (const action of data.result.transaction?.actions || []) {
      if (action.Transfer) {
        settledAmount = (BigInt(settledAmount) + BigInt(action.Transfer.deposit || "0")).toString();
      }
    }
    let amountMatch = true;
    if (expectedAmount && BigInt(settledAmount) < BigInt(expectedAmount)) amountMatch = false;

    if (!amountMatch) return { settled: false, failure: "wrong_amount", error: `Insufficient NEAR: got ${settledAmount} yocto, need ${expectedAmount}` };

    return { settled: true, rail: "near", chain: "near:mainnet", txHash, recipientMatch: true, assetMatch: true, amountMatch: true, settledAmount, blockHash: data.result.transaction_outcome?.block_hash || null };
  } catch (err) {
    return { settled: false, failure: "settlement_missing", error: "NEAR RPC error" }; // [L2]
  }
}

// ── [C-SC1 FIX] STX settlement verification ───────────────────────────────────
// Checks: tx exists on Stacks, tx succeeded, correct recipient, correct amount.
// Called only when x-payment-chain: stacks hint is present in the verify request.
// [d5225908] Poll Hiro within RPC_TOTAL_BUDGET_MS (12s), STACKS_SETTLEMENT_POLL_INTERVAL_MS (2.5s) between tries.
async function verifyStacksSettlement(txHash, env, pricingFloor = null) {
  const stxDefault = "1000000";
  validateBigIntEnv(env.STX_AMOUNT || stxDefault, "STX_AMOUNT");
  const expectedRecipient = String(env.STX_PAYTO   || "").toLowerCase();
  let expectedAmount      = BigInt(env.STX_AMOUNT   || stxDefault);
  expectedAmount          = mergeExpectedAmountWithGatewayPricing(
    expectedAmount,
    "stacks:stx",
    "stacks:mainnet",
    pricingFloor,
  );

  if (!expectedRecipient) {
    return { settled: false, failure: "settlement_missing", error: "STX payment config not set (STX_PAYTO)" };
  }

  const hiroHeaders = { accept: "application/json" };
  if (env.HIRO_API_KEY) hiroHeaders["x-hiro-api-key"] = env.HIRO_API_KEY;
  const hiroTxId = txHash.startsWith("0x") ? txHash : `0x${txHash}`;
  const hiroUrl = `https://api.hiro.so/extended/v1/tx/${hiroTxId}`;

  const budgetStart = Date.now();
  let lastError = "Transaction not found on Stacks";

  const waitPoll = async () => {
    const elapsed = Date.now() - budgetStart;
    const remaining = RPC_TOTAL_BUDGET_MS - elapsed;
    if (remaining <= STACKS_SETTLEMENT_POLL_INTERVAL_MS) return;
    await new Promise((r) => setTimeout(r, Math.min(STACKS_SETTLEMENT_POLL_INTERVAL_MS, remaining - 100)));
  };

  try {
    while (Date.now() - budgetStart < RPC_TOTAL_BUDGET_MS) {
      const elapsed = Date.now() - budgetStart;
      const remaining = RPC_TOTAL_BUDGET_MS - elapsed;
      if (remaining < 200) break;
      const perFetchMs = Math.min(8000, Math.max(250, remaining - 50));

      let resp;
      try {
        resp = await fetch(hiroUrl, {
          headers: hiroHeaders,
          signal: AbortSignal.timeout(perFetchMs),
        });
      } catch {
        lastError = "Stacks RPC error";
        await waitPoll();
        continue;
      }

      if (!resp.ok) {
        lastError = `Stacks API returned ${resp.status}`;
        if (resp.status === 404 || resp.status === 400) {
          await waitPoll();
          continue;
        }
        return { settled: false, failure: "settlement_missing", error: lastError };
      }

      const tx = await resp.json().catch(() => null);
      if (!tx || !tx.tx_id) {
        await waitPoll();
        continue;
      }

      const statusRaw = String(tx.tx_status || "");
      const status = statusRaw.toLowerCase();

      if (status === "success") {
        let recipientMatch = false;
        let amountMatch    = false;
        let settledAmount  = "0";

        const events = tx.events || [];
        for (const ev of events) {
          const evType = (ev.event_type || ev.type || "").toLowerCase();
          if (evType !== "stx_transfer" && evType !== "stx" && evType !== "stx_asset") continue;
          const data = ev.asset || ev.data || ev;
          const recv = (data.recipient || data.recipient_address || "").toLowerCase();
          const amt  = BigInt(data.amount || data.transfer_amount || "0");
          if (recv !== expectedRecipient) continue;
          settledAmount = amt.toString();
          recipientMatch = true;
          if (amt >= expectedAmount) amountMatch = true;
        }

        if (events.length === 0) {
          return { settled: false, failure: "no_transfer_evidence", error: "No stx_transfer events — cannot verify settlement without execution evidence" };
        }

        if (!recipientMatch) return { settled: false, failure: "wrong_recipient", error: "STX not sent to required recipient" };
        if (!amountMatch)    return { settled: false, failure: "wrong_amount",    error: `Insufficient STX: got ${settledAmount}, need ${expectedAmount}` };

        return {
          settled: true, rail: "stacks", chain: "stacks",
          txHash, recipientMatch: true, amountMatch: true,
          settledAmount, blockHeight: tx.block_height || null,
        };
      }

      if (status === "pending" || status.includes("pending")) {
        lastError = `Stacks tx not yet successful: ${statusRaw}`;
        await waitPoll();
        continue;
      }

      return { settled: false, failure: "settlement_missing", error: `Stacks tx not successful: ${statusRaw}` };
    }

    return {
      settled: false,
      failure: "settlement_missing",
      error: `${lastError} (Stacks poll budget ${RPC_TOTAL_BUDGET_MS}ms exhausted)`,
    };
  } catch {
    return { settled: false, failure: "settlement_missing", error: "Stacks RPC error" };
  }
}

async function nearTxFallback(txHash, senderGuess, rpcUrl) {
  const resp = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "x402-fallback", method: "tx", params: [txHash, senderGuess] }),
    signal: AbortSignal.timeout(8000),
  });
  return resp.json().catch(() => null);
}

// ============================================================================
// /tee/report — NEAR AI Cloud attestation report
// ============================================================================

async function handleTeeReport(request, env, corsHeaders) {
  const nearAiUrl = env.NEAR_AI_URL || "https://cloud-api.near.ai";
  const reqUrl = new URL(request.url);
  const nonceParam = String(reqUrl.searchParams.get("nonce") || "").trim();
  const reportUrl = nonceParam
    ? `${nearAiUrl}/v1/attestation/report?signing_algo=ed25519&nonce=${encodeURIComponent(nonceParam)}`
    : `${nearAiUrl}/v1/attestation/report`;
  try {
    const headers = {};
    if (env.NEAR_AI_API_KEY) headers["Authorization"] = `Bearer ${env.NEAR_AI_API_KEY}`;
    const resp = await fetch(reportUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      if (data) {
        // [Gap 4] Strip intel_quote, event_log — reduce attestation exposure; keep only what verifiers need
        const ga = data?.gateway_attestation;
        const attestation = ga ? {
          gateway_attestation: { info: ga.info || {} },
          timestamp: data.timestamp,
        } : data;
        return json({
          success: true,
          source: "near-ai-cloud",
          agent: env.NEAR_AI_AGENT_ID || null,
          agentHash: env.NEAR_AI_AGENT_HASH || null,
          attestation,
          timestamp: new Date().toISOString(),
        }, corsHeaders);
      }
    }
  } catch { /* NEAR AI unavailable */ }

  return json({
    success: false,
    error: "TEE attestation report unavailable",
    source: "near-ai-cloud",
    endpoint: `${nearAiUrl}/v1/attestation/report`,
  }, corsHeaders, 502);
}

// ============================================================================
// /tee/verify — verify attestation report locally (GET-based, report mode)
// ============================================================================

async function jsonWithVerificationBindingAgent(request, payload, corsHeaders, status, requestBodySha256) {
  return json(await attachVerificationBinding(request, payload, requestBodySha256), corsHeaders, status);
}

async function handleTeeVerify(request, env, corsHeaders) {
  const ctErr = requireJsonContentType(request, corsHeaders);
  if (ctErr) return ctErr;
  // [HI-01] Nonce/replay protection — require body.nonce, reject replays
  const parsed = await parseJsonBodyWithRequestHash(request, 65536);
  const rbh = parsed.requestBodySha256;
  if (parsed.error === "duplicate-keys") {
    return jsonWithVerificationBindingAgent(
      request,
      { success: false, error: "Duplicate JSON keys are not allowed", code: "JSON_DUPLICATE_KEYS" },
      corsHeaders,
      400,
      rbh,
    );
  }
  if (parsed.body === null || parsed.error === "content-type" || parsed.error === "too-large") {
    return jsonWithVerificationBindingAgent(
      request,
      { success: false, error: "Invalid or too large JSON body (max 64 KB)" },
      corsHeaders,
      413,
      rbh,
    );
  }
  const body = parsed.body;
  const nonce = body?.nonce;
  if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 512) {
    return jsonWithVerificationBindingAgent(
      request,
      { success: false, error: "nonce required (string, 16–512 chars)" },
      corsHeaders,
      400,
      rbh,
    );
  }
  const nonceKey = `tee_verify_nonce:${nonce}`;
  if (!env.REPLAY_DO && !env.REPLAY_KV) {
    return jsonWithVerificationBindingAgent(
      request,
      { success: false, error: "Replay protection unavailable (REPLAY_DO/REPLAY_KV not configured)" },
      corsHeaders,
      503,
      rbh,
    );
  }
  try {
    if (env.REPLAY_DO) {
      const doId = env.REPLAY_DO.idFromName("replay-global");
      const doStub = env.REPLAY_DO.get(doId);
      const claim = await doStub.fetch("https://do/replay/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentDigest: nonceKey }),
      });
      const claimResult = await claim.json().catch(() => null);
      if (!claimResult?.claimed) {
        return jsonWithVerificationBindingAgent(
          request,
          { success: false, error: "nonce already used (replay)" },
          corsHeaders,
          409,
          rbh,
        );
      }
    } else {
      const existing = await env.REPLAY_KV.get(nonceKey);
      if (existing) {
        return jsonWithVerificationBindingAgent(
          request,
          { success: false, error: "nonce already used (replay)" },
          corsHeaders,
          409,
          rbh,
        );
      }
    }
    if (env.REPLAY_KV) {
      await env.REPLAY_KV.put(nonceKey, "1", { expirationTtl: 300 });
    }
  } catch (err) {
    console.error(JSON.stringify({ ns: "tee", event: "nonce_replay_error", error: err?.message, ts: new Date().toISOString() }));
    return jsonWithVerificationBindingAgent(
      request,
      { success: false, error: "Replay protection unavailable" },
      corsHeaders,
      503,
      rbh,
    );
  }

  const nearAiUrl = env.NEAR_AI_URL || "https://cloud-api.near.ai";
  // [Gap 2] Request-bound attestation: use nonce in attestation fetch
  const attestationNonce = nonce.length >= 64 && /^[0-9a-fA-F]+$/.test(nonce) ? nonce.toLowerCase().slice(0, 64) : await sha256Hex(nonce);

  let resp;
  try {
    const headers = {};
    if (env.NEAR_AI_API_KEY) headers["Authorization"] = `Bearer ${env.NEAR_AI_API_KEY}`;
    const reportUrl = `${nearAiUrl}/v1/attestation/report?signing_algo=ed25519&nonce=${attestationNonce}`;
    resp = await fetch(reportUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return jsonWithVerificationBindingAgent(
      request,
      { success: false, error: "NEAR AI attestation unreachable" },
      corsHeaders,
      502,
      rbh,
    );
  }

  if (!resp.ok) {
    return jsonWithVerificationBindingAgent(
      request,
      { success: false, error: `NEAR AI attestation HTTP ${resp.status}` },
      corsHeaders,
      502,
      rbh,
    );
  }

  const data = await resp.json().catch(() => null);
  if (!data) {
    return jsonWithVerificationBindingAgent(
      request,
      { success: false, error: "Invalid attestation response" },
      corsHeaders,
      502,
      rbh,
    );
  }
  // [Gap 2] Validate request_nonce when we sent nonce — request-bound attestation
  const echoed = (data?.gateway_attestation?.request_nonce || data?.request_nonce || "").toLowerCase().replace(/^0x/, "");
  if (!echoed || echoed !== attestationNonce) {
    return jsonWithVerificationBindingAgent(
      request,
      { success: false, error: "Attestation nonce mismatch — request binding failed" },
      corsHeaders,
      400,
      rbh,
    );
  }

  const mrEnclave = data?.gateway_attestation?.info?.mr_aggregated
                 || data?.info?.mr_aggregated
                 || data?.mrEnclave
                 || null;

  if (!mrEnclave || isZeroEnclave(mrEnclave)) {
    return jsonWithVerificationBindingAgent(
      request,
      { success: false, error: "Invalid or zero mrEnclave in attestation" },
      corsHeaders,
      502,
      rbh,
    );
  }

  const rawEnclave = String(env.TEE_EXPECTED_ENCLAVE_HASH || "").trim();
  const expectedHashes = rawEnclave.toLowerCase().split(",").map((h) => h.replace(/^0x/, "").trim()).filter(Boolean);
  if (expectedHashes.length === 0) {
    return jsonWithVerificationBindingAgent(
      request,
      {
        success: false,
        error: "TEE_EXPECTED_ENCLAVE_HASH not set — enclave pinning required. Run: wrangler secret put TEE_EXPECTED_ENCLAVE_HASH",
      },
      corsHeaders,
      503,
      rbh,
    );
  }
  const mrNorm = mrEnclave.toLowerCase().replace(/^0x/, "");
  let enclaveMatch = false;
  for (const expectedNorm of expectedHashes) {
    if (await timingSafeEqualAsync(mrNorm, expectedNorm)) {
      enclaveMatch = true;
      break;
    }
  }
  if (!enclaveMatch) {
    return jsonWithVerificationBindingAgent(
      request,
      {
        success: false,
        error: "mrEnclave does not match expected value",
        // [SEC] mrEnclave intentionally omitted — avoids echoing submitted value to probing callers
      },
      corsHeaders,
      400,
      rbh,
    );
  }

  const reportTs = data.timestamp ? new Date(data.timestamp).getTime() : 0;
  const ageMs = reportTs ? Date.now() - reportTs : 0;
  const stale = reportTs && ageMs > ATTESTATION_MAX_AGE_MS;

  // [Gap 4] Omit mrEnclave, signingAddress from response — reduce attestation exposure
  return jsonWithVerificationBindingAgent(
    request,
    {
      success: !stale,
      verified: !stale,
      provider: "near-ai-cloud",
      mode: "report-verify",
      verificationScope: "attestation_liveness_and_enclave_pinning",
      executionVerification: false,
      stale,
      ...(stale ? { warning: "Attestation report is older than 5 minutes" } : {}),
      enclaveMatch,
      reportAge: reportTs ? `${Math.round(ageMs / 1000)}s` : "unknown",
      agent: env.NEAR_AI_AGENT_ID || null,
    },
    corsHeaders,
    stale ? 400 : 200,
    rbh,
  );
}

// ============================================================================
// /tee/sign — TEE-attested managed wallet signing (TEE_PLATFORM_SIGN_URL target)
//
// Called by tee-signer worker. Uses NEAR AI Cloud nonce-bound attestation as the
// cryptographic signing primitive: the enclave signs a SHA-256 nonce derived from
// the signing request data, creating a TEE-attested proof of approval.
//
// Request body (from tee-signer):
//   { requestId, walletId, walletAddress, walletChain, policy, request }
//
// Response:
//   { success, signedTx, signature, txHash }
// ============================================================================

async function handleTeeManagedSign(request, env, corsHeaders) {
  const ctErr = requireJsonContentType(request, corsHeaders);
  if (ctErr) return ctErr;

  const body = await safeJsonBody(request, 65536);
  if (body === null) {
    return json({ success: false, error: "Invalid or too large JSON body (max 64 KB)" }, corsHeaders, 413);
  }

  const { requestId, walletId, walletAddress, walletChain, request: signRequest } = body || {};
  if (!requestId || !walletId || !walletChain) {
    return json({ success: false, error: "requestId, walletId, walletChain required" }, corsHeaders, 400);
  }

  // Build deterministic nonce binding the request to the enclave attestation.
  // This nonce is included in the NEAR AI attestation request — the enclave
  // attests to having seen and processed exactly this transaction data.
  const nonceSource = [
    requestId,
    walletId,
    String(walletChain),
    String(signRequest?.action   || ""),
    String(signRequest?.amount   || "0"),
    String(signRequest?.destination || ""),
    String(signRequest?.timestamp || new Date().toISOString()),
  ].join("|");
  const signNonce = await sha256Hex(nonceSource);

  // Fetch NEAR AI TEE attestation bound to this exact nonce.
  // The enclave signs the nonce with its Ed25519 key, proving the enclave approved this request.
  const attestResult = await fetchAndValidateAttestation(env, { nonce: signNonce });
  if (!attestResult.valid || !attestResult.report) {
    return json({
      success: false,
      error: `TEE attestation unavailable — cannot sign: ${attestResult.reason || "unknown"}`,
    }, corsHeaders, 502);
  }

  const attestation = attestResult.report;
  const mrEnclave      = attestation.mrEnclave      || attestation.mr_enclave     || attestation.mr_aggregated  || null;
  const signingAddress = attestation.signingAddress  || attestation.signing_address || null;
  const agentId        = attestation.agent           || env.NEAR_AI_AGENT_ID       || null;

  // The signedTx envelope carries the TEE-approved execution details.
  const signedTx = {
    requestId,
    walletId,
    walletAddress:  walletAddress || null,
    walletChain,
    action:      signRequest?.action      || null,
    amount:      signRequest?.amount      || null,
    destination: signRequest?.destination || null,
    payload:     signRequest?.payload     || null,
    approvedBy:  "near-ai-tee",
    mrEnclave,
    signingAddress,
    agentId,
    nonceBound:  signNonce,
    signedAt:    new Date().toISOString(),
  };

  // Signature format: tee:<mrEnclave_prefix>:<signingAddress_prefix>:<nonce_prefix>
  // Encodes which enclave signed what request — verifiable against the attestation report.
  const signature = (mrEnclave && signingAddress)
    ? `tee:${String(mrEnclave).slice(0, 16)}:${String(signingAddress).slice(0, 16)}:${signNonce.slice(0, 16)}`
    : null;

  return json({
    success: true,
    signedTx,
    signature,
    txHash: null,
  }, corsHeaders);
}

// ============================================================================
// /tee/sign-intent — cryptographic proof binding per intent
//
// Creates a SHA-256 binding hash over (intentId + winnerId + action + amount +
// asset + chain + mrEnclave + signingAddress + timestamp) so the proof is
// cryptographically tied to both the intent AND the specific TEE enclave.
// ============================================================================

async function handleSignIntent(request, env, corsHeaders) {
  const ctErr = requireJsonContentType(request, corsHeaders);
  if (ctErr) return ctErr;
  const body = await safeJsonBody(request, 65536);
  if (body === null) {
    return json({ success: false, error: "Invalid or too large JSON body (max 64 KB)" }, corsHeaders, 413);
  }

  const intentId = String(body?.intentId || "").trim();
  if (!intentId) return json({ success: false, error: "intentId required" }, corsHeaders, 400);

  // [M-1 FIX] Use request-bound nonce so the signed intent proof is tied to a
  // fresh enclave report, not a cached one (which could be up to 4 min old).
  const signNonce  = await sha256Hex(`sign:${intentId}:${Date.now()}`);
  const attestResult = await fetchAndValidateAttestation(env, { nonce: signNonce });
  if (!attestResult.valid || !attestResult.report || !attestResult.report.mrEnclave) {
    return json({ success: false, error: "TEE attestation unavailable — cannot sign" }, corsHeaders, 502);
  }
  const attestation = attestResult.report;

  const winnerId = String(body?.winnerId || body?.solverId || "");
  const action   = String(body?.action   || "");
  const amount   = String(body?.amount   || "");
  const asset    = String(body?.asset    || "");
  const chain    = String(body?.chain    || "");
  const ts       = new Date().toISOString();

  const preimage = [
    intentId, winnerId, action, amount, asset, chain,
    attestation.mrEnclave,
    attestation.signingAddress || "",
    ts,
  ].join("|");

  const bindingHash = await sha256Hex(preimage);

  return json({
    success: true,
    proof: {
      proofType:       "tee-bound",
      bindingHash,
      preimageFields:  ["intentId", "winnerId", "action", "amount", "asset", "chain", "mrEnclave", "signingAddress", "timestamp"],
      intentId,
      winnerId,
      mrEnclave:       attestation.mrEnclave,
      signingAddress:  attestation.signingAddress,
      signingAlgo:     attestation.algo || "ed25519",
      agent:           attestation.agent,
      agentHash:       attestation.agentHash,
      source:          "near-ai-cloud",
      cryptoBound:     true,
      timestamp:       ts,
    },
  }, corsHeaders);
}

// ============================================================================
// /tee/verify-settlement — cross-chain tx verification
// Supports: NEAR, Bitcoin, Stacks, Sui, Sei, Starknet, and all major EVM chains
// ============================================================================

const EVM_RPC_MAP = {
  ethereum:  "https://cloudflare-eth.com/v1/mainnet",
  base:      "https://mainnet.base.org",
  evm:       "https://cloudflare-eth.com/v1/mainnet",
  polygon:   "https://polygon-rpc.com",
  arbitrum:  "https://arb1.arbitrum.io/rpc",
  optimism:  "https://mainnet.optimism.io",
  bnb:       "https://bsc-dataseed.binance.org",
  bsc:       "https://bsc-dataseed.binance.org",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  linea:     "https://rpc.linea.build",
  scroll:    "https://rpc.scroll.io",
  zksync:    "https://mainnet.era.zksync.io",
  mantle:    "https://rpc.mantle.xyz",
  mode:      "https://mainnet.mode.network",
  blast:     "https://rpc.blast.io",
  sei:       "https://evm-rpc.sei-apis.com",
  // short-key aliases used by X402_{KEY}_* env vars
  eth:    "https://cloudflare-eth.com/v1/mainnet",
  poly:   "https://polygon-rpc.com",
  arb:    "https://arb1.arbitrum.io/rpc",
  op:     "https://mainnet.optimism.io",
  avax:   "https://api.avax.network/ext/bc/C/rpc",
  // Filecoin EVM — eip155:314, uses eth_getTransactionReceipt like all EVM chains
  fil:    "https://api.node.glif.io/rpc/v1",
  filecoin: "https://api.node.glif.io/rpc/v1",
  rootstock: "https://public-node.rsk.co",
};

// CAIP-2 chain ID → env key (short-key) — used to route EVM payment proofs to the right verifier
const CAIP2_TO_CHAIN_KEY = {
  "eip155:1":       "eth",
  "eip155:8453":    "base",
  "eip155:137":     "poly",
  "eip155:42161":   "arb",
  "eip155:10":      "op",
  "eip155:43114":   "avax",
  "eip155:56":      "bnb",
  "eip155:324":     "zksync",
  "eip155:59144":   "linea",
  "eip155:534352":  "scroll",
  "eip155:5000":    "mantle",
  "eip155:81457":   "blast",
  "eip155:34443":   "mode",
  "eip155:1329":    "sei",
  "eip155:314":     "fil",   // Filecoin EVM (FEVM)
  "eip155:30":      "rootstock",
};

// Reverse map — short key → CAIP-2 (used in verifyEvmSettlement return value)
const KEY_TO_CAIP2 = Object.fromEntries(Object.entries(CAIP2_TO_CHAIN_KEY).map(([k, v]) => [v, k]));

// Full set of valid EVM chain keys — any x-payment-chain hint matching these routes to verifyEvmSettlement
// Note: sol/solana and trx/tron are NOT in this set — they have dedicated non-EVM verifiers
const EVM_CHAIN_KEYS = new Set([
  "base", "eth", "ethereum", "poly", "polygon", "arb", "arbitrum",
  "op", "optimism", "avax", "avalanche", "bnb", "bsc",
  "zksync", "linea", "scroll", "mantle", "blast", "mode", "sei",
  "fil", "filecoin",   // Filecoin EVM (eip155:314) — fully EVM-compatible
  "rootstock", "rsk",
]);

const SUPPORTED_CHAINS = [
  "near", "bitcoin", "stacks", "sui", "starknet", "tron", "solana", "sol", "xrpl", "xrp",
  ...Object.keys(EVM_RPC_MAP),
];

// ── Solana — JSON-RPC getTransaction (success/fail only; same pattern as Sui) ──
async function verifySolanaTx(txHash, env, corsHeaders) {
  const rpcUrl = String(env.SOLANA_RPC_URL || env.X402_SOL_RPC_URL || "https://api.mainnet-beta.solana.com").replace(/\/+$/, "");
  try {
    const resp = await fetch(rpcUrl, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "getTransaction",
        // [G5] commitment=finalized prevents returning onChainVerified=true for pre-finality txs
        params:  [txHash, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const data = await resp.json().catch(() => null);
    const tx   = data?.result;
    if (!tx) {
      return json({
        success: true, onChainVerified: false,
        reason: "Transaction not found", txHash, chain: "solana",
      }, corsHeaders);
    }
    const txSuccess = tx.meta?.err === null || tx.meta?.err === undefined;
    return json({
      success: true,
      onChainVerified: true,
      txSuccess,
      chain: "solana",
      txHash,
      slot: tx.slot || null,
      blockTime: tx.blockTime || null,
      ts: new Date().toISOString(),
    }, corsHeaders);
  } catch (err) {
    return json({
      success: false, onChainVerified: false,
      error: err?.message || "Solana RPC error", txHash, chain: "solana",
    }, corsHeaders, 502);
  }
}

// ── XRPL — rippled tx command (validated + tesSUCCESS) ───────────────────────
async function verifyXrplTx(txHash, env, corsHeaders) {
  const apiUrl = String(env.XRP_RPC_URL || "https://s1.ripple.com:51234").replace(/\/+$/, "");
  try {
    const resp = await fetch(apiUrl, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "tx",
        params: [{ transaction: txHash, binary: false }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const data = await resp.json().catch(() => null);
    const tx   = data?.result;
    if (!tx) {
      return json({
        success: true, onChainVerified: false,
        reason: "Transaction not found", txHash, chain: "xrpl",
      }, corsHeaders);
    }
    const validated = tx.validated === true;
    const success   = tx.meta?.TransactionResult === "tesSUCCESS";
    const txSuccess = validated && success;
    return json({
      success: true,
      onChainVerified: validated,
      txSuccess,
      chain: "xrpl",
      txHash,
      ledgerIndex: tx.ledger_index || null,
      ts: new Date().toISOString(),
    }, corsHeaders);
  } catch (err) {
    return json({
      success: false, onChainVerified: false,
      error: err?.message || "XRPL RPC error", txHash, chain: "xrpl",
    }, corsHeaders, 502);
  }
}

async function handleVerifySettlement(request, env, corsHeaders) {
  const ctErr = requireJsonContentType(request, corsHeaders);
  if (ctErr) return ctErr;
  const body = await safeJsonBody(request, 65536);
  if (body === null) {
    return json({ success: false, error: "Invalid or too large JSON body (max 64 KB)" }, corsHeaders, 413);
  }

  const txHash = String(body?.txHash || "").trim();
  const chain  = String(body?.chain  || "").trim().toLowerCase();

  if (!txHash) return json({ success: false, error: "txHash required" }, corsHeaders, 400);
  if (!chain)  return json({ success: false, error: "chain required" }, corsHeaders, 400);

  if (txHash.startsWith("near:demo_") || txHash.startsWith("demo_")) {
    return json({
      success: true, onChainVerified: false, mode: "demo",
      reason: "Demo transaction — no on-chain record", txHash, chain,
    }, corsHeaders);
  }

  if (chain === "near")     return verifyNearTx(txHash, body, corsHeaders);
  if (chain === "bitcoin")  return verifyBitcoinTx(txHash, env, corsHeaders);
  if (chain === "stacks")   return verifyStacksTx(txHash, corsHeaders);
  if (chain === "sui")      return verifySuiTx(txHash, corsHeaders);
  if (chain === "starknet") return verifyStarknetTx(txHash, corsHeaders);
  if (chain === "tron")     return verifyTronTx(txHash, env, corsHeaders);
  if (chain === "solana" || chain === "sol") return verifySolanaTx(txHash, env, corsHeaders);
  if (chain === "xrpl" || chain === "xrp") return verifyXrplTx(txHash, env, corsHeaders);

  const rpcUrl = EVM_RPC_MAP[chain];
  if (rpcUrl) return verifyEvmTx(txHash, rpcUrl, chain, corsHeaders);

  return json({
    success: true, onChainVerified: false,
    reason: `Chain "${chain}" not yet supported`,
    txHash, chain, supportedChains: SUPPORTED_CHAINS,
  }, corsHeaders);
}

async function verifyNearTx(txHash, body, corsHeaders) {
  const senderId = String(body?.settledBy || body?.sender || "").trim();
  const senderLooksValid = /^[a-z0-9._-]+(\.near)?$/i.test(senderId);
  if (!senderLooksValid) {
    return json({
      success: true,
      onChainVerified: false,
      reason: "NEAR verification requires sender_account_id (settledBy/sender must be a valid NEAR account)",
      txHash, chain: "near",
    }, corsHeaders);
  }
  try {
    const resp = await fetch("https://rpc.mainnet.near.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // [FIX-3] Use EXPERIMENTAL_tx_status — no sender account ID required.
      // Falls back to tx with senderId if provided; never sends "system" which
      // is not a valid NEAR account and causes false negatives on every real tx.
      body: JSON.stringify({
        jsonrpc: "2.0", id: "verify",
        method: "EXPERIMENTAL_tx_status",
        params: { tx_hash: txHash, sender_account_id: senderId, wait_until: "EXECUTED" },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json().catch(() => null);

    if (data?.result?.status) {
      const status = data.result.status;
      const success = typeof status === "object"
        ? !!status.SuccessValue || !!status.SuccessReceiptId
        : status === "SuccessValue";

      return json({
        success: true,
        onChainVerified: true,
        txSuccess: success,
        chain: "near",
        txHash,
        blockHash: data.result.transaction_outcome?.block_hash || null,
        gasUsed: data.result.transaction_outcome?.outcome?.gas_burnt || null,
        ts: new Date().toISOString(),
      }, corsHeaders);
    }

    if (data?.error) {
      return json({
        success: true,
        onChainVerified: false,
        reason: data.error.message || "Transaction not found",
        txHash, chain: "near",
      }, corsHeaders);
    }
  } catch (err) {
    return json({
      success: false,
      onChainVerified: false,
      error: "NEAR RPC error",
      txHash, chain: "near",
    }, corsHeaders, 502);
  }

  return json({ success: true, onChainVerified: false, reason: "Unknown RPC response", txHash, chain: "near" }, corsHeaders);
}

async function verifyEvmTx(txHash, rpcUrl, chain, corsHeaders) {
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt",
        params: [txHash],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json().catch(() => null);

    if (data?.result) {
      const receipt = data.result;
      const txSuccess = receipt.status === "0x1";
      return json({
        success: true,
        onChainVerified: true,
        txSuccess,
        chain,
        txHash,
        blockNumber: receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null,
        gasUsed: receipt.gasUsed ? parseInt(receipt.gasUsed, 16) : null,
        from: receipt.from || null,
        to: receipt.to || null,
        ts: new Date().toISOString(),
      }, corsHeaders);
    }

    return json({
      success: true,
      onChainVerified: false,
      reason: "Transaction receipt not found",
      txHash, chain,
    }, corsHeaders);

  } catch (err) {
    return json({
      success: false,
      onChainVerified: false,
      error: "EVM RPC error",
      txHash, chain,
    }, corsHeaders, 502);
  }
}

// ============================================================================
// Bitcoin — via Blockstream API (mempool.space fallback)
// ============================================================================

const BITCOIN_MIN_CONFIRMATIONS = 6; // [H-03] default; override via env.BITCOIN_MIN_CONFIRMATIONS

async function verifyBitcoinTx(txHash, env, corsHeaders) {
  const minConf = Math.max(1, parseInt(env?.BITCOIN_MIN_CONFIRMATIONS || BITCOIN_MIN_CONFIRMATIONS, 10) || BITCOIN_MIN_CONFIRMATIONS);
  const baseApis = ["https://blockstream.info/api", "https://mempool.space/api"];

  for (const base of baseApis) {
    try {
      const txResp = await fetch(`${base}/tx/${txHash}`, { signal: AbortSignal.timeout(8000) });
      if (!txResp.ok) continue;
      const tx = await txResp.json().catch(() => null);
      if (!tx) continue;

      const confirmed = !!tx.status?.confirmed;
      let confirmations = 0;
      if (confirmed && tx.status?.block_height != null) {
        const tipResp = await fetch(`${base}/blocks/tip/height`, { signal: AbortSignal.timeout(5000) });
        if (tipResp.ok) {
          const tip = parseInt(await tipResp.text(), 10);
          if (!isNaN(tip)) confirmations = Math.max(0, tip - tx.status.block_height);
        }
      }
      const sufficient = confirmed && confirmations >= minConf;

      return json({
        success: true,
        onChainVerified: true,
        txSuccess: sufficient,
        chain: "bitcoin",
        txHash,
        blockHeight: tx.status?.block_height || null,
        blockHash: tx.status?.block_hash || null,
        fee: tx.fee || null,
        size: tx.size || null,
        confirmed,
        confirmations,
        minConfirmations: minConf,
        inputs: tx.vin?.length || 0,
        outputs: tx.vout?.length || 0,
        totalOutputSats: tx.vout?.reduce((s, o) => s + (o.value || 0), 0) || null,
        ts: new Date().toISOString(),
      }, corsHeaders);
    } catch { /* try next */ }
  }

  return json({
    success: true, onChainVerified: false,
    reason: "Bitcoin transaction not found or APIs unreachable",
    txHash, chain: "bitcoin",
  }, corsHeaders);
}

// ============================================================================
// Stacks — via Hiro API
// ============================================================================

async function verifyStacksTx(txHash, corsHeaders) {
  const url = `https://api.hiro.so/extended/v1/tx/${txHash}`;
  try {
    const resp = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      return json({
        success: true, onChainVerified: false,
        reason: `Stacks API returned ${resp.status}`,
        txHash, chain: "stacks",
      }, corsHeaders);
    }

    const tx = await resp.json().catch(() => null);
    if (!tx || !tx.tx_id) {
      return json({
        success: true, onChainVerified: false,
        reason: "Transaction not found", txHash, chain: "stacks",
      }, corsHeaders);
    }

    const txSuccess = tx.tx_status === "success";
    return json({
      success: true,
      onChainVerified: true,
      txSuccess,
      chain: "stacks",
      txHash,
      txStatus: tx.tx_status,
      txType: tx.tx_type,
      blockHeight: tx.block_height || null,
      blockHash: tx.block_hash || null,
      burnBlockHeight: tx.burn_block_height || null,
      sender: tx.sender_address || null,
      fee: tx.fee_rate || null,
      nonce: tx.nonce ?? null,
      contractCall: tx.contract_call ? {
        contractId: tx.contract_call.contract_id,
        functionName: tx.contract_call.function_name,
      } : null,
      ts: new Date().toISOString(),
    }, corsHeaders);
  } catch (err) {
    return json({
      success: false, onChainVerified: false,
      error: "Stacks API error",
      txHash, chain: "stacks",
    }, corsHeaders, 502);
  }
}

// ============================================================================
// Sui — via Sui JSON-RPC
// ============================================================================

async function verifySuiTx(txHash, corsHeaders) {
  const rpcUrl = "https://fullnode.mainnet.sui.io:443";
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "sui_getTransactionBlock",
        params: [txHash, { showEffects: true, showInput: true }],
      }),
      signal: AbortSignal.timeout(8000),
    });

    const data = await resp.json().catch(() => null);
    if (data?.result) {
      const effects = data.result.effects;
      const txSuccess = effects?.status?.status === "success";
      return json({
        success: true,
        onChainVerified: true,
        txSuccess,
        chain: "sui",
        txHash,
        status: effects?.status?.status || null,
        gasUsed: effects?.gasUsed ? {
          computationCost: effects.gasUsed.computationCost,
          storageCost: effects.gasUsed.storageCost,
          storageRebate: effects.gasUsed.storageRebate,
        } : null,
        checkpoint: data.result.checkpoint || null,
        sender: data.result.transaction?.data?.sender || null,
        ts: new Date().toISOString(),
      }, corsHeaders);
    }

    if (data?.error) {
      return json({
        success: true, onChainVerified: false,
        reason: data.error.message || "Transaction not found",
        txHash, chain: "sui",
      }, corsHeaders);
    }
  } catch (err) {
    return json({
      success: false, onChainVerified: false,
      error: "Sui RPC error",
      txHash, chain: "sui",
    }, corsHeaders, 502);
  }

  return json({
    success: true, onChainVerified: false,
    reason: "Unknown Sui RPC response", txHash, chain: "sui",
  }, corsHeaders);
}

// ============================================================================
// Starknet — via public gateway RPC
// ============================================================================

async function verifyStarknetTx(txHash, corsHeaders) {
  const rpcUrl = "https://free-rpc.nethermind.io/mainnet-juno/v0_7";
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "starknet_getTransactionReceipt",
        params: [txHash],
      }),
      signal: AbortSignal.timeout(8000),
    });

    const data = await resp.json().catch(() => null);
    if (data?.result) {
      const receipt = data.result;
      const finality = receipt.finality_status || receipt.status || null;
      const execution = receipt.execution_status || null;
      const txSuccess = execution === "SUCCEEDED" || finality === "ACCEPTED_ON_L1" || finality === "ACCEPTED_ON_L2";

      return json({
        success: true,
        onChainVerified: true,
        txSuccess,
        chain: "starknet",
        txHash,
        finalityStatus: finality,
        executionStatus: execution,
        blockNumber: receipt.block_number ?? null,
        blockHash: receipt.block_hash || null,
        actualFee: receipt.actual_fee ? {
          amount: receipt.actual_fee.amount,
          unit: receipt.actual_fee.unit,
        } : null,
        type: receipt.type || null,
        ts: new Date().toISOString(),
      }, corsHeaders);
    }

    if (data?.error) {
      return json({
        success: true, onChainVerified: false,
        reason: data.error.message || "Transaction not found",
        txHash, chain: "starknet",
      }, corsHeaders);
    }
  } catch (err) {
    return json({
      success: false, onChainVerified: false,
      error: "Starknet RPC error",
      txHash, chain: "starknet",
    }, corsHeaders, 502);
  }

  return json({
    success: true, onChainVerified: false,
    reason: "Unknown Starknet RPC response", txHash, chain: "starknet",
  }, corsHeaders);
}

// ============================================================================
// TRON — TronGrid /v1/transactions/{txId} verification
// ============================================================================

async function verifyTronTx(txHash, env, corsHeaders) {
  const apiUrl = String(env.TRON_RPC_URL || env.X402_TRX_RPC_URL || "https://api.trongrid.io").replace(/\/+$/, "");
  try {
    const headers = { accept: "application/json" };
    if (env.X402_TRX_API_KEY) headers["TRON-PRO-API-KEY"] = env.X402_TRX_API_KEY;

    const resp = await fetch(`${apiUrl}/v1/transactions/${encodeURIComponent(txHash)}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json().catch(() => null);
    const txArr = data?.data;

    if (!Array.isArray(txArr) || txArr.length === 0) {
      return json({
        success: true, onChainVerified: false,
        reason: "TRON transaction not found",
        txHash, chain: "tron",
      }, corsHeaders);
    }

    const tx = txArr[0] || {};
    const contractRet = tx?.ret?.[0]?.contractRet || tx?.contractRet || null;
    const txSuccess = String(contractRet || "").toUpperCase() === "SUCCESS";

    return json({
      success: true,
      onChainVerified: true,
      txSuccess,
      chain: "tron",
      txHash,
      blockNumber: tx.blockNumber || null,
      contractResult: contractRet || null,
      explorerUrl: `https://tronscan.org/#/transaction/${txHash}`,
      ts: new Date().toISOString(),
    }, corsHeaders);
  } catch (err) {
    return json({
      success: false, onChainVerified: false,
      error: "TRON RPC error",
      txHash, chain: "tron",
    }, corsHeaders, 502);
  }
}

async function verifyTronTxRaw(txHash, env) {
  const apiUrl = String(env.TRON_RPC_URL || env.X402_TRX_RPC_URL || "https://api.trongrid.io").replace(/\/+$/, "");
  try {
    const headers = { accept: "application/json" };
    if (env.X402_TRX_API_KEY) headers["TRON-PRO-API-KEY"] = env.X402_TRX_API_KEY;

    const resp = await fetch(`${apiUrl}/v1/transactions/${encodeURIComponent(txHash)}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json().catch(() => null);
    const txArr = data?.data;
    if (!Array.isArray(txArr) || txArr.length === 0) {
      return { verified: false, success: false, chain: "tron", txHash, error: "tx_not_found" };
    }
    const tx = txArr[0] || {};
    const contractRet = tx?.ret?.[0]?.contractRet || tx?.contractRet || null;
    const txSuccess = String(contractRet || "").toUpperCase() === "SUCCESS";
    return { verified: true, success: txSuccess, chain: "tron", txHash };
  } catch {
    return { verified: false, success: false, chain: "tron", txHash, error: "rpc_error" };
  }
}

// ============================================================================
// LayerZero — cross-chain message verification via LayerZero Scan API
// ============================================================================

async function handleVerifyLayerZero(request, env, corsHeaders) {
  const ctErr = requireJsonContentType(request, corsHeaders);
  if (ctErr) return ctErr;
  const body = await safeJsonBody(request, 65536);
  if (body === null) {
    return json({ success: false, error: "Invalid or too large JSON body (max 64 KB)" }, corsHeaders, 413);
  }

  const messageHash = String(body?.messageHash || body?.guid || body?.txHash || "").trim();
  const srcChain    = String(body?.srcChain || body?.fromChain || "").trim();
  const dstChain    = String(body?.dstChain || body?.toChain || "").trim();
  const srcEid      = body?.srcEid || null;
  const dstEid      = body?.dstEid || null;

  if (!messageHash) {
    return json({ success: false, error: "messageHash (or guid or txHash) required" }, corsHeaders, 400);
  }

  const attestation = await fetchAttestation(env);

  const scanApis = [
    `https://scan.layerzero-api.com/v1/messages/tx/${messageHash}`,
    `https://api-mainnet.layerzero-scan.com/tx/${messageHash}`,
  ];

  for (const url of scanApis) {
    try {
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) continue;
      const data = await resp.json().catch(() => null);
      if (!data) continue;

      const messages = data.messages || data.data || (Array.isArray(data) ? data : [data]);
      if (messages.length === 0) continue;

      const msg = messages[0];
      const status = msg.status || msg.mainStatus || "unknown";
      const delivered = ["DELIVERED", "INFLIGHT_DELIVERED", "SUCCEEDED"].includes(status.toUpperCase());


      return json({
        success: true,
        layerZero: {
          verified: true,
          delivered,
          status,
          messageHash,
          srcChainId: msg.srcChainId || msg.srcEid || srcEid,
          dstChainId: msg.dstChainId || msg.dstEid || dstEid,
          srcTxHash: msg.srcTxHash || msg.srcUaAddress || null,
          dstTxHash: msg.dstTxHash || null,
          srcBlockNumber: msg.srcBlockNumber || null,
          dstBlockNumber: msg.dstBlockNumber || null,
          nonce: msg.nonce ?? null,
          created: msg.created || msg.createdAt || null,
          updated: msg.updated || msg.updatedAt || null,
        },
        srcChain: srcChain || null,
        dstChain: dstChain || null,
        ...(attestation ? { teeAttestation: attestation } : {}),
        ts: new Date().toISOString(),
      }, corsHeaders);
    } catch { /* try next API */ }
  }

  // Fallback: if we have a source tx hash, try verifying it on-chain directly
  if (srcChain) {
    const rpcUrl = EVM_RPC_MAP[srcChain.toLowerCase()];
    if (rpcUrl) {
      try {
        const evmResp = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "eth_getTransactionReceipt",
            params: [messageHash],
          }),
          signal: AbortSignal.timeout(8000),
        });
        const evmData = await evmResp.json().catch(() => null);
        if (evmData?.result) {
          const receipt = evmData.result;
          return json({
            success: true,
            layerZero: {
              verified: true,
              delivered: receipt.status === "0x1",
              status: receipt.status === "0x1" ? "SRC_TX_CONFIRMED" : "SRC_TX_FAILED",
              messageHash,
              srcChainId: srcEid,
              dstChainId: dstEid,
              note: "Verified source tx on-chain; LayerZero Scan API unavailable for delivery status",
            },
            srcChain,
            dstChain: dstChain || null,
            onChainReceipt: {
              blockNumber: receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null,
              gasUsed: receipt.gasUsed ? parseInt(receipt.gasUsed, 16) : null,
              from: receipt.from, to: receipt.to,
            },
            ...(attestation ? { teeAttestation: attestation } : {}),
            ts: new Date().toISOString(),
          }, corsHeaders);
        }
      } catch { /* fall through */ }
    }
  }

  return json({
    success: true,
    layerZero: {
      verified: false,
      status: "NOT_FOUND",
      messageHash,
      reason: "Message not found in LayerZero Scan or on-chain",
    },
    srcChain: srcChain || null,
    dstChain: dstChain || null,
    ts: new Date().toISOString(),
  }, corsHeaders);
}

// ============================================================================
// Intent lifecycle validation — verifies full execution pipeline with TEE proof
//
// Validates: created → bid accepted → TEE proof bound → settlement verified
// Fetches the intent from the gateway DO, checks each stage, and returns
// a TEE-attested validation result.
// ============================================================================

async function handleVerifyIntent(request, env, corsHeaders) {
  const ctErr = requireJsonContentType(request, corsHeaders);
  if (ctErr) return ctErr;
  const body = await safeJsonBody(request, 65536);
  if (body === null) {
    return json({ success: false, error: "Invalid or too large JSON body (max 64 KB)" }, corsHeaders, 413);
  }

  const intentId = String(body?.intentId || "").trim();
  if (!intentId) return json({ success: false, error: "intentId required" }, corsHeaders, 400);

  const gatewayBase = env.GATEWAY_URL || "https://api.yieldagentx402.app";

  // Fetch intent state from gateway
  let intent = null;
  try {
    const resp = await fetch(`${gatewayBase}/api/intents/${intentId}`, {
      headers: (() => { const k = String(env.INTERNAL_KEY_VERIFY || env.INTERNAL_SHARED_KEY || "").trim(); return k ? { "x-internal-key": k } : {}; })(),
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      intent = data?.intent || null;
    }
  } catch { /* gateway unreachable */ }

  if (!intent) {
    return json({
      success: false,
      error: "Intent not found or gateway unreachable",
      intentId,
    }, corsHeaders, 404);
  }

  // Validate each stage of the lifecycle
  const stages = {};

  // Stage 1: Created
  stages.created = {
    valid: !!intent.createdAt,
    timestamp: intent.createdAt || null,
    submittedBy: intent.submittedBy || null,
  };

  // Stage 2: Auction (bids received, winner selected)
  const hasBids = Array.isArray(intent.bids) && intent.bids.length > 0;
  const hasWinner = !!intent.winningBid;
  stages.auction = {
    valid: hasBids || ["settled", "settling", "evaluating"].includes(intent.status),
    bidCount: intent.bids?.length || 0,
    winnerSelected: hasWinner,
    winnerId: intent.winningBid?.solverId || null,
    bidDeadline: intent.bidDeadline ? new Date(intent.bidDeadline).toISOString() : null,
  };

  // Stage 3: TEE proof binding
  const hasProof = !!intent.proof;
  stages.teeProof = {
    valid: hasProof,
    proofType: intent.proof?.proofType || null,
    bindingHash: intent.proof?.bindingHash || null,
    mrEnclave: intent.proof?.mrEnclave || null,
    cryptoBound: intent.proof?.cryptoBound || false,
  };

  // Stage 4: Settlement
  const hasSettlement = !!intent.settlement;
  stages.settlement = {
    valid: hasSettlement,
    txHash: intent.settlement?.txHash || null,
    chain: intent.settlement?.chain || intent.chain || null,
    settledBy: intent.settlement?.settledBy || null,
    settledAt: intent.settlement?.settledAt || null,
  };

  // Stage 5: Attestations
  const attestations = intent.attestations || [];
  stages.attestations = {
    valid: attestations.length > 0,
    count: attestations.length,
    sources: attestations.map((a) => a.source || a.provider || "unknown"),
  };

  // If settlement exists, verify the tx on-chain
  let onChainVerification = null;
  if (hasSettlement && intent.settlement?.txHash && intent.settlement?.chain) {
    try {
      const chain = intent.settlement.chain.toLowerCase();
      const txHash = intent.settlement.txHash;

      if (chain === "near") {
        onChainVerification = await verifyNearTxRaw(txHash, intent.settlement.settledBy);
      } else if (chain === "tron") {
        onChainVerification = await verifyTronTxRaw(txHash, env);
      } else if (chain === "solana" || chain === "sol") {
        onChainVerification = await verifySolanaTxRaw(txHash, env);
      } else if (chain === "sui") {
        onChainVerification = await verifySuiTxRaw(txHash, env);
      } else if (chain === "starknet") {
        onChainVerification = await verifyStarknetTxRaw(txHash, env);
      } else if (chain === "filecoin" || chain === "fil") {
        onChainVerification = await verifyFilecoinTxRaw(txHash, env);
      } else if (chain === "xrpl" || chain === "xrp") {
        onChainVerification = await verifyXrplTxRaw(txHash, env);
      } else if (EVM_RPC_MAP[chain]) {
        onChainVerification = await verifyEvmTxRaw(txHash, EVM_RPC_MAP[chain]);
      } else if (chain === "bitcoin") {
        onChainVerification = await verifyBitcoinTxRaw(txHash, env);
      } else if (chain === "stacks") {
        onChainVerification = await verifyStacksTxRaw(txHash);
      }
    } catch { /* on-chain check failed, non-fatal */ }
  }
  const settlementOnChainValid = !!(onChainVerification?.verified && onChainVerification?.success);
  if (hasSettlement) {
    stages.settlement.onChainVerified = settlementOnChainValid;
    stages.settlement.valid = settlementOnChainValid;
  }

  // Compute overall validation
  const allStagesValid = stages.created.valid && stages.auction.valid && stages.teeProof.valid && stages.settlement.valid;
  const pipelineStatus = intent.status === "settled" && allStagesValid ? "fully_validated" :
    intent.status === "settled" ? "settled_partial_validation" :
    intent.status === "expired" || intent.status === "failed" ? intent.status :
    "in_progress";

  // Attach TEE attestation to the validation itself
  const attestation = await fetchAttestation(env);

  const validationHash = await sha256Hex([
    intentId,
    intent.status,
    intent.proof?.bindingHash || "",
    intent.settlement?.txHash || "",
    String(settlementOnChainValid),
    String(stages.attestations.count || 0),
  ].join("|"));

  return json({
    success: true,
    intentId,
    status: intent.status,
    pipelineStatus,
    action: intent.action,
    asset: intent.asset,
    amount: intent.amount,
    chain: intent.chain,
    adapter: intent.adapter,
    stages,
    onChainVerification,
    validationHash,
    ...(attestation ? { teeAttestation: attestation } : {}),
    ts: new Date().toISOString(),
  }, corsHeaders);
}

// Raw verification helpers (return data, don't return Response objects)
async function verifyNearTxRaw(txHash, sender) {
  const senderId = String(sender || "").trim();
  const senderLooksValid = /^[a-z0-9._-]+(\.near)?$/i.test(senderId);
  if (!senderLooksValid) return { verified: false, success: false, chain: "near", txHash, error: "sender_account_id_required" };
  try {
    const resp = await fetch("https://rpc.mainnet.near.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // [FIX-3] EXPERIMENTAL_tx_status does not require sender account ID.
      body: JSON.stringify({ jsonrpc: "2.0", id: "v", method: "EXPERIMENTAL_tx_status",
        params: { tx_hash: txHash, sender_account_id: senderId, wait_until: "EXECUTED" } }),
      signal: AbortSignal.timeout(6000),
    });
    const data = await resp.json().catch(() => null);
    if (data?.result?.status) {
      const status = data.result.status;
      return { verified: true, success: !!(status.SuccessValue || status.SuccessReceiptId), chain: "near", txHash };
    }
    return { verified: false, chain: "near", txHash };
  } catch { return { verified: false, chain: "near", txHash, error: "RPC unreachable" }; }
}

async function verifyEvmTxRaw(txHash, rpcUrl) {
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
      signal: AbortSignal.timeout(6000),
    });
    const data = await resp.json().catch(() => null);
    if (data?.result) {
      return { verified: true, success: data.result.status === "0x1", txHash };
    }
    return { verified: false, txHash };
  } catch { return { verified: false, txHash, error: "RPC unreachable" }; }
}

async function verifyBitcoinTxRaw(txHash, env) {
  const minConf = Math.max(1, parseInt(env?.BITCOIN_MIN_CONFIRMATIONS || BITCOIN_MIN_CONFIRMATIONS, 10) || BITCOIN_MIN_CONFIRMATIONS);
  try {
    const resp = await fetch(`https://blockstream.info/api/tx/${txHash}`, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) return { verified: false, chain: "bitcoin", txHash };
    const tx = await resp.json().catch(() => null);
    if (!tx?.status?.confirmed) return { verified: true, success: false, chain: "bitcoin", txHash };
    const blockHeight = tx.status?.block_height;
    if (blockHeight == null) return { verified: true, success: false, chain: "bitcoin", txHash };
    const tipResp = await fetch("https://blockstream.info/api/blocks/tip/height", { signal: AbortSignal.timeout(5000) });
    if (!tipResp.ok) return { verified: true, success: false, chain: "bitcoin", txHash };
    const tip = parseInt(await tipResp.text(), 10);
    if (isNaN(tip)) return { verified: true, success: false, chain: "bitcoin", txHash };
    const confirmations = Math.max(0, tip - blockHeight);
    return { verified: true, success: confirmations >= minConf, chain: "bitcoin", txHash, confirmations };
  } catch { return { verified: false, chain: "bitcoin", txHash, error: "API unreachable" }; }
}

async function verifyStacksTxRaw(txHash) {
  try {
    const resp = await fetch(`https://api.hiro.so/extended/v1/tx/${txHash}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return { verified: false, chain: "stacks", txHash };
    const tx = await resp.json().catch(() => null);
    return { verified: true, success: tx?.tx_status === "success", chain: "stacks", txHash };
  } catch { return { verified: false, chain: "stacks", txHash, error: "API unreachable" }; }
}

async function verifySolanaTxRaw(txHash, env) {
  const rpc = String(env?.SOLANA_RPC_URL || env?.X402_SOL_RPC_URL || "https://api.mainnet-beta.solana.com").replace(/\/+$/, "");
  try {
    const resp = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // [G5] commitment=finalized — only report success for fully settled Solana txs
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [txHash, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json().catch(() => null);
    const tx = data?.result;
    if (!tx) return { verified: false, chain: "solana", txHash };
    const ok = tx.meta?.err == null;
    return { verified: true, success: ok, chain: "solana", txHash };
  } catch { return { verified: false, chain: "solana", txHash, error: "RPC unreachable" }; }
}

async function verifySuiTxRaw(txHash, env) {
  const rpc = String(env?.SUI_RPC_URL || "https://fullnode.mainnet.sui.io").replace(/\/+$/, "");
  try {
    const resp = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sui_getTransactionBlock", params: [txHash, { showEffects: true, showInput: false }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json().catch(() => null);
    const tx = data?.result;
    if (!tx) return { verified: false, chain: "sui", txHash };
    const ok = tx.effects?.status?.status === "success";
    return { verified: true, success: ok, chain: "sui", txHash };
  } catch { return { verified: false, chain: "sui", txHash, error: "RPC unreachable" }; }
}

async function verifyStarknetTxRaw(txHash, env) {
  const rpc = String(env?.STARKNET_RPC_URL || "https://free-rpc.nethermind.io/mainnet-juno/v0_7").replace(/\/+$/, "");
  try {
    const resp = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "starknet_getTransactionReceipt", params: [txHash] }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json().catch(() => null);
    const receipt = data?.result;
    if (!receipt) return { verified: false, chain: "starknet", txHash };
    const ok = (receipt.execution_status || "") === "SUCCEEDED";
    return { verified: true, success: ok, chain: "starknet", txHash };
  } catch { return { verified: false, chain: "starknet", txHash, error: "RPC unreachable" }; }
}

async function verifyFilecoinTxRaw(txHash, env) {
  const rpc = String(env?.FILECOIN_RPC_URL || "https://api.node.glif.io/rpc/v1").replace(/\/+$/, "");
  try {
    const resp = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json().catch(() => null);
    const rec = data?.result;
    if (!rec) return { verified: false, chain: "filecoin", txHash };
    const ok = String(rec.status || "").toLowerCase() === "0x1";
    return { verified: true, success: ok, chain: "filecoin", txHash };
  } catch { return { verified: false, chain: "filecoin", txHash, error: "RPC unreachable" }; }
}

async function verifyXrplTxRaw(txHash, env) {
  const rpc = String(env?.XRP_RPC_URL || "https://s1.ripple.com:51234").replace(/\/+$/, "");
  try {
    const resp = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "tx", params: [{ transaction: txHash, binary: false }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json().catch(() => null);
    const tx = data?.result;
    if (!tx) return { verified: false, chain: "xrpl", txHash };
    const ok = tx.validated === true && tx.meta?.TransactionResult === "tesSUCCESS";
    return { verified: true, success: ok, chain: "xrpl", txHash };
  } catch { return { verified: false, chain: "xrpl", txHash, error: "RPC unreachable" }; }
}

// ============================================================================
// Shared: SHA-256 hex digest
// ============================================================================

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// Jupiter — real Solana DEX quote via public v6 API
// ============================================================================

// ============================================================================
// Live Adapter Engine — real protocol data (DeFiLlama + dedicated APIs)
// ============================================================================

// Maps adapter shortKey → DeFiLlama project name (for yields.llama.fi/pools)
const DL_PROJECT = {
  aave:       "aave-v3",
  euler:      "euler-v2",
  silo:       "silo-v2",
  zest:       "zest-v1",
  lombard:    "lombard-lbtc",
  solv:       "solv-basis-trading",
  endur:      "endur",
  kamino:     "kamino-lend",
  marinade:   "marinade-liquid-staking",
  jito:       "jito-liquid-staking",
  justlend:   "justlend",
  glif:       "glif",
  navi:       "navi-lending",
  scallop:    "scallop-lend",
  benqi:      "benqi-staked-avax",
  usual:      "usual-usd0",
  ethena:     "ethena-usde",
  yearn:      "yearn-finance",
  convex:     "convex-finance",
  renzo:      "renzo",
  swell:      "swell-liquid-staking",
  fraxeth:    "frax-ether",
  bedrock:    "bedrock-unieth",
  pendle:     "pendle",
  beefy:      "beefy",
  lido:       "lido",
  rocketpool: "rocket-pool",
  compoundv3: "compound-v3",
  osmosis:    "osmosis-dex",
  curve:      "curve-dex",
  metapool:   "meta-pool",
  etherfi:    "ether.fi-stake",
  mantle:     "meth-protocol",
  amnis:      "amnis-finance",
  thevault:   "the-vault-liquid-staking",
  sushiswap:  "sushiswap-v3",
  ekubo:      "ekubo",
  vesu:       "vesu",
  katana:     "sushiswap-v3",
  cetus:      "cetus-clmm",
  morpho:     "morpho-blue",
  eigenlayer: "eigenlayer",
  sovryn:     "sovryn-dex",
};

// Preferred chain filter per adapter (lowercase, DeFiLlama chain names)
const DL_CHAIN = {
  aave:       "Base",
  euler:      "Ethereum",
  silo:       "Arbitrum",
  zest:       null,
  lombard:    "Ethereum",
  solv:       null,
  endur:      "Starknet",
  kamino:     "Solana",
  marinade:   "Solana",
  jito:       "Solana",
  justlend:   "Tron",
  glif:       "Filecoin",
  navi:       "Sui",
  scallop:    "Sui",
  benqi:      "Avalanche",
  usual:      "Ethereum",
  ethena:     "Ethereum",
  yearn:      "Ethereum",
  convex:     "Ethereum",
  renzo:      "Ethereum",
  swell:      "Ethereum",
  fraxeth:    "Ethereum",
  bedrock:    "Ethereum",
  pendle:     "Ethereum",
  beefy:      null,
  lido:       "Ethereum",
  rocketpool: "Ethereum",
  compoundv3: "Ethereum",
  osmosis:    null,
  curve:      "Ethereum",
  metapool:   null,
  etherfi:    "Ethereum",
  mantle:     "Ethereum",
  amnis:      "Aptos",
  thevault:   "Ethereum",
  sushiswap:  null,
  ekubo:      "Starknet",
  vesu:       "Starknet",
  katana:     null,
  cetus:      "Sui",
  morpho:     "Ethereum",
  eigenlayer: "Ethereum",
  sovryn:     "Rootstock",
};

// Adapters with dedicated protocol APIs (not DeFiLlama)
const DEDICATED_APIS = {
  lido:       { url: "https://eth-api.lido.fi/v1/protocol/steth/apr/sma", type: "lido" },
  marinade:   { url: "https://api.marinade.finance/msol/apy/1y",          type: "marinade" },
  metapool:   { url: "https://validators.narwallets.com/metrics_json",    type: "metapool" },
  linear:     { url: "https://validators.narwallets.com/metrics_json",        type: "linear" },
};

/** Public Meta Pool / LiNEAR dashboard metrics (includes stNEAR + LiNEAR rolling APY). */
const NEAR_LST_METRICS_URL = "https://validators.narwallets.com/metrics_json";
const NEAR_LST_ONCHAIN_TOLERANCE_FRAC = 0.0025;

async function nearViewCallFunction(rpcUrl, accountId, methodName, argsBase64 = "e30=") {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "lst-view-" + methodName,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: methodName,
        args_base64: argsBase64,
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await resp.json().catch(() => null);
  if (!data || data.error) throw new Error((data && data.error && data.error.message) || "NEAR RPC error");
  const r = data.result;
  if (!r || r.error) throw new Error((r && r.error) || "NEAR view error");
  if (!r.result || !r.result.length) throw new Error("empty NEAR view result");
  const raw = new TextDecoder().decode(new Uint8Array(r.result));
  return { raw, blockHeight: r.block_height, blockHash: r.block_hash };
}

function nearAmountFromYoctoString(yoctoStr) {
  const n = BigInt(String(yoctoStr));
  const y = 10n ** 24n;
  return Number((n * 1000000n) / y) / 1000000;
}

function metricsNearMatch(a, b) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return diff / scale <= NEAR_LST_ONCHAIN_TOLERANCE_FRAC;
}

/** Optional: compare narwallets metrics to NEAR `view_function` on meta-pool.near / linear-protocol.near. */
async function attachNearLstOnChainVerification(shortKey, metricsJson, env) {
  const rpcUrl = (env && env.NEAR_RPC_URL) || "https://rpc.mainnet.near.org";
  const base = { rpcUrl, kind: "near-rpc-view" };
  try {
    if (shortKey === "metapool") {
      const priceView = await nearViewCallFunction(rpcUrl, "meta-pool.near", "get_st_near_price");
      const yoctoInt = JSON.parse(priceView.raw);
      const stNearPriceNear = Number(BigInt(yoctoInt)) / 1e24;
      const metricsPrice = metricsJson && Number(metricsJson.st_near_price);
      const supplyView = await nearViewCallFunction(rpcUrl, "meta-pool.near", "ft_total_supply");
      const supplyYocto = BigInt(JSON.parse(supplyView.raw)).toString();
      return {
        ...base,
        contractId: "meta-pool.near",
        blockHeight: supplyView.blockHeight,
        views: ["get_st_near_price", "ft_total_supply"],
        stNearPriceNear,
        metricsStNearPrice: Number.isFinite(metricsPrice) ? metricsPrice : null,
        priceAlignedWithMetrics: metricsNearMatch(stNearPriceNear, metricsPrice),
        ftTotalSupplyYocto: supplyYocto,
      };
    }
    if (shortKey === "linear") {
      const sumView = await nearViewCallFunction(rpcUrl, "linear-protocol.near", "get_summary");
      const s = JSON.parse(sumView.raw);
      const totalStakedNear = nearAmountFromYoctoString(s.total_staked_near_amount);
      const ftPriceNear = nearAmountFromYoctoString(s.ft_price);
      const metricsStaked = metricsJson && Number(metricsJson.linear_staked);
      return {
        ...base,
        contractId: "linear-protocol.near",
        blockHeight: sumView.blockHeight,
        views: ["get_summary"],
        totalStakedNear,
        ftPriceNearPerLiNear: ftPriceNear,
        validatorsNum: s.validators_num,
        metricsLinearStakedNear: Number.isFinite(metricsStaked) ? metricsStaked : null,
        stakedAlignedWithMetrics: metricsNearMatch(totalStakedNear, metricsStaked),
      };
    }
  } catch (e) {
    return { ...base, error: (e && e.message) || String(e) };
  }
  return null;
}

async function fetchNearLstMetricsJson() {
  const r = await fetch(NEAR_LST_METRICS_URL, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`NEAR LST metrics HTTP ${r.status}`);
  return r.json();
}

function firstPositiveNumber(...candidates) {
  for (const v of candidates) {
    const n = typeof v === "number" ? v : parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Shared quote payload for Meta Pool (stNEAR) and LiNEAR from narwallets metrics. */
async function buildNearLiquidStakingQuote(shortKey, body, env) {
  const d = await fetchNearLstMetricsJson();
  let onChain = null;
  try {
    if (env && (shortKey === "metapool" || shortKey === "linear")) {
      onChain = await attachNearLstOnChainVerification(shortKey, d, env);
    }
  } catch { onChain = null; }
  if (shortKey === "metapool") {
    const tvlNative = d?.tvl ?? d?.total_actually_staked ?? null;
    const apy = firstPositiveNumber(
      d?.st_near_30_day_apy, d?.st_near_15_day_apy, d?.st_near_7_day_apy, d?.st_near_3_day_apy
    );
    if (apy == null) throw new Error("no stNEAR APY in metrics");
    const amt = parseFloat(body.amount || "1") || 1;
    return {
      source: "metapool-metrics-live",
      adapter: "metapool-near",
      result: {
        success: true, provenance: "protocol-native", source: "metapool-metrics-live",
        protocol: "metapool", asset: body.asset || "NEAR", symbol: "stNEAR", chain: "NEAR",
        apy, apyBase: apy, apyReward: 0,
        apyHorizon: d?.st_near_30_day_apy ? "30d" : "shorter-window",
        metricsUrl: NEAR_LST_METRICS_URL,
        tvlNative,
        amount: String(amt),
        estimatedYearlyYield: String((amt * apy / 100).toFixed(6)),
        fetchedAt: new Date().toISOString(),
        ...(onChain ? { onChainVerification: onChain } : {}),
      },
    };
  }
  if (shortKey === "linear") {
    const apy = firstPositiveNumber(
      d?.linear_30_day_apy, d?.linear_15_day_apy, d?.linear_7_day_apy, d?.linear_3_day_apy
    );
    if (apy == null) throw new Error("no LiNEAR APY in metrics");
    const stakedNear = d?.linear_staked;
    const nearUsd =
      d?.st_near_price_usd != null && d?.st_near_price
        ? Number(d.st_near_price_usd) / Number(d.st_near_price)
        : null;
    const tvlUsd =
      nearUsd != null && stakedNear != null && Number.isFinite(nearUsd * stakedNear)
        ? Math.round(stakedNear * nearUsd)
        : null;
    const amt = parseFloat(body.amount || "1") || 1;
    return {
      source: "linear-metrics-live",
      adapter: "linear-near",
      result: {
        success: true, provenance: "protocol-native", source: "linear-metrics-live",
        protocol: "linear", asset: body.asset || "NEAR", symbol: "LiNEAR", chain: "NEAR",
        apy, apyBase: apy, apyReward: 0,
        apyHorizon: d?.linear_30_day_apy ? "30d" : "shorter-window",
        metricsUrl: NEAR_LST_METRICS_URL,
        linearStakedNear: stakedNear,
        tvlUsd,
        note: "LiNEAR — linear-protocol.near; APY from validators.narwallets.com rolling averages",
        docsUrl: "https://docs.linearprotocol.org/",
        amount: String(amt),
        estimatedYearlyYield: String((amt * apy / 100).toFixed(6)),
        fetchedAt: new Date().toISOString(),
        ...(onChain ? { onChainVerification: onChain } : {}),
      },
    };
  }
  return null;
}

// DeFiLlama TVL-only adapters (no yield pools, use TVL API for TVL + category APY estimate)
const DL_TVL_SLUG = {
  rhea:       "rhea-lend",
  babylon:    "babylon-protocol",
  clovis:     "clovis",
  katana:     "katana-pre-launch",
  hermetica:  "hermetica",
  stackingdao:"stackingdao",
  lisa:       "lisa",
  alex:       "alex",
  secured:    "secured-finance-lending",
  vesu:       "vesu",
  xrpl_dex:   "xrpl-dex",
  sunswap:    "sunswap",
  stride:     "stride",
  bitcoinos:  "bitcoinos",
  bitlayer:   "bitlayer",
  bouncebit:  "bouncebit",
  velar:      "velar-protocol",
  arkadiko:   "arkadiko",
  charms:     "charms",
};

/** Default yield category for TVL-only quotes when `body.category` is omitted. */
const DL_TVL_CATEGORY_HINT = {
  velar: "vault",
  arkadiko: "lending",
};

// DeFiLlama yields: pick highest-TVL pool on a single chain (BTC L2 / sidechains).
const DL_DEFILLAMA_CHAIN_FIRST = {
  bob: "Bob",
  citrea: "Citrea",
  rootstock: "Rootstock",
  hyperliquid: "Hyperliquid L1",
};

// Category APY estimates for TVL-only adapters (used when no pool yield data available)
const CATEGORY_APY_EST = {
  lending:        { min: 4.0,  max: 9.0,  asset: "USDC" },
  vault:          { min: 5.0,  max: 14.0, asset: "BTC"  },
  "btcfi":        { min: 3.0,  max: 10.0, asset: "BTC"  },
  "liquid-staking": { min: 3.5, max: 7.0, asset: "ETH" },
  dex:            { min: 5.0,  max: 20.0, asset: "USDC" },
  bridge:         { min: 0.0,  max: 0.0,  asset: "BTC"  },
  security:       { min: 0.0,  max: 0.0,  asset: "BTC"  },
  restaking:      { min: 2.0,  max: 6.0,  asset: "ETH"  },
  general:        { min: 3.0,  max: 8.0,  asset: "USDC" },
};

// Cache for DeFiLlama full pool list (in-memory, resets per worker invocation)
let _dlPoolsCache = null;
let _dlPoolsCachedAt = 0;
const DL_POOLS_TTL_MS = 5 * 60 * 1000; // 5 min

async function fetchDefiLlamaPools() {
  const now = Date.now();
  if (_dlPoolsCache && (now - _dlPoolsCachedAt) < DL_POOLS_TTL_MS) return _dlPoolsCache;
  const resp = await fetch("https://yields.llama.fi/pools", { signal: AbortSignal.timeout(12000) });
  if (!resp.ok) throw new Error(`DeFiLlama pools HTTP ${resp.status}`);
  const data = await resp.json();
  _dlPoolsCache = data.data || [];
  _dlPoolsCachedAt = now;
  return _dlPoolsCache;
}

async function fetchDefiLlamaTvlOnly(slug) {
  const resp = await fetch(`https://api.llama.fi/tvl/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const val = await resp.json();
  return typeof val === "number" ? val : null;
}

// Suilend — MAIN_POOL lending market (supply APR from on-chain reserve + interest curve; aligns with @suilend/sdk)
const SUILEND_WAD = 10n ** 18n;
const SUILEND_MAIN_LENDING_MARKET_ID =
  "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1";
const SUI_RPC_DEFAULT_URL = "https://fullnode.mainnet.sui.io";

/** Piecewise-linear borrow APR (% nominal) from utilization knots — on-chain values are hundredths of a percent; divide by 100 → % (SDK). */
function suilendBorrowAprPercent(utilPct, interestUtils, interestAprsRaw) {
  const u = Math.min(100, Math.max(0, Number(utilPct) || 0));
  const points = [];
  const n = Math.min(interestUtils.length, interestAprsRaw.length);
  for (let i = 0; i < n; i++) {
    points.push({ util: Number(interestUtils[i]), apr: Number(interestAprsRaw[i]) / 100 });
  }
  if (!points.length) return 0;
  if (u <= points[0].util) return points[0].apr;
  const last = points[points.length - 1];
  if (u >= last.util) return last.apr;
  for (let i = 1; i < points.length; i++) {
    const L = points[i - 1];
    const R = points[i];
    if (u >= L.util && u <= R.util) {
      const w = R.util === L.util ? 0 : (u - L.util) / (R.util - L.util);
      return L.apr + w * (R.apr - L.apr);
    }
  }
  return last.apr;
}

/** Deposit APR (% nominal) — SDK: (util/100)*(borrowApr/100)*(1-spreadFee)*100 */
function suilendDepositAprPercent(utilPct, borrowAprPct, spreadFeeBps) {
  const fee = 1 - Number(spreadFeeBps || 0) / 10000;
  return (utilPct / 100) * (borrowAprPct / 100) * fee * 100;
}

function suilendCoinTypeLower(reserveFields) {
  const ct = reserveFields.coin_type;
  const name = ct && ct.fields && ct.fields.name;
  return name ? String(name).toLowerCase() : "";
}

function suilendAssetMatches(assetHint, coinTypeLower) {
  if (!coinTypeLower) return false;
  const a = String(assetHint || "").trim().toUpperCase();
  if (!a) return true;
  const c = coinTypeLower;
  if (a === "SUI" && c.includes("::sui::sui")) return true;
  if (a === "USDC" &&
      (c.includes("5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf") ||
        c.includes("5d4b302506645c37ff133b98c4b50a406f1b29aa"))) return true;
  if (a === "USDT" && c.includes("c060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c")) return true;
  if (a === "WAL" && c.includes("wal")) return true;
  if (a === "DEEP" && c.includes("deep")) return true;
  if (a === "BUCK" && c.includes("buck")) return true;
  if (a === "FDUSD" && c.includes("fdusd")) return true;
  if (a === "USDY" && c.includes("usdy")) return true;
  if (a === "NAVX" && c.includes("navx")) return true;
  if ((a === "VSUI" || a === "HASUI") && c.includes(a.toLowerCase())) return true;
  if (a === "SEND" && c.includes("send")) return true;
  return c.includes(a.toLowerCase());
}

function suilendReserveMetrics(reserveFields) {
  const mintD = Number(reserveFields.mint_decimals || reserveFields.mintDecimals || 0);
  const availB = BigInt(String(reserveFields.available_amount ?? reserveFields.availableAmount ?? 0));
  const borWad = BigInt(String(reserveFields.borrowed_amount?.fields?.value ?? 0));
  const priceWad = BigInt(String(reserveFields.price?.fields?.value ?? 0));
  const cfgInner = reserveFields.config?.fields?.element?.fields;
  const interestUtils = cfgInner?.interest_rate_utils || [];
  const interestAprs = cfgInner?.interest_rate_aprs || [];
  const spreadFeeBps = Number(cfgInner?.spread_fee_bps ?? 0);
  const decScale = 10n ** BigInt(mintD);
  const den = SUILEND_WAD * decScale;
  let borrowedHuman = 0;
  if (den > 0n) {
    const q = borWad / den;
    const r = borWad % den;
    borrowedHuman = Number(q) + Number(r) / Number(den);
  }
  const availableHuman = decScale > 0n ? Number(availB) / Number(decScale) : 0;
  const deposited = borrowedHuman + availableHuman;
  const utilPct = deposited > 0 ? (borrowedHuman / deposited) * 100 : 0;
  const utilsNum = interestUtils.map((x) => Number(x));
  const borrowAprPct = suilendBorrowAprPercent(utilPct, utilsNum, interestAprs);
  const supplyAprPct = suilendDepositAprPercent(utilPct, borrowAprPct, spreadFeeBps);
  const priceUsd = Number(priceWad) / 1e18;
  const depositedUsd = deposited * (Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : 0);
  return {
    mintDecimals: mintD,
    availableHuman,
    borrowedHuman,
    deposited,
    utilPct,
    borrowAprPct,
    supplyAprPct,
    spreadFeeBps,
    priceUsd,
    depositedUsd,
    coinType: suilendCoinTypeLower(reserveFields),
    arrayIndex: reserveFields.array_index ?? reserveFields.arrayIndex,
  };
}

async function fetchSuilendReserveFieldsList(env) {
  const rpc =
    (env && (env.SUI_RPC_URL || env.SUI_RPC || env.SUILEND_SUI_RPC_URL)) || SUI_RPC_DEFAULT_URL;
  const marketId = (env && env.SUILEND_LENDING_MARKET_OBJECT_ID) || SUILEND_MAIN_LENDING_MARKET_ID;
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "suilend-market",
      method: "sui_getObject",
      params: [marketId, { showContent: true }],
    }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error || !data.result) return null;
  const content = data.result.data && data.result.data.content;
  if (!content || content.dataType !== "moveObject" || !content.fields || !Array.isArray(content.fields.reserves)) {
    return null;
  }
  return content.fields.reserves.map((r) => (r && r.fields ? r.fields : null)).filter(Boolean);
}

async function buildSuilendOnChainQuote(body, env) {
  let reserveList;
  try {
    reserveList = await fetchSuilendReserveFieldsList(env);
  } catch {
    return null;
  }
  if (!reserveList || !reserveList.length) return null;

  const asset = String(body.asset || body.token || "USDC").trim() || "USDC";
  const metricsRows = [];
  for (const rf of reserveList) {
    try {
      const m = suilendReserveMetrics(rf);
      if (!suilendAssetMatches(asset, m.coinType)) continue;
      metricsRows.push({ rf, m });
    } catch {
      /* skip malformed reserve */
    }
  }
  if (!metricsRows.length) return null;

  metricsRows.sort((a, b) => (b.m.depositedUsd || 0) - (a.m.depositedUsd || 0));
  const { m } = metricsRows[0];
  const amount = parseFloat(body.amount || "1000") || 1000;
  const supplyApy = m.supplyAprPct;
  const borrowApy = m.borrowAprPct;
  const estimatedYearlyYield = String(((amount * supplyApy) / 100).toFixed(6));

  return {
    success: true,
    provenance: "protocol-native",
    source: "sui-rpc-suilend",
    protocol: "suilend",
    asset,
    apy: supplyApy,
    borrowApy,
    utilizationPercent: m.utilPct,
    spreadFeeBps: m.spreadFeeBps,
    oraclePriceUsd: m.priceUsd,
    depositedTokens: m.deposited,
    borrowedTokens: m.borrowedHuman,
    availableTokens: m.availableHuman,
    reserveCoinType: m.coinType,
    reserveArrayIndex: m.arrayIndex,
    amount: String(amount),
    estimatedYearlyYield,
    note:
      "Supply and borrow APR derived from Suilend main market on-chain reserve state and published interest curve (same arithmetic as @suilend/sdk simulate helpers). Not a guaranteed future yield.",
    docsUrl: "https://www.suilend.fi/",
    lendingMarketObjectId: (env && env.SUILEND_LENDING_MARKET_OBJECT_ID) || SUILEND_MAIN_LENDING_MARKET_ID,
    fetchedAt: new Date().toISOString(),
  };
}

function pickBestPool(pools, project, chainHint, assetHint) {
  let candidates = pools.filter(p => p.project === project && p.apy > 0 && p.tvlUsd > 0);
  if (!candidates.length) candidates = pools.filter(p => p.project === project);
  if (chainHint) {
    const byChain = candidates.filter(p => p.chain && p.chain.toLowerCase() === chainHint.toLowerCase());
    if (byChain.length) candidates = byChain;
  }
  if (assetHint) {
    const byAsset = candidates.filter(p => p.symbol && p.symbol.toUpperCase().includes(assetHint.toUpperCase()));
    if (byAsset.length) candidates = byAsset;
  }
  return candidates.sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0))[0] || null;
}

function pickBestChainPool(pools, chainName, opts) {
  const project = opts && opts.project;
  const symbolIncludes = opts && opts.symbolIncludes;
  let c = pools.filter((p) => p.chain === chainName && p.apy > 0 && p.tvlUsd > 0);
  if (project) c = c.filter((p) => p.project === project);
  if (symbolIncludes) {
    const u = symbolIncludes.toUpperCase();
    c = c.filter((p) => p.symbol && p.symbol.toUpperCase().includes(u));
  }
  if (!c.length) {
    c = pools.filter((p) => p.chain === chainName && (!project || p.project === project));
  }
  return c.sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0))[0] || null;
}

/** Live DeFiLlama yield row on Sui whose pool `symbol` contains the LST ticker (HASUI, VSUI, etc.). */
function pickBestSuiPoolBySymbolKeyword(pools, symbolKeyword, assetHint) {
  const kw = String(symbolKeyword || "").toUpperCase();
  let c = pools.filter(
    (p) =>
      p.chain === "Sui" &&
      p.symbol &&
      p.symbol.toUpperCase().includes(kw) &&
      p.apy > 0 &&
      (p.tvlUsd || 0) > 0
  );
  if (assetHint) {
    const ah = String(assetHint).toUpperCase();
    const narrowed = c.filter((p) => p.symbol && p.symbol.toUpperCase().includes(ah));
    if (narrowed.length) c = narrowed;
  }
  return c.sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0))[0] || null;
}

/** Best CMETH yield pool on Mantle L2 (Lendle, WooFi, etc.) — not Morpho Blue. */
function pickBestCmethMantlePool(pools) {
  let c = pools.filter(
    (p) =>
      p.chain &&
      p.chain.toLowerCase() === "mantle" &&
      p.symbol &&
      p.symbol.toUpperCase().includes("CMETH") &&
      p.apy > 0 &&
      p.tvlUsd > 0
  );
  if (!c.length) {
    c = pools.filter(
      (p) =>
        p.chain &&
        p.chain.toLowerCase() === "mantle" &&
        p.symbol &&
        p.symbol.toUpperCase().includes("CMETH")
    );
  }
  return c.sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0))[0] || null;
}

function mantleQuotePrimaryFields(quotes) {
  const p = [...quotes].sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0))[0];
  if (!p) return {};
  return {
    apy: p.apy,
    chain: p.chain,
    symbol: p.symbol,
    tvlUsd: p.tvlUsd,
    amount: p.amount,
    estimatedYearlyYield: p.estimatedYearlyYield,
    asset: p.asset,
    primaryMantleRoute: p.mantleRoute,
  };
}

function buildMantleCmethDefiPlan(quote, params) {
  const amount = quote.amount || params.amount || "1000";
  const asset = quote.symbol || quote.asset || params.asset || "CMETH";
  const apy = quote.apy || 0;
  const token = quote.underlyingTokens && quote.underlyingTokens[0];
  const apyLabel = typeof apy === "number" ? apy.toFixed(2) : String(apy);
  return {
    success: true,
    provenance: "protocol-native",
    source: quote.source || "defillama-live",
    protocol: "mantle",
    mantleRoute: "cmeth-mantle-defi",
    defillamaProject: quote.defillamaProject,
    pool: quote.pool,
    action: "deposit",
    asset,
    amount,
    apy,
    steps: [
      {
        step: 1,
        type: "prepare",
        description: `Deposit CMETH on Mantle via ${quote.defillamaProject}${quote.poolMeta ? ` (${quote.poolMeta})` : ""}`,
      },
      {
        step: 2,
        type: "deposit",
        contract: token || null,
        method: "protocol-deposit",
        description: `Supply to Mantle ${quote.defillamaProject} — verify pool in app before signing`,
      },
      { step: 3, type: "confirm", description: `Confirm position — indicative APY ~ ${apyLabel}%` },
    ],
    estimatedGasUsd: "0.15",
    estimatedYearlyYield: quote.estimatedYearlyYield,
    tvlUsd: quote.tvlUsd,
    readyToExecute: !!token,
    fetchedAt: new Date().toISOString(),
  };
}

function buildMantleMultiPlan(quotes, params) {
  return quotes.map((q) => {
    if (q.mantleRoute === "meth-ethereum-staking") {
      const base = buildPlanFromQuote("mantle", q, params);
      return { ...base, mantleRoute: q.mantleRoute, defillamaProject: q.defillamaProject, pool: q.pool };
    }
    return buildMantleCmethDefiPlan(q, params);
  });
}

function buildQuoteFromPool(shortKey, pool, params) {
  const asset = params.asset || pool.symbol || "USDC";
  const amount = parseFloat(params.amount || "1000") || 1000;
  const apyPct = pool.apy || 0;
  const apyDec = apyPct / 100;
  const estimatedYearlyYield = (amount * apyDec).toFixed(6);
  return {
    success: true,
    provenance: "protocol-native",
    source: "defillama-live",
    protocol: shortKey,
    pool: pool.pool,
    asset,
    chain: pool.chain,
    symbol: pool.symbol,
    apy: apyPct,
    apyBase: pool.apyBase || null,
    apyReward: pool.apyReward || null,
    tvlUsd: pool.tvlUsd,
    amount: String(amount),
    estimatedYearlyYield,
    underlyingTokens: pool.underlyingTokens || null,
    rewardTokens: pool.rewardTokens || null,
    fetchedAt: new Date().toISOString(),
  };
}

async function handleAdapterLive(request, env, corsHeaders, shortKey, action) {
  let body = {};
  try {
    body = mergeAdapterPayload(await request.json());
  } catch { /* use defaults */ }

  if (action === "plan") {
    if (shortKey === "allbridge") return handleAllBridgePlan(body, env, corsHeaders);
    if (shortKey === "openocean") return handleOpenOceanPlan(body, env, corsHeaders);
    if (shortKey === "rubic") return handleRubicPlan(body, env, corsHeaders);
  }

  let attestation = null;
  try {
    const boundNonce = await sha256Hex(`handleAdapterLive:${shortKey}:${action}:${Date.now()}:${Math.random()}`);
    const ar = await fetchAndValidateAttestation(env, { nonce: boundNonce });
    attestation = ar.valid && ar.report ? ar.report : null;
  } catch { attestation = null; }

  // ── Dedicated protocol APIs ───────────────────────────────────────────────
  if (action === "quote") {
    // Lido
    if (shortKey === "lido") {
      try {
        const r = await fetch("https://eth-api.lido.fi/v1/protocol/steth/apr/sma", { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        const apr = d?.data?.smaApr;
        const result = {
          success: true, provenance: "protocol-native", source: "lido-api-live",
          protocol: "lido", asset: body.asset || "ETH", symbol: "stETH", chain: "Ethereum",
          apy: apr, apyBase: apr, apyReward: 0,
          amount: String(body.amount || "1"), estimatedYearlyYield: String(((parseFloat(body.amount||"1"))*apr/100).toFixed(6)),
          rebaseToken: "stETH", fetchedAt: new Date().toISOString(),
        };
        return json({ success: true, source: "lido-api-live", adapter: "lido-ethereum", result, ...(attestation?{teeAttestation:attestation}:{}) }, corsHeaders);
      } catch { /* fall through to DeFiLlama */ }
    }

    // Marinade
    if (shortKey === "marinade") {
      try {
        const r = await fetch("https://api.marinade.finance/msol/apy/1y", { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        const apy = (d?.value || 0) * 100;
        const result = {
          success: true, provenance: "protocol-native", source: "marinade-api-live",
          protocol: "marinade", asset: body.asset || "SOL", symbol: "mSOL", chain: "Solana",
          apy, apyBase: apy, apyReward: 0,
          amount: String(body.amount || "1"), estimatedYearlyYield: String(((parseFloat(body.amount||"1"))*apy/100).toFixed(6)),
          price: d?.end_price || null, fetchedAt: new Date().toISOString(),
        };
        return json({ success: true, source: "marinade-api-live", adapter: "marinade-solana", result, ...(attestation?{teeAttestation:attestation}:{}) }, corsHeaders);
      } catch { /* fall through to DeFiLlama */ }
    }

    // Meta Pool stNEAR + LiNEAR — verified rolling APY from public metrics
    if (shortKey === "metapool" || shortKey === "linear") {
      try {
        const pack = await buildNearLiquidStakingQuote(shortKey, body, env);
        if (!pack) throw new Error("unsupported NEAR LST");
        return json({
          success: true, source: pack.source, adapter: pack.adapter, result: pack.result,
          ...(attestation ? { teeAttestation: attestation } : {}),
        }, corsHeaders);
      } catch (e) {
        if (shortKey === "linear") {
          return json({
            success: false,
            source: "linear-metrics-live",
            adapter: "linear-near",
            error: "LiNEAR quote requires validators.narwallets.com metrics",
            message: (e && e.message) || String(e),
          }, corsHeaders, 502);
        }
        /* metapool: fall through to DeFiLlama */
      }
    }
  }

  if ((shortKey === "linear" || shortKey === "metapool") && action === "plan") {
    try {
      const pack = await buildNearLiquidStakingQuote(shortKey, body, env);
      if (!pack) throw new Error("unsupported NEAR LST");
      const plan = buildPlanFromQuote(shortKey, pack.result, body);
      return json({
        success: true, source: pack.source, adapter: pack.adapter, result: plan,
        ...(attestation ? { teeAttestation: attestation } : {}),
      }, corsHeaders);
    } catch (e) {
      return json({
        success: false,
        adapter: shortKey === "linear" ? "linear-near" : "metapool-near",
        error: "NEAR LST plan failed",
        message: (e && e.message) || String(e),
      }, corsHeaders, 502);
    }
  }

  // ── Mantle: mETH staking (Ethereum / meth-protocol) + CMETH DeFi (Mantle L2) ──
  if (shortKey === "mantle") {
    try {
      const pools = await fetchDefiLlamaPools();
      const methPool = pickBestPool(pools, "meth-protocol", "Ethereum", body.asset || null);
      const cmethPool = pickBestCmethMantlePool(pools);
      const quotes = [];
      if (methPool) {
        const q = buildQuoteFromPool(shortKey, methPool, body);
        quotes.push({
          ...q,
          source: "defillama-live",
          mantleRoute: "meth-ethereum-staking",
          defillamaProject: "meth-protocol",
        });
      }
      if (cmethPool) {
        const q = buildQuoteFromPool(shortKey, cmethPool, body);
        quotes.push({
          ...q,
          source: "defillama-live",
          mantleRoute: "cmeth-mantle-defi",
          defillamaProject: cmethPool.project,
          poolMeta: cmethPool.poolMeta || null,
          underlyingTokens: cmethPool.underlyingTokens || null,
        });
      }
      if (quotes.length) {
        const primary = mantleQuotePrimaryFields(quotes);
        if (action === "quote") {
          const result = {
            success: true,
            provenance: "protocol-native",
            source: "defillama-live",
            protocol: shortKey,
            pools: quotes,
            poolCount: quotes.length,
            ...primary,
          };
          return json({
            success: true,
            source: "defillama-live",
            adapter: "mantle-multi",
            result,
            ...(attestation ? { teeAttestation: attestation } : {}),
          }, corsHeaders);
        }
        const planPools = buildMantleMultiPlan(quotes, body);
        const result = {
          success: true,
          provenance: "protocol-native",
          source: "defillama-live",
          protocol: shortKey,
          pools: planPools,
          poolCount: planPools.length,
          ...mantleQuotePrimaryFields(quotes),
        };
        return json({
          success: true,
          source: "defillama-live",
          adapter: "mantle-multi",
          result,
          ...(attestation ? { teeAttestation: attestation } : {}),
        }, corsHeaders);
      }
    } catch { /* fall through to single-pool DeFiLlama */ }
  }

  // ── Sui LST (Haedal / Volo) — live APY from DeFiLlama Sui pools whose symbols include HASUI / VSUI
  const SUI_LST_SYM = { haedal: "HASUI", volo: "VSUI" };
  const lstNeedle = SUI_LST_SYM[shortKey];
  if (lstNeedle && (action === "quote" || action === "plan")) {
    try {
      const pools = await fetchDefiLlamaPools();
      const pool = pickBestSuiPoolBySymbolKeyword(pools, lstNeedle, body.asset || null);
      if (pool) {
        const quote = buildQuoteFromPool(shortKey, pool, body);
        quote.defillamaProject = pool.project;
        quote.defillamaPool = pool.pool || null;
        quote.note = `Live DeFiLlama yields row (${pool.project}) for ${pool.symbol}. Verify execution venue in the protocol app before signing.`;
        if (action === "quote") {
          return json({
            success: true,
            source: "defillama-live",
            adapter: `${shortKey}-sui`,
            result: quote,
            ...(attestation ? { teeAttestation: attestation } : {}),
          }, corsHeaders);
        }
        const plan = buildPlanFromQuote(shortKey, quote, body);
        return json({
          success: true,
          source: "defillama-live",
          adapter: `${shortKey}-sui`,
          result: plan,
          ...(attestation ? { teeAttestation: attestation } : {}),
        }, corsHeaders);
      }
    } catch { /* fall through */ }
  }

  // ── Suilend — on-chain reserve + curve (same math as @suilend/sdk); TVL from DeFiLlama; RPC fallback = TVL-only
  if (shortKey === "suilend" && (action === "quote" || action === "plan")) {
    try {
      let quote = await buildSuilendOnChainQuote(body, env);
      let tvlUsd = null;
      try {
        tvlUsd = await fetchDefiLlamaTvlOnly("suilend");
      } catch { /* optional */ }
      if (quote) {
        if (tvlUsd != null) quote.tvlUsd = tvlUsd;
        if (action === "quote") {
          return json({
            success: true,
            source: quote.source,
            adapter: "suilend-sui",
            result: quote,
            ...(attestation ? { teeAttestation: attestation } : {}),
          }, corsHeaders);
        }
        const plan = buildPlanFromQuote("suilend", quote, body);
        return json({
          success: true,
          source: quote.source,
          adapter: "suilend-sui",
          result: plan,
          ...(attestation ? { teeAttestation: attestation } : {}),
        }, corsHeaders);
      }
      if (tvlUsd != null) {
        const amount = parseFloat(body.amount || "1000") || 1000;
        quote = {
          success: true,
          provenance: "protocol-native",
          source: "defillama-tvl",
          protocol: "suilend",
          asset: body.asset || "USDC",
          apy: null,
          tvlUsd,
          amount: String(amount),
          estimatedYearlyYield: null,
          note:
            "On-chain Suilend quote unavailable (RPC or parsing). TVL is live from DeFiLlama; confirm APR at app.suilend.fi.",
          docsUrl: "https://www.suilend.fi/",
          fetchedAt: new Date().toISOString(),
        };
        if (action === "quote") {
          return json({
            success: true,
            source: "defillama-tvl",
            adapter: "suilend-sui",
            result: quote,
            ...(attestation ? { teeAttestation: attestation } : {}),
          }, corsHeaders);
        }
        const plan = buildPlanFromQuote("suilend", quote, body);
        return json({
          success: true,
          source: "defillama-tvl",
          adapter: "suilend-sui",
          result: plan,
          ...(attestation ? { teeAttestation: attestation } : {}),
        }, corsHeaders);
      }
    } catch { /* fall through */ }
  }

  const defiChainFirst = DL_DEFILLAMA_CHAIN_FIRST[shortKey];
  if (defiChainFirst) {
    try {
      const pools = await fetchDefiLlamaPools();
      const pool = pickBestChainPool(pools, defiChainFirst, shortKey === "rootstock" ? { symbolIncludes: "RBTC" } : {});
      if (pool) {
        const quote = buildQuoteFromPool(shortKey, pool, body);
        quote.defillamaChain = defiChainFirst;
        quote.defillamaProject = pool.project;
        if (action === "quote") {
          return json({
            success: true,
            source: "defillama-live",
            adapter: `${shortKey}-${(pool.chain || "multi").toLowerCase()}`,
            result: quote,
            ...(attestation ? { teeAttestation: attestation } : {}),
          }, corsHeaders);
        }
        const plan = buildPlanFromQuote(shortKey, quote, body);
        return json({
          success: true,
          source: "defillama-live",
          adapter: `${shortKey}-${(pool.chain || "multi").toLowerCase()}`,
          result: plan,
          ...(attestation ? { teeAttestation: attestation } : {}),
        }, corsHeaders);
      }
    } catch { /* TVL fallback */ }
  }

  // ── DeFiLlama pool data ───────────────────────────────────────────────────
  const dlProject = DL_PROJECT[shortKey];
  if (dlProject) {
    try {
      const pools = await fetchDefiLlamaPools();
      const chainHint = DL_CHAIN[shortKey] || null;
      const pool = pickBestPool(pools, dlProject, chainHint, body.asset || null);
      if (pool) {
        const quote = buildQuoteFromPool(shortKey, pool, body);
        if (action === "quote") {
          return json({ success: true, source: "defillama-live", adapter: `${shortKey}-${(pool.chain||"multi").toLowerCase()}`, result: quote, ...(attestation?{teeAttestation:attestation}:{}) }, corsHeaders);
        }
        // plan
        const plan = buildPlanFromQuote(shortKey, quote, body);
        return json({ success: true, source: "defillama-live", adapter: `${shortKey}-${(pool.chain||"multi").toLowerCase()}`, result: plan, ...(attestation?{teeAttestation:attestation}:{}) }, corsHeaders);
      }
    } catch (err) {
      // DeFiLlama failed — fall through to TVL fallback
    }
  }

  // ── DeFiLlama TVL-only fallback ───────────────────────────────────────────
  const tvlSlug = DL_TVL_SLUG[shortKey];
  if (tvlSlug) {
    try {
      const tvlUsd = await fetchDefiLlamaTvlOnly(tvlSlug);
      const category = body.category || DL_TVL_CATEGORY_HINT[shortKey] || "general";
      const est = CATEGORY_APY_EST[category] || CATEGORY_APY_EST.general;
      const apyMid = (est.min + est.max) / 2;
      const amount = parseFloat(body.amount || "1000") || 1000;
      const quote = {
        success: true, provenance: "protocol-native", source: "defillama-tvl",
        protocol: shortKey, asset: body.asset || est.asset,
        apy: apyMid, apyRange: `${est.min}%-${est.max}%`, tvlUsd,
        amount: String(amount), estimatedYearlyYield: String((amount * apyMid / 100).toFixed(6)),
        fetchedAt: new Date().toISOString(),
      };
      if (action === "quote") {
        return json({ success: true, source: "defillama-tvl", adapter: shortKey, result: quote, ...(attestation?{teeAttestation:attestation}:{}) }, corsHeaders);
      }
      const plan = buildPlanFromQuote(shortKey, quote, body);
      return json({ success: true, source: "defillama-tvl", adapter: shortKey, result: plan, ...(attestation?{teeAttestation:attestation}:{}) }, corsHeaders);
    } catch { /* fall through */ }
  }

  // ── Final fallback → NEAR AI agent ───────────────────────────────────────
  const syntheticReq = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body),
  });
  return handleAgentRequest(syntheticReq, env, corsHeaders, `/adapters/${shortKey}/${action}`);
}

function buildPlanFromQuote(shortKey, quote, params) {
  const PROTOCOL_CONTRACTS = {
    aave:       { contract: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", action: "supply(address,uint256,address,uint16)" },
    euler:      { contract: "0x27182842E098f60e3D576794A5bFFb0777E025d3", action: "deposit(uint256,address)" },
    silo:       { contract: "0x4D89e0E7Bc73ec7a2c7Ae3d9B17CB3B8b1FC33D6", action: "deposit(uint256,address)" },
    lido:       { contract: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", action: "submit(address)" },
    rocketpool: { contract: "0xDD3f50F8A6CafbE9b31a427582963f465E745AF8", action: "deposit()" },
    renzo:      { contract: "0x74a09653A083691711cF8215a6ab074BB4e99ef5", action: "depositETH()" },
    etherfi:    { contract: "0x308861A430be4cce5502d0A12724771Fc6DaF216", action: "deposit()" },
    swell:      { contract: "0xf951E335afb289353dc249e82926178EaC7DEd78", action: "deposit()" },
    fraxeth:    { contract: "0xbAFA44efe7901E04E39Dad13167D089C559c1138", action: "minter_mint(address,uint256)" },
    compound:   { contract: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", action: "supply(address,uint256)" },
    curve:      { contract: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7", action: "add_liquidity(uint256[3],uint256)" },
    pendle:     { contract: "0x888888888889758F76e7103c6CbF23ABbF58F946", action: "addLiquiditySingleToken" },
    convex:     { contract: "0xF403C135812408BFbE8713b5A23a04b3D48AAE31", action: "deposit(uint256,uint256,bool)" },
    yearn:      { contract: "0xa354F35829Ae975e850e23e9615b11Da1B3dC4DE", action: "deposit(uint256)" },
    justlend:   { contract: "TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7", action: "mint(uint256)" },
    marinade:   { contract: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", action: "liquid-unstake" },
    jito:       { contract: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", action: "stake" },
    kamino:     { contract: "6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc", action: "depositObligationCollateral" },
    glif:       { contract: "0x60F25ac5F289Dc7F640f948521d486C964A1F7e5", action: "deposit(uint256)" },
    clovis:     { contract: "0x39166b36A25a4A98D6B7C21d429f4740C6A5e94C", action: "deposit(uint256)" },
    // NEAR
    metapool:   { contract: "meta-pool.near",               action: "deposit_and_stake" },
    linear:     { contract: "linear-protocol.near",           action: "deposit_and_stake" },
    rhea:       { contract: "contract.main.burrow.near",    action: "supply" },
    // Stacks
    zest:       { contract: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market",                     action: "supply-collateral-add" },
    hermetica:  { contract: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.minting-auto-v1-2",              action: "mint" },
    lisa:       { contract: "SM26NBC8SFHNW4P1Y4DFH27974P56WN86C92HPEHH.lqstx-mint-endpoint",           action: "request-mint" },
    stackingdao: { contract: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.stacking-dao-core-v6",         action: "deposit-stx" },
    alex:       { contract: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.amm-swap-pool-v1-1",           action: "swap-helper" },
    // Ethereum — DeFi yield / LSTs
    lombard:    { contract: "0x8236a87084f8b84306f72007f36f2618a5634494", action: "mint(address,uint256)" },
    solv:       { contract: "0x7a56e1c57c7475ccf742a1832b028f0456652f97", action: "deposit(uint256)" },
    usual:      { contract: "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5", action: "swap(address,uint256)" },
    ethena:     { contract: "0x9d39a5de30e57443bff2a8307a4256c8797a3497", action: "deposit(uint256,address)" },
    bedrock:    { contract: "0x4beFa2aA9c305238AA3E0b5D17eB20C045269E9d", action: "deposit()" },
    compoundv3: { contract: "0xb125E6687d4313864e53df431d5425969c15Eb2F", action: "supply(address,uint256)" },
    mantle:     { contract: "0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f", action: "stake()" },
    sushiswap:  { contract: "0x2214a42d8e2a1d20635c2cb0664422c528b6a432", action: "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))" },
    beefy:      { contract: "0x6f19da51d488926c007b9ebaa5968291a2ec6a63", action: "deposit(address,address,uint256,uint256,bytes)" },
    thevault:   { contract: "Fu9BYC6tWBo1KMKaP3CFoKfRhqv9akmy3DuYwnCyWiyC", action: "deposit" },
    bitlayer:   { contract: "0x2cd3cdb3bd68eea0d3be81da707bc0c8743d7335", action: "deposit" },
    // Avalanche
    benqi:      { contract: "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE", action: "submit(address)" },
    // Sui
    navi:       { contract: "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0", action: "deposit_and_mint" },
    scallop:    { contract: "0xa45b8ffca59e5b44ec7c04481a04cb620b0e07b2b183527bca4e5f32372c5f1a", action: "deposit" },
    cetus:      { contract: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb", action: "open_position" },
    suilend:    { contract: "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf", action: "deposit_liquidity_and_mint_ctokens" },
    // Starknet
    endur:      { contract: "0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a", action: "deposit" },
    ekubo:      { contract: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b", action: "update_position" },
    vesu:       { contract: "0x000d8d6dfec4d33bfb6895de9f3852143a17c6f92fd2a21da3d6924d34870160", action: "modify_position" },
    // Katana L2 (Polygon CDK chain) — SushiSwap V3 router
    katana:     { contract: "0x4e1d81A3E627b9294532e990109e4c21d217376C", action: "exactInputSingle" },
    // Aptos
    amnis:      { contract: "0x111ae3e5bc816a5e63c2da97d0aa3886519e0cd5e4b046659fa35796bd11542a", action: "staking::stake" },
    // Tron
    sunswap:    { contract: "TJ4NNy8xZEqsowCBhLvZ45LCqPdGjkET5j", action: "swapExactInput" },
    // Cosmos IBC
    osmosis:    { contract: "osmosis-1:x/poolmanager", action: "MsgSwapExactAmountIn" },
    stride:     { contract: "stride-1:x/stakeibc", action: "LiquidStake" },
    // Bitcoin / BTC-native
    bitcoinos:  { contract: "bitcoinos:bridge-relay", action: "bridge" },
    babylon:    { contract: "babylon-genesis:staking-script", action: "taproot-stake" },
    // XRPL
    xrpl_dex:   { contract: "xrpl:amm-native", action: "AMMDeposit" },
    // Filecoin EVM
    secured:    { contract: "0x35e9D8e0223A75E51a67aa731127C91Ea0779Fe2", action: "depositAndExecuteOrder" },
    // Ethereum — restaking / lending
    eigenlayer: { contract: "0x858646372CC42E1A627fcE94aa7A7033e7CF075A", action: "depositIntoStrategy(address,address,uint256)" },
    morpho:     { contract: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", action: "supply((address,address,uint256,uint256,address),uint256,uint256,address)" },
    // Solana — DEX aggregator
    jupiter:    { contract: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", action: "sharedAccountsRoute" },
    allbridge:  { contract: "allbridge:core", action: "bridge" },
    openocean:  { contract: "openocean:router", action: "swap" },
    rubic:      { contract: "rubic:multicall-router", action: "swap" },
    // Bitcoin — Charms metaprotocol (client-side validation, Taproot witness)
    charms:     { contract: "bitcoin:charms-metaprotocol", action: "spell" },
    // Rootstock — Sovryn AMM / lending (verify pool in app before signing)
    sovryn:     { contract: "eip155:30:sovryn-swap-network", action: "swap" },
  };
  const info = PROTOCOL_CONTRACTS[shortKey] || {};
  const amount = quote.amount || params.amount || "1000";
  const asset = quote.asset || params.asset || "USDC";
  const apy = quote.apy != null && quote.apy !== "" ? quote.apy : null;
  const apyLine =
    apy == null
      ? "confirm rate in the protocol UI (quote has no single blended APY)"
      : `expected APY: ${typeof apy === "number" ? apy.toFixed(2) : apy}%`;
  return {
    success: true, provenance: "protocol-native", source: quote.source,
    protocol: shortKey, action: "deposit",
    asset, amount, apy,
    steps: [
      info.contract
        ? { step: 1, type: "approve",  contract: info.contract, description: `Approve ${asset} spend` }
        : { step: 1, type: "prepare",  description: `Prepare ${shortKey} deposit` },
      { step: 2, type: "deposit", contract: info.contract || null, method: info.action || "deposit", description: `Deposit ${amount} ${asset} into ${shortKey}` },
      { step: 3, type: "confirm", description: `Confirm ${shortKey} position — ${apyLine}` },
    ],
    estimatedGasUsd:
      shortKey === "marinade" || shortKey === "jito" || shortKey === "kamino" ||
        shortKey === "metapool" || shortKey === "linear"
        ? "0.001"
        : "3.50",
    estimatedYearlyYield: quote.estimatedYearlyYield,
    tvlUsd: quote.tvlUsd || null,
    readyToExecute: !!info.contract,
    fetchedAt: new Date().toISOString(),
  };
}

function mergeAdapterPayload(raw) {
  if (!raw || typeof raw !== "object") return {};
  const inner = raw.request && typeof raw.request === "object" ? raw.request : {};
  return { ...raw, ...inner };
}

const RUBIC_CHAIN_ID_TO_BLOCKCHAIN = {
  1: "ETH", 56: "BSC", 137: "POLYGON", 42161: "ARBITRUM", 8453: "BASE", 10: "OPTIMISM",
  43114: "AVALANCHE", 250: "FANTOM", 324: "ZKSYNC", 59144: "LINEA", 534352: "SCROLL",
  100: "GNOSIS", 1101: "POLYGON_ZKEVM", 5000: "MANTLE", 81457: "BLAST",
};

function normEvmChainId(v) {
  const s = String(v == null ? "1" : v).trim();
  const noCaip = s.replace(/^eip155:/i, "").split(":").pop() || s;
  return String(Number(noCaip) || 1);
}

async function openOceanQuoteCore(env, p) {
  const chainId = normEvmChainId(p.chainId ?? p.chain);
  const inTokenAddress = p.inTokenAddress || p.inToken || p.src;
  const outTokenAddress = p.outTokenAddress || p.outToken || p.dst;
  const amount = p.amount != null ? String(p.amount) : "";
  if (!inTokenAddress || !outTokenAddress || !amount) {
    return {
      ok: false, httpStatus: 400,
      message: "Required: inTokenAddress, outTokenAddress, amount (smallest units); chainId optional default 1",
    };
  }
  // OpenOcean v3 requires gasPrice on query (returns 400 if omitted) — default 50 gwei; override via body.gasPrice or OPENOCEAN_DEFAULT_GAS_PRICE.
  const gasPriceDefault = String(env.OPENOCEAN_DEFAULT_GAS_PRICE || "50000000000").trim() || "50000000000";
  const gasPrice =
    p.gasPrice != null && String(p.gasPrice).trim() !== ""
      ? String(p.gasPrice)
      : gasPriceDefault;
  const base = String(env.OPENOCEAN_API_BASE || "https://open-api.openocean.finance").replace(/\/$/, "");
  const q = new URLSearchParams({ inTokenAddress, outTokenAddress, amount, gasPrice });
  const url = `${base}/v3/${chainId}/quote?${q.toString()}`;
  let resp;
  try {
    resp = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  } catch (e) {
    return { ok: false, httpStatus: 504, message: "OpenOcean API timeout", detail: e && e.message };
  }
  const text = await resp.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!resp.ok || (data && data.code != null && Number(data.code) !== 200)) {
    return { ok: false, httpStatus: 502, message: "OpenOcean quote failed", detail: data };
  }
  return { ok: true, chainId, inTokenAddress, outTokenAddress, amount, quote: data };
}

function rubicBlockchainFromParams(p) {
  if (p.srcTokenBlockchain) return String(p.srcTokenBlockchain).toUpperCase();
  const id = Number(normEvmChainId(p.srcChainId ?? p.chainId ?? p.chain));
  return RUBIC_CHAIN_ID_TO_BLOCKCHAIN[id] || null;
}

async function rubicQuoteCore(env, p) {
  let srcTokenBlockchain = rubicBlockchainFromParams(p);
  let dstTokenBlockchain = p.dstTokenBlockchain
    ? String(p.dstTokenBlockchain).toUpperCase()
    : srcTokenBlockchain;
  if (!dstTokenBlockchain && (p.dstChainId != null || p.dstChain != null)) {
    const did = Number(normEvmChainId(p.dstChainId ?? p.dstChain));
    dstTokenBlockchain = RUBIC_CHAIN_ID_TO_BLOCKCHAIN[did] || dstTokenBlockchain;
  }
  const srcTokenAddress = p.srcTokenAddress || p.src || p.inTokenAddress;
  const dstTokenAddress = p.dstTokenAddress || p.dst || p.outTokenAddress;
  const srcTokenAmount = p.srcTokenAmount != null ? String(p.srcTokenAmount) : (p.amount != null ? String(p.amount) : "");
  if (!srcTokenBlockchain || !dstTokenBlockchain || !srcTokenAddress || !dstTokenAddress || !srcTokenAmount) {
    return {
      ok: false, httpStatus: 400,
      message: "Required: srcTokenAddress, dstTokenAddress, srcTokenAmount; "
        + "src TokenBlockchain as srcTokenBlockchain or mappable chainId; same for dst when cross-chain",
    };
  }
  const referrer = String(p.referrer || env.RUBIC_REFERRER || "yieldagent").slice(0, 64);
  const url = String(env.RUBIC_QUOTE_URL || "https://api-v2.rubic.exchange/api/routes/quoteBest");
  const payload = {
    srcTokenBlockchain,
    srcTokenAddress,
    srcTokenAmount,
    dstTokenBlockchain,
    dstTokenAddress,
    referrer,
  };
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { ok: false, httpStatus: 504, message: "Rubic API timeout", detail: e && e.message };
  }
  const text = await resp.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!resp.ok) {
    return { ok: false, httpStatus: 502, message: "Rubic quote HTTP error", detail: data };
  }
  if (data && data.error && typeof data.error === "object") {
    const reason = data.error.reason || data.error.message || "no routes";
    return { ok: false, httpStatus: 404, message: "Rubic: " + String(reason), detail: data };
  }
  if (!data || !data.estimate) {
    return { ok: false, httpStatus: 502, message: "Rubic: unexpected response", detail: data };
  }
  return { ok: true, quote: data, requestEcho: { srcTokenBlockchain, dstTokenBlockchain, srcTokenAddress, dstTokenAddress, srcTokenAmount } };
}

function buildAggSwapPlan(shortKey, sourceLabel, summary, params) {
  const info = {
    openocean: { contract: "openocean:router", action: "swap" },
    rubic: { contract: "rubic:multicall-router", action: "swap" },
  }[shortKey] || { contract: null, action: "swap" };
  const amount = summary.amountIn || params.amount || "";
  const outShown = typeof summary.amountOut === "string"
    ? summary.amountOut
    : (summary.amountOut != null && summary.amountOut !== "")
      ? String(summary.amountOut)
      : "";
  const apy = 0;
  return {
    success: true,
    provenance: "protocol-native",
    source: sourceLabel,
    protocol: shortKey,
    action: "swap",
    asset: params.asset || "EVM",
    amount: String(amount),
    apy,
    steps: [
      info.contract
        ? { type: "approve", contract: info.contract, description: `Approve ${sourceLabel} router` }
        : { type: "prepare", description: `Prepare ${sourceLabel} swap` },
      { type: "swap", contract: info.contract || null, method: info.action, description: `Swap via ${sourceLabel}` },
      {
        type: "confirm",
        description: outShown ? `Confirm settlement — indicative out: ${outShown}` : "Confirm settlement",
      },
    ].map((s, i) => ({ ...s, step: i + 1 })),
    estimatedGasUsd: "5.00",
    estimatedYearlyYield: null,
    tvlUsd: null,
    readyToExecute: !!info.contract,
    fetchedAt: new Date().toISOString(),
  };
}

async function handleOpenOceanQuote(request, env, corsHeaders) {
  try {
    const raw = await request.json().catch(function() { return {}; });
    const body = mergeAdapterPayload(raw);
    const pack = await openOceanQuoteCore(env, body);
    if (!pack.ok) {
      return json({ success: false, error: pack.message, detail: pack.detail || null }, corsHeaders, pack.httpStatus || 502);
    }
    const attestation = await teeAttestationForLiveRoute(env, "adapters/openocean/quote");
    const d = pack.quote && pack.quote.data;
    const outAmt = d && (d.outAmount || d.outTokenAmount);
    return json({
      success: true,
      provenance: "protocol-native",
      source: "openocean-v3-live",
      adapter: "openocean-evm",
      chainId: pack.chainId,
      result: {
        inTokenAddress: pack.inTokenAddress,
        outTokenAddress: pack.outTokenAddress,
        amountIn: pack.amount,
        amountOut: outAmt != null ? String(outAmt) : null,
        quote: pack.quote,
      },
      ...(attestation ? { teeAttestation: attestation } : {}),
      ts: new Date().toISOString(),
    }, corsHeaders);
  } catch (err) {
    return json({
      success: false,
      error: "OpenOcean quote failed",
      detail: err && err.message ? err.message : String(err),
    }, corsHeaders, 500);
  }
}

async function handleRubicQuote(request, env, corsHeaders) {
  try {
    const raw = await request.json().catch(function() { return {}; });
    const body = mergeAdapterPayload(raw);
    const pack = await rubicQuoteCore(env, body);
    if (!pack.ok) {
      return json({ success: false, error: pack.message, detail: pack.detail || null }, corsHeaders, pack.httpStatus || 502);
    }
    const attestation = await teeAttestationForLiveRoute(env, "adapters/rubic/quote");
    const est = pack.quote.estimate;
    const outAmt = est && (est.destinationTokenAmount || est.destinationWeiAmount);
    return json({
      success: true,
      provenance: "protocol-native",
      source: "rubic-v2-live",
      adapter: "rubic-multi",
      result: {
        routing: pack.quote.routing || null,
        providerType: pack.quote.providerType || null,
        swapType: pack.quote.swapType || null,
        amountOut: outAmt != null ? String(outAmt) : null,
        amountOutMin: est && est.destinationTokenMinAmount != null ? String(est.destinationTokenMinAmount) : null,
        quote: pack.quote,
        request: pack.requestEcho,
      },
      ...(attestation ? { teeAttestation: attestation } : {}),
      ts: new Date().toISOString(),
    }, corsHeaders);
  } catch (err) {
    return json({
      success: false,
      error: "Rubic quote failed",
      detail: err && err.message ? err.message : String(err),
    }, corsHeaders, 500);
  }
}

async function handleAllBridgeQuote(request, env, corsHeaders) {
  try {
    const raw = await request.json().catch(function() { return {}; });
    const body = mergeAdapterPayload(raw);
    const src = body.src || body.fromToken || body.sourceToken || "";
    const dst = body.dst || body.toToken || body.destinationToken || "";
    const amount = body.amount != null ? String(body.amount) : "";
    const srcChain = body.srcChain || body.sourceChain || "stacks";
    const dstChain = body.dstChain || body.destinationChain || "ethereum";
    if (!src || !dst || !amount) {
      return json({ success: false, error: "Required: src, dst, amount, srcChain, dstChain" }, corsHeaders, 400);
    }
    const base = String(env.ALLBRIDGE_API_BASE || "https://core.api.allbridgeapp.com").replace(/\/$/,"");
    const url = `${base}/token-info`;
    // AllBridge uses token-info + transfer-time endpoints for quotes
    const resp = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!resp.ok) {
      return json({ success: false, error: `AllBridge API ${resp.status}`, detail: await resp.text() }, corsHeaders, 502);
    }
    const data = await resp.json();
    const attestation = await teeAttestationForLiveRoute(env, "adapters/allbridge/quote");
    return json({ success: true, adapter: "allbridge", srcChain, dstChain, src, dst, amount, tokenInfo: data, attestation }, corsHeaders);
  } catch(err) {
    return json({ success: false, error: "AllBridge quote error", detail: err && err.message ? err.message : String(err) }, corsHeaders, 500);
  }
}

async function handleAllBridgePlan(body_or_request, env, corsHeaders) {
  try {
    const raw = typeof body_or_request.json === "function" ? await body_or_request.json().catch(function() { return {}; }) : body_or_request;
    const body = mergeAdapterPayload(raw);
    const attestation = await teeAttestationForLiveRoute(env, "adapters/allbridge/plan");
    return json({ success: true, adapter: "allbridge", plan: { steps: ["1. Get token info from AllBridge", "2. Initiate bridge transfer on source chain", "3. Wait for relay confirmation", "4. Claim on destination chain"], body }, attestation }, corsHeaders);
  } catch(err) {
    return json({ success: false, error: "AllBridge plan error", detail: err && err.message ? err.message : String(err) }, corsHeaders, 500);
  }
}

async function handleOpenOceanPlan(body, env, corsHeaders) {
  const p = mergeAdapterPayload(body);
  const pack = await openOceanQuoteCore(env, p);
  if (!pack.ok) {
    return json({ success: false, error: pack.message, detail: pack.detail || null }, corsHeaders, pack.httpStatus || 502);
  }
  const attestation = await teeAttestationForLiveRoute(env, "adapters/openocean/plan");
  const d = pack.quote && pack.quote.data;
  const outAmt = d && (d.outAmount || d.outTokenAmount);
  const plan = buildAggSwapPlan("openocean", "OpenOcean", { amountIn: pack.amount, amountOut: outAmt }, p);
  return json({
    success: true,
    provenance: "protocol-native",
    source: "openocean-v3-live",
    adapter: "openocean-evm",
    result: plan,
    ...(attestation ? { teeAttestation: attestation } : {}),
    ts: new Date().toISOString(),
  }, corsHeaders);
}

async function handleRubicPlan(body, env, corsHeaders) {
  const p = mergeAdapterPayload(body);
  const pack = await rubicQuoteCore(env, p);
  if (!pack.ok) {
    return json({ success: false, error: pack.message, detail: pack.detail || null }, corsHeaders, pack.httpStatus || 502);
  }
  const attestation = await teeAttestationForLiveRoute(env, "adapters/rubic/plan");
  const est = pack.quote.estimate;
  const outAmt = est && (est.destinationTokenAmount || est.destinationWeiAmount);
  const plan = buildAggSwapPlan("rubic", "Rubic", { amountIn: p.srcTokenAmount || p.amount, amountOut: outAmt }, p);
  return json({
    success: true,
    provenance: "protocol-native",
    source: "rubic-v2-live",
    adapter: "rubic-multi",
    result: plan,
    ...(attestation ? { teeAttestation: attestation } : {}),
    ts: new Date().toISOString(),
  }, corsHeaders);
}

async function handleJupiterQuote(request, env, corsHeaders) {
  try {
    const body = await request.json().catch(function() { return {}; });
    const inputMint  = body.inputMint  || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const outputMint = body.outputMint || "So11111111111111111111111111111111111111112";
    const amount     = String(body.amount || "1000000");
    const slippage   = String(body.slippageBps || 50);

    const params = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: slippage });

    // lite-api.jup.ag is the CF-Worker-accessible endpoint; quote-api.jup.ag blocks CF IPs
    const JUP_ENDPOINTS = [
      "https://lite-api.jup.ag/swap/v1/quote",
      "https://quote-api.jup.ag/v6/quote",
    ];
    let quote = null;
    let lastErr = null;
    for (const endpoint of JUP_ENDPOINTS) {
      try {
        const jupResp = await fetch(`${endpoint}?${params.toString()}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (jupResp.ok) {
          quote = await jupResp.json();
          break;
        }
        lastErr = { status: jupResp.status, detail: await jupResp.text().catch(() => "") };
      } catch (e) {
        lastErr = { error: e?.message || String(e) };
      }
    }

    if (!quote) {
      return json({ success: false, error: "Jupiter API unavailable", upstream: lastErr }, corsHeaders, 502);
    }

    const attestation = await teeAttestationForLiveRoute(env, "adapters/jupiter/quote");
    return json({
      success: true,
      provenance: "protocol-native",
      source: "jupiter-v6-live",
      adapter: "jupiter-solana",
      wallet: env.WALLET_SOLANA || null,
      quote,
      ...(attestation ? { teeAttestation: attestation } : {}),
      ts: new Date().toISOString(),
    }, corsHeaders);
  } catch (err) {
    const isTimeout = err && (err.name === "TimeoutError" || (err.message && err.message.includes("timeout")));
    return json({
      success: false,
      error: isTimeout ? "Jupiter API timeout" : "Jupiter quote failed",
      detail: err && err.message ? err.message : String(err),
    }, corsHeaders, isTimeout ? 504 : 500);
  }
}

// ============================================================================
// Integration status — live GET endpoint (no NEAR AI proxy needed)
// ============================================================================

function boolEnv(val, def = false) {
  if (val === undefined || val === null || val === "") return def;
  return String(val).toLowerCase() !== "false" && String(val) !== "0";
}

async function handleIntegrationStatus(path, env, corsHeaders) {
  const name = path.split("/")[2] || "";
  const now = new Date().toISOString();
  const integrations = {
    layerzero: {
      name: "LayerZero v2",
      enabled: boolEnv(env.LAYERZERO_ENABLED, false),
      mode: env.LAYERZERO_MODE || "proxy",
      scanApi: "https://scan.layerzero-api.com/v1",
      quoteEndpoint: "/bridge/layerzero/quote",
      verifyEndpoint: "/tee/verify-lz",
    },
    bitcoinos: {
      name: "BitcoinOS",
      enabled: boolEnv(env.BITCOINOS_ENABLED, false),
      mode: env.BITCOINOS_MODE || "proxy",
      quoteEndpoint: "/bridge/bitcoinos/quote",
    },
  };
  const cfg = integrations[name];
  if (!cfg) return json({ success: false, error: `Unknown integration: ${name}` }, corsHeaders, 404);
  return json({ success: true, integration: name, ...cfg, checkedAt: now }, corsHeaders);
}

// ============================================================================
// LayerZero v2 — direct fee estimation via Scan API
// ============================================================================

const LZ_EID_MAP = {
  ethereum: 30101, eth: 30101,
  bnb: 30102, bsc: 30102,
  avalanche: 30106, avax: 30106,
  polygon: 30109, matic: 30109,
  arbitrum: 30110, arb: 30110,
  optimism: 30111, op: 30111,
  base: 30184, linea: 30183,
  scroll: 30214, zksync: 30165,
  mantle: 30181, mode: 30260,
  blast: 30243,
};

// Approximate DVN fees in ETH by route (src EID → rough fee)
const LZ_DVN_FEE_EST = {
  30101: "0.000120", // from ETH
  30102: "0.000040", // from BNB
  30184: "0.000010", // from Base
  30110: "0.000010", // from Arbitrum
  30111: "0.000010", // from Optimism
};

async function handleLayerZeroQuoteDirect(request, env, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  let srcEid = body.srcEid ? Number(body.srcEid) : (LZ_EID_MAP[String(body.fromChain || "").toLowerCase()] || null);
  let dstEid = body.dstEid ? Number(body.dstEid) : (LZ_EID_MAP[String(body.toChain || "").toLowerCase()] || null);
  const token  = String(body.token || "USDC");
  const amount = String(body.amount || "0");

  if (!srcEid || !dstEid) {
    return json({
      success: false,
      error: "Provide srcEid+dstEid or fromChain+toChain",
      supportedChains: Object.keys(LZ_EID_MAP),
    }, corsHeaders, 400);
  }

  // Try LayerZero Scan API for recent message fees on this route
  let nativeFee = LZ_DVN_FEE_EST[srcEid] || "0.000050";
  let lzTokenFee = "0";
  let scanOk = false;
  try {
    const scanUrl = `https://scan.layerzero-api.com/v1/messages?srcEid=${srcEid}&dstEid=${dstEid}&limit=1`;
    const resp = await fetch(scanUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      const msgs = data?.data || data?.messages || [];
      if (msgs.length > 0) {
        // Use actual fee from last message if available
        const msg = msgs[0];
        if (msg?.fee?.nativeFee) nativeFee = msg.fee.nativeFee;
        if (msg?.fee?.lzTokenFee) lzTokenFee = msg.fee.lzTokenFee;
        scanOk = true;
      }
    }
  } catch { /* fallback to estimate */ }

  const attestation = await fetchAttestation(env).catch(() => null);
  return json({
    success: true,
    source: scanOk ? "layerzero-scan-live" : "layerzero-fee-estimate",
    lzVersion: "v2",
    srcEid,
    dstEid,
    token,
    amount,
    fee: { nativeFee, lzTokenFee, currency: "native" },
    estimatedSeconds: 30,
    ...(attestation ? { teeAttestation: attestation } : {}),
    ts: new Date().toISOString(),
  }, corsHeaders);
}

// ============================================================================
// Bridge / adapter / integration / stake — routed to NEAR AI agent
// ============================================================================

async function handleAgentRequest(request, env, corsHeaders, path) {
  const nearAiUrl = env.NEAR_AI_URL || "https://cloud-api.near.ai";
  const agentId = env.NEAR_AI_AGENT_ID;
  const apiKey = env.NEAR_AI_API_KEY;
  const model = env.NEAR_AI_MODEL || "deepseek-ai/DeepSeek-V3.1";

  if (!agentId || !apiKey) {
    return json({
      success: false,
      error: "NEAR AI agent not configured",
      path,
      configure: ["Set NEAR_AI_AGENT_ID and NEAR_AI_API_KEY"],
    }, corsHeaders, 503);
  }

  let requestBody = null;
  if (request.method === "POST") {
    const ctErr = requireJsonContentType(request, corsHeaders);
    if (ctErr) return ctErr;
    try {
      const text = await request.text();
      if (text.length > 65536) {
        return json({ success: false, error: "Request body too large (max 64KB)" }, corsHeaders, 413);
      }
      requestBody = text ? JSON.parse(text) : {};
    } catch {
      requestBody = {};
    }
  }

  const taskMessage = buildAgentMessage(path, request.method, requestBody);

  try {
    const completionResp = await fetchNearAi(`${nearAiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: nearAiHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `You are ${agentId}, a YieldAgent TEE-secured DeFi execution agent. ` +
              "Respond ONLY with valid JSON. No markdown, no explanation. " +
              "For status requests, return {\"success\":true,\"status\":\"operational\",...}. " +
              "For quotes, return {\"success\":true,\"quote\":{...}}. " +
              "For bridge requests, return {\"success\":true,\"bridge\":{...}}.",
          },
          { role: "user", content: taskMessage },
        ],
        temperature: 0.1,
        max_tokens: 2048,
      }),
    });

    if (!completionResp.ok) {
      const errText = await completionResp.text().catch(() => "");
      return json({
        success: false,
        error: `NEAR AI completion failed (${completionResp.status})`,
        path,
        detail: errText.slice(0, 200),
      }, corsHeaders, 502);
    }

    const completion = await completionResp.json().catch(() => null);
    const content = completion?.choices?.[0]?.message?.content;

    if (!content) {
      return json({
        success: false,
        error: "NEAR AI returned empty response",
        path,
      }, corsHeaders, 502);
    }

    let result;
    try {
      const cleaned = content.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
      result = JSON.parse(cleaned);
    } catch {
      result = { raw: content };
    }

    // [T-4 FIX] Bind attestation to this agent invocation — per-request nonce bypasses 4-min
    // cache and proves the enclave that answered was live at the moment of this response.
    // Prevents a cached attestation from covering responses from a replaced enclave.
    const reqNonce = await sha256Hex(`handleAgentRequest:${Date.now()}:${Math.random()}`);
    const attestResult = await fetchAndValidateAttestation(env, { nonce: reqNonce });
    const attestation = attestResult.valid && attestResult.report ? attestResult.report : null;

    return json({
      success: true,
      path,
      mode: "tee-brain",
      agent: agentId,
      result,
      ...(attestation ? { teeAttestation: attestation } : {}),
      model,
      completionId: completion?.id || null,
      ts: new Date().toISOString(),
    }, corsHeaders);

  } catch (err) {
    return json({
      success: false,
      error: "NEAR AI agent error",
      path,
    }, corsHeaders, 502);
  }
}

function buildAgentMessage(path, method, body) {
  const parts = [`Execute YieldAgent request: ${method} ${path}`];

  if (path.startsWith("/bridge/bitcoinos")) {
    parts.push("Protocol: Bitcoin bridge");
    parts.push("Action: Generate bridge quote for cross-chain BTC transfer");
  } else if (path.startsWith("/bridge/layerzero")) {
    parts.push("Protocol: LayerZero v2");
    parts.push("Action: Generate cross-chain messaging/bridge quote");
  } else if (path.startsWith("/integrations/")) {
    parts.push(`Action: Check integration status for ${path.split("/")[2]}`);
  } else if (path.startsWith("/adapters/")) {
    const adapterParts = path.split("/").filter(Boolean);
    const adapter = adapterParts[1] || "unknown";
    const action = adapterParts[2] || "info";
    // Protocol hints for gateway-registered adapters (amnis, stride, eigenlayer added step-6)
    const adapterHints = {
      amnis: "Amnis Finance — Aptos liquid staking (amAPT). Chain: aptos. Return quote/plan with estimatedApyBps, route, asset APT.",
      stride: "Stride — Cosmos native liquid staking (stATOM, stOSMO, etc.). Chain: cosmos. Return quote/plan with estimatedApyBps, route, asset ATOM/OSMO as appropriate.",
      eigenlayer: "EigenLayer — Ethereum native restaking (EigenPod, operators). Chain: ethereum. Return quote/plan with estimatedApyBps, route, asset ETH.",
      morpho:     "Morpho Blue — Ethereum permissionless lending markets. Chain: ethereum. Return quote/plan with estimatedApyBps, route, asset USDC/ETH as appropriate.",
      charms:     "Charms — Bitcoin-native programmable assets protocol (client-side validation, zkVM proofs, Taproot witness). Chain: bitcoin. Return quote/plan noting spell-based execution, asset BTC.",
      axelar:     "Axelar — General message passing (GMP) cross-chain bridge; wraps tokens as axlUSDC/axlUSDT/axlETH across EVM chains. Chain: multi. Return quote/plan with estimatedFeeUSD, route (srcChain→dstChain), asset (axlUSDC preferred for stables), and transfer time estimate.",
      relay:      "Relay — Fast cross-chain bridge for EVM and L2s (relay.link); relayer model with near-instant finality, low fees. Chain: multi. Return quote/plan with estimatedFeeUSD, route (srcChain→dstChain), asset ETH/USDC/USDT, and estimated relay time.",
      gaszip:     "Gas.zip — Gas refuel bridge (gas.zip); sends small amounts of native gas tokens to 130+ chains in one transaction. Chain: multi. Return quote/plan with estimatedFeeUSD, destination chain, amount of gas token delivered, and estimated delivery time.",
      mantle:     "Mantle mETH liquid staking/restaking paths. Chain: mantle. Prefer route quality using mETH as non-payment collateral and stable assets (USDC/USDT/GHO/EURC) for payment legs.",
      aave:       "Aave v3 multi-network pools (including Mantle-compatible EVM routes). Prefer supply/borrow pools for stables first, then ETH-native pools when risk profile allows.",
      volo:       "Volo — Sui liquid staking (vSUI). Chain: sui. Return quote/plan with estimatedApyBps, route, asset SUI or VSUI.",
      haedal:     "Haedal — Sui liquid staking (haSUI). Chain: sui. Return quote/plan with estimatedApyBps, route, asset SUI or HASUI.",
      cetus:      "Cetus — Sui CLMM DEX (swaps, concentrated liquidity). Chain: sui. Return quote/plan with route, slippage, asset in/out.",
      injective:  "Injective — Cosmos SDK L1, EVM-compatible, fast finality; x402 supports agent pay on-chain over HTTP (payTo INJ or stable wallet; verify via Injective LCD/REST e.g. sentry.lcd.injective.network or hub, or chain RPC). Yields: INJ staking ~2.8–~10% context by venue (flex/bonded/third-party stake); DeFi via Helix, Hydro, Mito—LP/perps/vaults; native USDC (CCTP) raises USDC/USDT lending/liquidity ~3–6% context—no single vault REST API, use chain queries + module/contract paths. Return quote/plan with estimatedApyBps, route, asset INJ/USDT/USDC/USDe.",
      helix:      "Helix — Injective DEX (spot/perps, LP). On-chain only; APYs vary. Chain: injective. Return quote/plan with route, slippage, asset INJ/stables.",
      hydro:      "Hydro Protocol — Injective DEX/liquidity. Chain: injective. Return quote/plan with route, asset INJ/USDT/USDC/USDe.",
      mito:       "Mito — Injective vaults / structured yield. Chain: injective. Return quote/plan with estimatedApyBps, route, asset INJ/stables.",
      sovryn:     "Sovryn — Rootstock DeFi (DEX, lending, RBTC-backed). Chain: rootstock. Return quote/plan with estimatedApyBps, route, asset RBTC/DLLR/RUSDT/XUSD/MOC as appropriate.",
      bitlayer:   "BitLayer — BTCFi hub (~$138M+ TVL). YBTC.B and strategies are on-chain (lending/LP via Folks, Volo, etc.); no BOB-style gateway quotes REST—agent routing: use chain RPC (e.g. https://rpc.bitlayer.org) + vault contract reads for shares/APY. PayTo user wallet. No compat unless verify isolation. Return quote/plan with estimatedApyBps, route, asset BTC/YBTC.B.",
      bouncebit:  "BounceBit — BB-token / rebasing vaults; mechanics are deposit → auto-yield → multichain redemption—no documented public vault HTTP API. PayTo BTCB (tokenized BTC) / wallet; settle via chain RPC (~1.1% BTCB base context). No compat unless verify isolation. Return quote/plan with estimatedApyBps, route, asset BTC/USDT/ETH.",
      bob:        "BOB (Build on Bitcoin) — Gateway docs https://docs.gobob.xyz/gateway; SDK getQuote(quoteParams); REST example POST https://gateway.gobob.xyz/api/v1/quotes (confirm vs API Reference). NEAR AI / agent routing: query that gateway for BTC staking yield on bob:mainnet, amount 0.001 BTC, return payTo and APY. Settlement to wallet. Chain: bob.",
      citrea:     "Citrea — BTC ZK-rollup + BitVM bridge; vaults (e.g. ctUSD, BTC collateral) are EVM contracts—no vault REST API yet, ~low single-digit APY spots for stable products. PayTo wallet; gateway/TEE quote + RPC verify. No compat worker unless verify flakes. Chain: citrea.",
      bedrock:    "Bedrock — vault/restake including uniBTC on Merlin. Merlin is EVM ZK-rollup: no vault HTTP API—use RPC (e.g. https://rpc.merlinchain.io) for deposit/claim via contracts; uniBTC-type staking often ~5–15% APY band in docs/market. Agent routing: no gateway quotes URL—RPC + contract calls only. Chain: multi (name Merlin when that leg applies). Return quote/plan with estimatedApyBps, route, asset BTC/uniBTC.",
    };
    const hint = adapterHints[adapter];
    parts.push(`Protocol adapter: ${adapter}`);
    if (hint) parts.push(hint);
    parts.push(`Action: ${action}`);
  } else if (path === "/stake" || path === "/unstake") {
    parts.push(`Action: ${path.replace("/", "")} NEAR tokens`);
    parts.push("Sign and submit NEAR transaction from TEE");
  }

  if (body && Object.keys(body).length > 0) {
    // [H5 FIX] Strip keys that could inject instructions into the agent prompt
    const BLOCKED_KEYS = /^(instruction|prompt|system|role|content|ignore|override|forget|jailbreak|inject)/i;
    const safe = Object.fromEntries(
      Object.entries(body).filter(([k]) => !BLOCKED_KEYS.test(k))
    );
    if (Object.keys(safe).length > 0) {
      const raw = JSON.stringify(safe);
      const bounded = raw.length > 4000 ? `${raw.slice(0, 4000)}...[truncated]` : raw;
      parts.push(`Parameters: ${bounded}`);
    }
  }

  parts.push("Return a JSON response with the result. Include any attestation data.");

  const message = parts.join("\n");
  return message.length > AGENT_MESSAGE_MAX_CHARS
    ? `${message.slice(0, AGENT_MESSAGE_MAX_CHARS)}...[truncated]`
    : message;
}

function remainingBudgetMs(startTs, totalMs, fallbackMs) {
  const elapsed = Date.now() - startTs;
  const remaining = totalMs - elapsed;
  return remaining > 250 ? Math.min(remaining, fallbackMs) : 250;
}

function isRpcCircuitOpen(key) {
  const item = _rpcCircuit.get(key);
  if (!item) return false;
  if ((item.openUntil || 0) > Date.now()) return true;
  if ((item.openUntil || 0) <= Date.now()) _rpcCircuit.delete(key);
  return false;
}

function recordRpcSuccess(key) {
  _rpcCircuit.delete(key);
}

function recordRpcFailure(key) {
  const now = Date.now();
  const prev = _rpcCircuit.get(key) || { failures: 0, openUntil: 0 };
  const failures = prev.failures + 1;
  const openUntil = failures >= RPC_CIRCUIT_THRESHOLD ? now + RPC_CIRCUIT_OPEN_MS : 0;
  _rpcCircuit.set(key, { failures, openUntil });
}

// ============================================================================
// Shared: NEAR AI helpers
// ============================================================================

function nearAiHeaders(apiKey) {
  return {
    "content-type": "application/json",
    "authorization": `Bearer ${apiKey}`,
  };
}

async function fetchNearAi(url, init) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), NEAR_AI_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// [H-01] Single validation path — use fetchAndValidateAttestation for fail-closed semantics
async function fetchAttestation(env) {
  const result = await fetchAndValidateAttestation(env);
  return result.valid && result.report ? result.report : null;
}

// [T-4 parity] Request-bound TEE for live swap/adapter responses — same nonce flow as handleAgentRequest + x402/verify.
async function teeAttestationForLiveRoute(env, routeId) {
  try {
    const boundNonce = await sha256Hex(`${routeId}:${Date.now()}:${Math.random()}`);
    const ar = await fetchAndValidateAttestation(env, { nonce: boundNonce });
    return ar.valid && ar.report ? ar.report : null;
  } catch {
    return null;
  }
}

function isZeroEnclave(mrEnclave) {
  if (typeof mrEnclave !== "string") return true;
  const hex = mrEnclave.toLowerCase().replace(/^0x/, "");
  return hex === "" || /^0+$/.test(hex);
}


// ============================================================================
// Shared: CORS + response helpers
// ============================================================================

function buildCorsHeaders(request, env) {
  const allowed = String(env.CORS_ALLOWED_ORIGINS || "https://api.yieldagentx402.app,https://yieldagentx402.app")
    .split(",").map(s => s.trim()).filter(Boolean);
  const reqOrigin = request.headers.get("Origin") || "";
  const allowOrigin = allowed.includes(reqOrigin) ? reqOrigin : "";  // [M5] Do not reflect first origin to unrecognized callers
  const headers = {
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", // [FIX-D] DELETE added — matches gateway DELETE routes proxied to agent402
    "access-control-allow-headers": "Content-Type, Authorization, x402-payment, x-tee-attestation, X-Internal-Key, X-API-Key",
    "access-control-expose-headers": "x-tee-signature, x-attestation-hash",
    "vary": "Origin",
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  if (allowOrigin) headers["access-control-allow-origin"] = allowOrigin;
  return headers;
}

function json(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}
