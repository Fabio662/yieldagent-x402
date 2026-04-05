/**
 * Marketing "swap + bridge stack" diagram vs integrations wired in Baseline #11.
 * Served at GET /api/integrations/swap-bridge-inventory
 */

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

export function buildSwapBridgeInventory(env) {
  const lz = toBool(env.LAYERZERO_ENABLED, false);
  const charms = toBool(env.CHARMS_ENABLED, false);
  const bcos = toBool(env.BITCOINOS_ENABLED, false);
  const sbtc = toBool(env.SBTC_EXPERIMENTAL_ENABLED, false);

  return {
    success: true,
    updatedAt: new Date().toISOString(),
    legend: {
      live: "Wired: quote/swap or bridge POST (or intent flow) exists in this repo",
      partial: "Related adapter or relay only — not the full generic product in the diagram cell",
      gated: "Code present; enable via env (see note)",
      not_implemented: "No route found in Baseline #11",
    },
    swapAggregators: [
      {
        diagram: "JUPITER",
        status: "live",
        endpoints: [
          "POST {AGENT_URL}/adapters/jupiter/quote",
          "Gateway: ADAPTER_JUPITER_QUOTE_URL → agent",
          "GET /api/intents/solana/quote, POST /api/intents/solana/swap/prepare (Solana intents)",
        ],
      },
      {
        diagram: "CETUS",
        status: "live",
        note: "Sui primary DEX via Cetus Aggregator / Tide. USDC + FUSD pairs (FUSD requires SUI_FUSD_COIN_TYPE env).",
        endpoints: [
          "GET /api/intents/sui/quote, POST /api/intents/sui/swap/prepare",
          "ADAPTER_CETUS_QUOTE_URL / PLAN_URL → agent",
        ],
      },
      {
        diagram: "RUBIC",
        status: "live",
        note: "Rubic.exchange API v2 quoteBest (distinct from Rubicon on Sei — shortKey rubicon vs rubic).",
        endpoints: [
          "POST {AGENT_URL}/adapters/rubic/quote",
          "Gateway: ADAPTER_RUBIC_QUOTE_URL / PLAN_URL → agent",
        ],
        relatedInRepo: { rubiconSeiAdapter: "rubicon-sei", shortKeyRubicon: "rubicon" },
      },
      {
        diagram: "OPENOCEAN",
        status: "live",
        note: "OpenOcean v3 quote API (no key). Host requires gasPrice; agent defaults to 50 gwei if omitted (override body.gasPrice or OPENOCEAN_DEFAULT_GAS_PRICE).",
        endpoints: [
          "POST {AGENT_URL}/adapters/openocean/quote",
          "Gateway: ADAPTER_OPENOCEAN_QUOTE_URL / PLAN_URL → agent",
        ],
      },
      {
        diagram: "SUNSWAP",
        status: "live",
        note: "SunSwap TRON intents wired via /api/intents/tron/* with built-in auto-solver (tron-auto-solver.js). Autobidder bids on TRON intents; auto-settler polls TronGrid and bridges settlements via TEE path. Conservative sim quotes until live SunSwap API quoting is wired.",
        endpoints: [
          "ADAPTER_SUNSWAP_* → POST …/adapters/sunswap/quote",
          "GET /api/intents/tron/info",
          "GET /api/intents/tron/quote?tokenIn=&tokenOut=&amount=",
          "POST /api/intents/tron/swap/prepare",
          "GET /api/intents/tron/status/:txHash",
        ],
      },
      {
        diagram: "ALEX (Stacks, not on card)",
        status: "live",
        note: "Dual-pool routing in stacks-intents.js — ALEX AMM pools 11 (wSTX↔aBTC) and 2 (wSTX↔wBTC) with best-pool selection.",
        alexPools: [
          { id: 11, pair: "wSTX-aBTC", role: "aBTC leg" },
          { id: 2, pair: "wSTX-wBTC", role: "wBTC leg" },
        ],
        endpoints: [
          "GET /api/intents/stacks/quote (auth)",
          "POST /api/intents/stacks/swap/prepare (auth)",
          "GET /api/intents/stacks/pools (public)",
          "Adapter alex: yield quote via agent; swap execution = intents routes above",
        ],
      },
      {
        diagram: "Bitflow sBTC (Stacks, not on card)",
        status: sbtc ? "live" : "gated",
        note: sbtc
          ? "Experimental Bitflow XYK sBTC↔STX pool SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR (xyk-pool-sbtc-stx-v-1-1); guards in bitflow-sbtc-router.js"
          : "Set SBTC_EXPERIMENTAL_ENABLED=true in wrangler to expose getSbtcRoute after risk guards",
        endpoints: ["GET /api/intents/stacks/sbtc/check"],
        bitflowPoolContract: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR",
        env: { SBTC_EXPERIMENTAL_ENABLED: sbtc },
      },
      {
        diagram: "EKUBO (Starknet)",
        status: "live",
        note: "Starknet primary DEX via Ekubo Protocol with Anuv fallback. USDC/USDT/LUSD pairs (LUSD requires STARKNET_LUSD_ADDRESS env).",
        endpoints: [
          "GET /api/intents/starknet/quote, POST /api/intents/starknet/swap/prepare",
          "ADAPTER_EKUBO_QUOTE_URL / ADAPTER_ANUV_QUOTE_URL",
        ],
      },
      {
        diagram: "XRPL NATIVE DEX",
        status: "live",
        note: "XRPL built-in order book DEX. Pairs: XRP↔USD, RLUSD↔USDC, any trust-line IOU. OfferCreate tx template in prepare.",
        endpoints: [
          "GET /api/intents/xrpl/quote, POST /api/intents/xrpl/swap/prepare",
          "GET /api/intents/xrpl/orderbook",
        ],
      },
      {
        diagram: "HERMETICA (Stacks yields)",
        status: "live",
        note: "USD yield vaults on Stacks: USDA (Arkadiko), USDh (Hermetica), USDCx (wrapped USDC). Exposed via adapter hermetica-stacks.",
        endpoints: [
          "GET /api/intents/stacks/info (venues.hermetica)",
          "ADAPTER_HERMETICA_* → /adapters/hermetica/quote",
        ],
      },
    ],
    bridges: [
      {
        diagram: "AXELAR SDK",
        status: "partial",
        note: "No first-party Axelar quote handler. NEAR intents use Defuse-1Click relay, which may include Axelar among route types.",
        endpoints: ["POST /api/intents/near/swap", "1click.chaindefuser.com (near-intents.js)"],
      },
      {
        diagram: "NAVI",
        status: "live",
        endpoints: ["ADAPTER_NAVI_* → /adapters/navi/quote"],
      },
      {
        diagram: "NEAR INTENTS",
        status: "live",
        endpoints: [
          "/api/intents/near/*",
          "Solver relay: solver-relay-v2.chaindefuser.com",
        ],
      },
      {
        diagram: "LAYERZERO V2",
        status: lz ? "live" : "off",
        endpoints: ["/api/bridge/layerzero/quote", "/api/bridge/layerzero/verify", "{AGENT_URL}/bridge/layerzero/quote"],
        env: { LAYERZERO_ENABLED: lz },
      },
      {
        diagram: "SECURED FINANCE",
        status: "live",
        note: "Filecoin only — never route Secured to Stacks. Gateway quotes prefer ADAPTER_SECURED_QUOTE_URL then GLIF on /api/intents/filecoin/*.",
        endpoints: [
          "ADAPTER_SECURED_QUOTE_URL (Filecoin swap/lend/bridge)",
          "GET /api/intents/filecoin/quote, POST /api/intents/filecoin/swap/prepare",
        ],
      },
      {
        diagram: "CHARMS",
        status: charms ? "live" : "off",
        endpoints: ["/api/bridge/charms/quote", "/api/integrations/charms/status"],
        env: { CHARMS_ENABLED: charms },
      },
      {
        diagram: "BITCOINOS (related)",
        status: bcos ? "live" : "off",
        endpoints: ["/api/bridge/bitcoinos/quote"],
        env: { BITCOINOS_ENABLED: bcos },
      },
      {
        diagram: "ALLBRIDGE",
        status: "live",
        note: "EVM ↔ Stacks ↔ Solana ↔ NEAR USDC/USDT/STX bridging. No API key required. core.api.allbridgeapp.com token-info + transfer endpoints.",
        endpoints: [
          "POST {AGENT_URL}/adapters/allbridge/quote",
          "POST {AGENT_URL}/adapters/allbridge/plan",
          "Gateway: ADAPTER_ALLBRIDGE_QUOTE_URL / PLAN_URL → agent",
        ],
      },
    ],
  };
}
