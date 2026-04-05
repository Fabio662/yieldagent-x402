// src/adapters.js
// YieldAgent Protocol Adapter Framework — Production hardened
//
// SECURITY FIXES:
//   [FIX-A1] No CORS headers emitted — gateway withCors() sets them
//   [FIX-A2] callLive never leaks upstream URL in response envelope
//   [FIX-A3] callLive returns null on 4xx/5xx (sim fallback kicks in for auto mode)
//   [FIX-A4] TEE attestation surfaced from upstream response body or TEE headers when present
//   [FIX-A5] Body size cap on all inbound adapter requests (64 KB)
//   [FIX-A6] Telemetry never throws, never breaks adapter execution
//   [FIX-A7] Every adapter response includes provenance, confidence, verificationHint (enterprise truth labeling)

import {
  normalizeNetworkSlug,
  getIntentBaseForSlug,
  resolveNetworkMetadata,
  CORE_EVM_NETWORK_DEFS,
  BRIDGE_AGGREGATOR_NETWORK_DEFS,
} from "./network-registry.js";

const DEFAULT_TIMEOUT_MS = 7000;
const MAX_BODY_BYTES     = 65536; // 64 KB
const MAX_ADAPTER_KEY_LEN = 64;
const MIN_CONFIDENCE_THRESHOLD = 0.35;

// [FIX-A9] Cap provided-key echo in 404 responses — prevents long/sensitive input leak
function safeEchoKey(v) {
  return v == null ? undefined : String(v).slice(0, 64);
}

function validateAdapterKey(key) {
  const k = String(key || "").trim();
  if (!k) return { valid: false, error: "Adapter key cannot be empty" };
  if (k.length > MAX_ADAPTER_KEY_LEN) return { valid: false, error: `Adapter key too long (max ${MAX_ADAPTER_KEY_LEN} chars)` };
  if (!/^[a-zA-Z0-9_-]+$/.test(k)) return { valid: false, error: "Adapter key contains invalid characters" };
  return { valid: true, key: k.toLowerCase() };
}

function sanitizeRequestedAdapterKey(v) {
  const check = validateAdapterKey(v);
  return check.valid ? check.key : null;
}

const STRIP_KEYS = new Set([
  "apikey", "api_key", "authorization", "secret", "secretkey", "secret_key",
  "internalkey", "internal_key", "password", "token", "accesstoken",
  "access_token", "privatekey", "private_key", "walletsecret", "mnemonic",
  "seed", "seedphrase", "seed_phrase", "upstreamurl", "upstream_url", "agentapikey",
  "internal_shared_key", "near_ai_api_key", "admin_key", "alchemy_api_key",
  "credentials", "bearer",
]);

function looksSensitiveKey(key) {
  const k = String(key || "").toLowerCase();
  if (!k) return false;
  if (STRIP_KEYS.has(k)) return true;
  return /(secret|token|api[_-]?key|password|private[_-]?key|mnemonic|seed|authorization|credential)/i.test(k);
}

function stripSecrets(obj, state, depth = 0, seen = new WeakSet()) {
  if (obj == null || typeof obj !== "object" || depth > 10) return obj;
  if (seen.has(obj)) return null;
  seen.add(obj);
  if (Array.isArray(obj)) return obj.map((v) => stripSecrets(v, state, depth + 1, seen));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (looksSensitiveKey(k)) {
      state.count += 1;
      if (state.count <= 20) state.keys.add(k);
      // Keep schema shape when possible while removing sensitive value.
      out[k] = "REDACTED";
      continue;
    }
    out[k] = typeof v === "object" ? stripSecrets(v, state, depth + 1, seen) : v;
  }
  return out;
}

// ============================================================================
// Token registry — canonical token metadata for validation + discovery
// ============================================================================

const TOKEN_REGISTRY = {
  ETH:   { symbol: "ETH",   name: "Ethereum",          class: "native",         chains: ["ethereum", "base", "arbitrum", "optimism", "polygon", "linea", "scroll", "zksync", "mode", "blast", "evm"] },
  BTC:   { symbol: "BTC",   name: "Bitcoin",           class: "native",         chains: ["bitcoin"] },
  CTUSD: { symbol: "CTUSD", name: "Citrea USD (vault/stable context)", class: "stable", chains: ["citrea", "evm"] },
  FBTC:  { symbol: "FBTC",  name: "fBTC",              class: "token",          chains: ["mantle", "evm"] },
  NEAR:  { symbol: "NEAR",  name: "NEAR",              class: "native",         chains: ["near"] },
  STX:   { symbol: "STX",   name: "Stacks",            class: "native",         chains: ["stacks"] },
  SUI:   { symbol: "SUI",   name: "Sui",               class: "native",         chains: ["sui"] },
  FIL:   { symbol: "FIL",   name: "Filecoin",          class: "native",         chains: ["filecoin"] },
  WFIL:  { symbol: "WFIL",  name: "Wrapped Filecoin",  class: "token",          chains: ["filecoin", "evm"] },
  APT:   { symbol: "APT",   name: "Aptos",             class: "native",         chains: ["aptos"] },
  ATOM:  { symbol: "ATOM",  name: "Cosmos",            class: "native",         chains: ["cosmos"] },
  FLR:   { symbol: "FLR",   name: "Flare",             class: "native",         chains: ["flare"] },
  STRK:  { symbol: "STRK",  name: "Starknet",          class: "native",         chains: ["starknet"] },
  AVAX:  { symbol: "AVAX",  name: "Avalanche",         class: "native",         chains: ["avalanche"] },
  POL:   { symbol: "POL",   name: "Polygon",           class: "native",         chains: ["polygon", "evm"] },
  BNB:   { symbol: "BNB",   name: "BNB",               class: "native",         chains: ["bsc", "bnb", "evm"] },
  MNT:   { symbol: "MNT",   name: "Mantle",            class: "native",         chains: ["mantle", "evm"] },
  SEI:   { symbol: "SEI",   name: "Sei",               class: "native",         chains: ["sei"] },
  INJ:   { symbol: "INJ",   name: "Injective",         class: "native",         chains: ["injective"] },
  TRX:   { symbol: "TRX",   name: "TRON",              class: "native",         chains: ["tron"] },
  SOL:   { symbol: "SOL",   name: "Solana",            class: "native",         chains: ["solana"] },
  mETH:  { symbol: "mETH",  name: "Mantle Staked ETH", class: "liquid-staking", chains: ["mantle", "ethereum", "evm"] },
  cmETH: { symbol: "cmETH", name: "Canonical mETH",    class: "liquid-staking", chains: ["mantle", "evm"] },
  AUSD:  { symbol: "AUSD",  name: "AUSD",              class: "stable",         chains: ["mantle", "evm"] },
  GHO:   { symbol: "GHO",   name: "GHO",               class: "stable",         chains: ["ethereum", "evm"] },
  FRXUSD:{ symbol: "FRXUSD", name: "Frax USD",         class: "stable",         chains: ["ethereum", "near", "evm", "sei"] },
  DAI:   { symbol: "DAI",   name: "Dai",               class: "stable",         chains: ["ethereum", "base", "arbitrum", "optimism", "polygon", "avalanche", "near", "evm", "multi"] },
  BUCK:  { symbol: "BUCK",  name: "Bucket USD",         class: "stable",         chains: ["sui"] },
  FDUSD: { symbol: "FDUSD", name: "First Digital USD",  class: "stable",         chains: ["sui", "evm"] },
  USDY:  { symbol: "USDY",  name: "Ondo U.S. Dollar Yield", class: "stable",     chains: ["sui", "ethereum", "evm"] },
  VSUI:  { symbol: "VSUI",  name: "Volo Staked SUI",   class: "liquid-staking", chains: ["sui"] },
  HASUI: { symbol: "HASUI", name: "Haedal Staked SUI", class: "liquid-staking", chains: ["sui"] },
  NAVX:  { symbol: "NAVX",  name: "Navi Protocol Token", class: "token",          chains: ["sui"] },
  USDFC: { symbol: "USDFC", name: "USDFC",              class: "stable",         chains: ["filecoin"] },
  USDS:  { symbol: "USDS",  name: "USDS",               class: "stable",         chains: ["filecoin", "evm"] },
  USDD:  { symbol: "USDD",  name: "USDD",               class: "stable",         chains: ["tron", "filecoin"] },
  RLUSD: { symbol: "RLUSD", name: "Ripple USD",         class: "stable",         chains: ["xrp", "flare", "evm"] },
  XRP:   { symbol: "XRP",   name: "XRP",                class: "token",          chains: ["xrp", "flare"] },
  USDH:  { symbol: "USDH",  name: "USDH",               class: "stable",         chains: ["hyperliquid", "stacks"] },
  BOLD:  { symbol: "BOLD",  name: "BOLD",               class: "token",          chains: ["hyperliquid"] },
  DLLR:  { symbol: "DLLR",  name: "Dollar on Rootstock", class: "stable",        chains: ["rootstock"] },
  MOC:   { symbol: "MOC",   name: "MOC",                class: "token",          chains: ["rootstock"] },
  RUSDT: { symbol: "RUSDT", name: "RIF USDT",           class: "stable",         chains: ["rootstock"] },
  XUSD:  { symbol: "XUSD",  name: "XUSD",               class: "stable",         chains: ["rootstock"] },
  SBTC:  { symbol: "SBTC",  name: "sBTC",               class: "token",          chains: ["stacks"] },
  "YBTC.B": { symbol: "YBTC.B", name: "YBTC.B (BitLayer wrapped BTC yield)", class: "token", chains: ["bitlayer", "evm"] },
  USDCX: { symbol: "USDCX", name: "USDCx",              class: "stable",         chains: ["stacks"] },
  USDA:  { symbol: "USDA",  name: "USDA",               class: "stable",         chains: ["stacks"] },
  EURC:  { symbol: "EURC",  name: "Euro Coin",          class: "stable",         chains: ["base", "evm"] },
  USDbC: { symbol: "USDbC", name: "USD Base Coin",      class: "stable",         chains: ["base", "evm"] },
  LUSD:  { symbol: "LUSD",  name: "Liquity USD",        class: "stable",         chains: ["starknet", "evm"] },
  MUSD:  { symbol: "MUSD",  name: "mUSD",               class: "stable",         chains: ["linea", "evm"] },
  USDT:  { symbol: "USDT",  name: "Tether USD",        class: "stable",         chains: ["ethereum", "base", "arbitrum", "optimism", "polygon", "avalanche", "solana", "near", "stacks", "injective", "hyperliquid", "sui", "evm", "multi"] },
  USDC:  { symbol: "USDC",  name: "USD Coin",           class: "stable",         chains: ["ethereum", "base", "arbitrum", "optimism", "polygon", "avalanche", "solana", "near", "stacks", "mantle", "filecoin", "sui", "hyperliquid", "injective", "evm", "multi"] },
  USDe:  { symbol: "USDe",  name: "USDe",               class: "stable",         chains: ["ethereum", "filecoin", "hyperliquid", "evm"] },
  USDT0: { symbol: "USDT0", name: "USDT0",              class: "stable",         chains: ["mantle", "filecoin", "evm", "multi"] },
  PYUSD: { symbol: "PYUSD", name: "PayPal USD",        class: "stable",         chains: ["solana", "evm"] },
  USD1:  { symbol: "USD1",  name: "USD1",              class: "stable",         chains: ["solana", "filecoin"] },
  JLUSD: { symbol: "JLUSD", name: "JLUSD",             class: "stable",         chains: ["solana"] },
  USDG:  { symbol: "USDG",  name: "USDG",              class: "stable",         chains: ["solana"] },
  SYRUPUSD: { symbol: "SYRUPUSD", name: "SyrupUSD",    class: "stable",         chains: ["solana"] },
};

export { TOKEN_REGISTRY };

function resolveTokenSymbol(input) {
  if (!input) return null;
  const upper = String(input).trim().toUpperCase();
  const aliases = {
    "FRAX": "FRXUSD",
    "FRAX USD": "FRXUSD",
    "USDTO": "USDT0",
    "USDT-0": "USDT0",
    "USDT 0": "USDT0",
    "USDBC": "USDbC",
    "USDB.C": "USDbC",
    "AVX": "AVAX",
    "RLLUSE": "RLUSD",
    "RLLUSD": "RLUSD",
    "RUSDT": "RUSDT",
    "R-USDT": "RUSDT",
    "R USDT": "RUSDT",
    "F-BTC": "FBTC",
    "F BTC": "FBTC",
    "PUMPBTC": "FBTC",
    "WRAPPED FIL": "WFIL",
    "WRAPPED FILECOIN": "WFIL",
    "ONDO USDY": "USDY",
    "HA SUI": "HASUI",
    "NAVI TOKEN": "NAVX",
    YBTC: "YBTC.B",
    "YBTC B": "YBTC.B",
    BTCB: "BTC",
  };
  if (aliases[upper]) return aliases[upper];
  for (const [sym, meta] of Object.entries(TOKEN_REGISTRY)) {
    if (sym.toUpperCase() === upper) return sym;
    if (meta.name.toUpperCase() === upper) return sym;
  }
  return null;
}

function adapterSupportsToken(adapterDef, tokenSymbol) {
  const tokens = adapterDef.supportedTokens;
  if (!tokens || tokens.length === 0) return true;
  return tokens.some((t) => t.toUpperCase() === tokenSymbol.toUpperCase());
}

// ============================================================================
// Adapter definitions — catalog adapter definitions across supported chains; live-enabled count comes from federation status
// ============================================================================

const ADAPTER_DEFS = [
  {
    key: "rhea-near", shortKey: "rhea",
    aliases:   ["rhea", "rhea-near", "rhea-finance", "rheafinance"],
    name:      "Rhea Finance", chain: "near", category: "vault", status: "active",
    actions:   ["deposit", "withdraw", "rebalance"],
    supportedTokens: ["NEAR", "USDC", "USDT", "FRXUSD", "DAI"],
    homepage:  "https://rhea.finance/",
    envPrefix: "ADAPTER_RHEA", defaultMode: "live",
  },
  {
    key: "babylon-btc", shortKey: "babylon",
    aliases:   ["babylon", "babylon-btc", "babylon-staking", "babylonchain"],
    name:      "Babylon", chain: "bitcoin", category: "security", status: "active",
    actions:   ["stake", "unstake", "delegate"],
    supportedTokens: ["BTC"],
    homepage:  "https://babylonchain.io/",
    envPrefix: "ADAPTER_BABYLON", defaultMode: "live",
  },
  {
    key: "zest-stacks", shortKey: "zest",
    aliases:   ["zest", "zest-stacks", "zest-stx", "zestprotocol", "zest-protocol"],
    name:      "Zest", chain: "stacks", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw"],
    supportedTokens: ["SBTC", "STX", "USDCX", "USDH", "USDA"],
    homepage:  "https://app.zestprotocol.com/",
    envPrefix: "ADAPTER_ZEST", defaultMode: "live",
  },
  {
    key: "lombard-base", shortKey: "lombard",
    aliases:   ["lombard", "lombard-base", "lombardfinance", "lombard-finance"],
    name:      "Lombard", chain: "base", category: "btcfi", status: "active",
    actions:   ["quote", "plan", "deposit", "mint", "stake"],
    supportedTokens: ["BTC", "ETH", "USDC"],
    homepage:  "https://www.lombard.finance/app",
    envPrefix: "ADAPTER_LOMBARD", defaultMode: "live",
  },
  {
    key: "solv-multi", shortKey: "solv",
    aliases:   ["solv", "solv-multi", "solv-btcfi", "solv-finance", "solvfinance"],
    name:      "Solv Finance", chain: "multi", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "redeem", "withdraw"],
    supportedTokens: ["BTC", "FBTC", "ETH", "USDC"],
    homepage:  "https://solv.finance/",
    envPrefix: "ADAPTER_SOLV", defaultMode: "live",
    // Representative EVM deployments; agent may route more chains.
    networks: [...CORE_EVM_NETWORK_DEFS],
  },
  {
    key: "euler-evm", shortKey: "euler",
    aliases:   ["euler", "euler-evm", "euler-multi", "euler-finance"],
    name:      "Euler", chain: "evm", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw"],
    supportedTokens: ["USDC", "EURC", "GHO", "ETH", "USDbC", "USDT", "BNB", "USDT0", "DAI", "AUSD", "USDe", "AVAX", "POL"],
    homepage:  "https://app.euler.finance/",
    envPrefix: "ADAPTER_EULER", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
    primaryCaip2: "eip155:1",
  },
  {
    key: "aave-evm", shortKey: "aave",
    aliases:   ["aave", "aave-evm", "aave-v3", "aave3", "aave-finance"],
    name:      "Aave V3", chain: "evm", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw", "repay"],
    supportedTokens: ["USDC", "EURC", "GHO", "ETH", "USDbC", "USDT", "BNB", "USDT0", "DAI", "AUSD", "USDe", "AVAX", "POL"],
    homepage:  "https://app.aave.com/",
    envPrefix: "ADAPTER_AAVE", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
    primaryCaip2: "eip155:1",
  },
  {
    key: "silo-evm", shortKey: "silo",
    aliases:   ["silo", "silo-evm", "silo-finance", "silo-multi", "silofinance"],
    name:      "Silo Finance", chain: "evm", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw"],
    supportedTokens: ["USDC", "EURC", "GHO", "ETH", "USDbC", "USDT", "BNB", "USDT0", "DAI", "AUSD", "USDe", "AVAX", "POL"],
    homepage:  "https://www.silo.finance/",
    envPrefix: "ADAPTER_SILO", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
    primaryCaip2: "eip155:1",
  },
  {
    key: "suilend-sui", shortKey: "suilend",
    aliases:   ["suilend", "suilend-sui"],
    name:      "Suilend", chain: "sui", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw"],
    supportedTokens: ["SUI", "USDC", "USDT", "BUCK", "FDUSD", "USDY", "NAVX"],
    homepage:  "https://suilend.fi/",
    envPrefix: "ADAPTER_SUILEND", defaultMode: "live",
  },
  {
    key: "clovis-sei", shortKey: "clovis",
    aliases:   ["clovis", "clovis-sei"],
    name:      "Clovis", chain: "sei", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["USDC", "FRXUSD", "USDT0", "SEI"],
    homepage:  "https://vault.clovis.network/",
    envPrefix: "ADAPTER_CLOVIS", defaultMode: "live",
  },
  {
    key: "yei-sei", shortKey: "yei",
    aliases:   ["yei", "yei-sei", "yei-finance", "yeifinance"],
    name:      "Yei Finance", chain: "sei", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw", "repay"],
    supportedTokens: ["USDC", "FRXUSD", "USDT0", "SEI"],
    homepage:  "https://app.yei.finance/?marketName=sei_mainnet_1",
    envPrefix: "ADAPTER_YEI", defaultMode: "live",
  },
  {
    key: "katana-evm", shortKey: "katana",
    aliases:   ["katana", "katana-evm", "katana-multi", "katana-network"],
    name:      "Katana", chain: "evm", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["USDC", "EURC", "GHO", "ETH", "USDbC", "USDT", "BNB", "USDT0", "DAI", "AUSD", "USDe", "AVAX", "POL"],
    homepage:  "https://katana.network/",
    envPrefix: "ADAPTER_KATANA", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
    primaryCaip2: "eip155:1",
  },
  {
    key: "thevault-evm", shortKey: "thevault",
    aliases:   ["thevault", "thevault-evm", "thevault-multi", "thevault-finance", "the-vault"],
    name:      "TheVault", chain: "evm", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["USDC", "EURC", "GHO", "ETH", "USDbC", "USDT", "BNB", "USDT0", "DAI", "AUSD", "USDe", "AVAX", "POL"],
    homepage:  "https://thevault.finance/",
    envPrefix: "ADAPTER_THEVAULT", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
    primaryCaip2: "eip155:1",
  },
  {
    key: "endur-starknet", shortKey: "endur",
    aliases:   ["endur", "endur-starknet", "endur-fi", "endur-strk"],
    name:      "Endur", chain: "starknet", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["STRK", "ETH", "BTC", "LUSD"],
    homepage:  "https://app.endur.fi/strk",
    envPrefix: "ADAPTER_ENDUR", defaultMode: "live",
  },
  {
    key: "bitcoinos-bitcoin", shortKey: "bitcoinos",
    aliases:   ["bitcoinos", "bitcoin-os", "bitcoinos-bitcoin"],
    name:      "BitcoinOS", chain: "bitcoin", category: "bridge", status: "active",
    actions:   ["quote", "plan", "bridge", "verify"],
    supportedTokens: ["BTC", "SBTC", "WBTC"],
    homepage:  "https://www.bitcoinos.build/",
    envPrefix: "ADAPTER_BITCOINOS", defaultMode: "live",
  },
  {
    key: "charms-bitcoin", shortKey: "charms",
    aliases:   ["charms", "charms-bitcoin", "charms-btc", "charm", "charms-protocol"],
    name:      "Charms", chain: "bitcoin", category: "bridge", status: "active",
    actions:   ["quote", "plan", "bridge", "mint", "burn"],
    supportedTokens: ["BTC", "SBTC", "CHARM"],
    homepage:  "https://charms.dev/",
    envPrefix: "ADAPTER_CHARMS", defaultMode: "live",
  },
  {
    key: "layerzero-multi", shortKey: "layerzero",
    aliases:   ["layerzero", "lz", "layerzero-v2", "lz-v2", "layerzero-multi"],
    name:      "LayerZero v2", chain: "multi", category: "bridge", status: "active",
    actions:   ["quote", "plan", "bridge", "verify"],
    supportedTokens: ["USDC", "USDT", "ETH", "BTC", "BNB"],
    homepage:  "https://layerzero.network/",
    envPrefix: "ADAPTER_LAYERZERO", defaultMode: "live",
    networks: [
      { slug: "ethereum",  caip2: "eip155:1" },
      { slug: "base",      caip2: "eip155:8453" },
      { slug: "arbitrum",  caip2: "eip155:42161" },
      { slug: "optimism",  caip2: "eip155:10" },
      { slug: "polygon",   caip2: "eip155:137" },
      { slug: "bsc",       caip2: "eip155:56" },
      { slug: "avalanche", caip2: "eip155:43114" },
      { slug: "solana",    caip2: "solana:mainnet" },
      { slug: "filecoin",  caip2: "eip155:314" },
    ],
  },
  {
    key: "axelar-multi", shortKey: "axelar",
    aliases:   ["axelar", "axelar-sdk", "axelar-multi", "axelar-bridge", "axelar-gmp"],
    name:      "Axelar", chain: "multi", category: "bridge", status: "active",
    actions:   ["quote", "plan", "bridge", "cross-chain"],
    supportedTokens: ["USDC", "USDT", "ETH", "WBTC", "DAI", "axlUSDC", "axlUSDT", "axlETH"],
    homepage:  "https://axelar.network/",
    envPrefix: "ADAPTER_AXELAR", defaultMode: "live",
    networks: [
      { slug: "ethereum",  caip2: "eip155:1" },
      { slug: "base",      caip2: "eip155:8453" },
      { slug: "arbitrum",  caip2: "eip155:42161" },
      { slug: "optimism",  caip2: "eip155:10" },
      { slug: "polygon",   caip2: "eip155:137" },
      { slug: "avalanche", caip2: "eip155:43114" },
      { slug: "bsc",       caip2: "eip155:56" },
    ],
  },
  {
    key: "relay-multi", shortKey: "relay",
    aliases:   ["relay", "relay-bridge", "relay-link", "relay-multi"],
    name:      "Relay", chain: "multi", category: "bridge", status: "active",
    actions:   ["quote", "plan", "bridge", "cross-chain"],
    supportedTokens: ["ETH", "USDC", "USDT", "WETH", "DAI"],
    homepage:  "https://relay.link/",
    envPrefix: "ADAPTER_RELAY", defaultMode: "live",
    networks: [
      { slug: "ethereum",  caip2: "eip155:1" },
      { slug: "base",      caip2: "eip155:8453" },
      { slug: "arbitrum",  caip2: "eip155:42161" },
      { slug: "optimism",  caip2: "eip155:10" },
      { slug: "polygon",   caip2: "eip155:137" },
      { slug: "zora",      caip2: "eip155:7777777" },
    ],
  },
  {
    key: "gaszip-multi", shortKey: "gaszip",
    aliases:   ["gaszip", "gas-zip", "gas.zip", "gaszip-multi", "gaszip-bridge"],
    name:      "Gas.zip", chain: "multi", category: "bridge", status: "active",
    actions:   ["quote", "plan", "bridge", "gas-refuel"],
    supportedTokens: ["ETH", "USDC", "USDT", "MATIC", "BNB", "AVAX", "SOL"],
    homepage:  "https://www.gas.zip/",
    envPrefix: "ADAPTER_GASZIP", defaultMode: "live",
  },
  {
    key: "hermetica-stacks", shortKey: "hermetica",
    aliases:   ["hermetica", "hermetica-stacks", "hermetica-fi", "usdh"],
    name:      "Hermetica", chain: "stacks", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "stake", "unstake", "withdraw"],
    supportedTokens: ["SBTC", "STX", "USDCX", "USDH", "USDA"],
    homepage:  "https://app.hermetica.fi/",
    envPrefix: "ADAPTER_HERMETICA", defaultMode: "live",
  },
  {
    key: "justlend-tron", shortKey: "justlend",
    aliases:   ["justlend", "justlend-tron", "justlend-dao"],
    name:      "JustLend", chain: "tron", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw", "repay"],
    supportedTokens: ["USDT", "USDD", "TRX"],
    homepage:  "https://app.justlend.org/",
    envPrefix: "ADAPTER_JUSTLEND", defaultMode: "live",
  },
  {
    key: "sunswap-tron", shortKey: "sunswap",
    aliases:   ["sunswap", "sunswap-tron", "sunswap-v2", "sunswap-v3"],
    name:      "SunSwap", chain: "tron", category: "dex", status: "active",
    actions:   ["quote", "swap", "plan"],
    supportedTokens: ["USDT", "USDD", "TRX"],
    homepage:  "https://sunswap.com/",
    envPrefix: "ADAPTER_SUNSWAP", defaultMode: "live",
  },
  {
    key: "secured-filecoin", shortKey: "secured",
    aliases:   ["secured", "secured-filecoin", "secured-multi", "secured-finance", "securedfinance", "usdfc", "usdfc-filecoin"],
    name:      "Secured Finance", chain: "filecoin", category: "lending", status: "active",
    actions:   ["quote", "plan", "lend", "borrow", "deposit", "withdraw", "mint", "swap", "vault"],
    supportedTokens: ["WFIL", "FIL", "USDC", "USDFC"],
    homepage:  "https://secured.finance/",
    envPrefix: "ADAPTER_SECURED", defaultMode: "live",
  },
  {
    key: "secured-axelar", shortKey: "secured-bridge",
    aliases:   ["secured-axelar", "secured-bridge", "axelar-filecoin", "axelar-fil", "fil-bridge"],
    name:      "Secured Finance × Axelar", chain: "filecoin", category: "bridge", status: "active",
    actions:   ["quote", "plan", "bridge", "cross-chain"],
    supportedTokens: ["FIL", "WFIL", "USDC", "USDT0", "USDe", "USDD", "USDS", "USD1", "USDFC"],
    homepage:  "https://secured.finance/",
    envPrefix: "ADAPTER_SECURED", defaultMode: "live",
  },
  {
    key: "glif-filecoin", shortKey: "glif",
    aliases:   ["glif", "glif-filecoin", "glif-pool", "infinity-pool", "ifil"],
    name:      "GLIF", chain: "filecoin", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake"],
    supportedTokens: ["FIL", "WFIL", "USDC", "USDFC"],
    homepage:  "https://www.glif.io/en/pool/infinity",
    envPrefix: "ADAPTER_GLIF", defaultMode: "live",
  },
  {
    key: "kamino-solana", shortKey: "kamino",
    aliases:   ["kamino", "kamino-solana", "kamino-finance", "kamino-lend", "klend"],
    name:      "Kamino Finance", chain: "solana", category: "lending", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "supply", "borrow"],
    supportedTokens: ["PYUSD", "USDT", "USDC", "USD1", "JLUSD", "USDG", "SYRUPUSD", "SOL"],
    homepage:  "https://app.kamino.finance/",
    envPrefix: "ADAPTER_KAMINO", defaultMode: "live",
  },
  {
    key: "jupiter-solana", shortKey: "jupiter",
    aliases:   ["jupiter", "jupiter-solana", "jupiter-ag", "jup", "jup-ag"],
    name:      "Jupiter", chain: "solana", category: "dex", status: "active",
    actions:   ["quote", "swap", "plan"],
    supportedTokens: ["PYUSD", "USDT", "USDC", "USD1", "JLUSD", "USDG", "SYRUPUSD", "SOL"],
    homepage:  "https://jup.ag/",
    envPrefix: "ADAPTER_JUPITER", defaultMode: "live",
  },
  {
    key: "allbridge-multi", shortKey: "allbridge",
    aliases:   ["allbridge", "allbridge-multi", "all-bridge"],
    name:      "AllBridge", chain: "multi", category: "bridge", status: "active",
    actions:   ["quote", "plan", "bridge", "transfer"],
    supportedTokens: ["USDC", "USDT", "STX", "SBTC", "ETH", "BNB", "SOL"],
    homepage:  "https://app.allbridge.io/",
    envPrefix: "ADAPTER_ALLBRIDGE", defaultMode: "live",
    networks: [
      { slug: "stacks",   caip2: "stacks:1" },
      { slug: "ethereum", caip2: "eip155:1" },
      { slug: "base",     caip2: "eip155:8453" },
      { slug: "solana",   caip2: "solana:mainnet" },
      { slug: "near",     caip2: "near:mainnet" },
      { slug: "bnb",      caip2: "eip155:56" },
    ],
  },
  {
    key: "openocean-evm", shortKey: "openocean",
    aliases:   ["openocean", "open-ocean", "openocean-evm", "oo"],
    name:      "OpenOcean", chain: "evm", category: "dex", status: "active",
    actions:   ["quote", "swap", "plan"],
    supportedTokens: ["USDC", "EURC", "GHO", "ETH", "USDbC", "USDT", "BNB", "USDT0", "DAI", "AUSD", "USDe", "AVAX", "POL", "MNT", "mETH", "cmETH", "FBTC"],
    homepage:  "https://openocean.finance/",
    envPrefix: "ADAPTER_OPENOCEAN", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
    primaryCaip2: "eip155:1",
  },
  {
    key: "rubic-multi", shortKey: "rubic",
    aliases:   ["rubic", "rubic-exchange", "rubic-multi"],
    name:      "Rubic", chain: "multi", category: "dex", status: "active",
    actions:   ["quote", "swap", "plan", "bridge"],
    supportedTokens: ["USDC", "USDe", "GHO", "USDT0", "AUSD", "MNT", "mETH", "cmETH", "FBTC", "BNB", "ETH", "BTC"],
    homepage:  "https://rubic.exchange/",
    envPrefix: "ADAPTER_RUBIC", defaultMode: "live",
    networks: [...BRIDGE_AGGREGATOR_NETWORK_DEFS],
    primaryCaip2: "eip155:1",
  },
  {
    key: "navi-sui", shortKey: "navi",
    aliases:   ["navi", "navi-sui", "navi-protocol", "navx"],
    name:      "Navi Protocol", chain: "sui", category: "lending", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "supply", "borrow"],
    supportedTokens: ["SUI", "USDC", "USDT", "BUCK", "FDUSD", "USDY", "NAVX"],
    homepage:  "https://www.naviprotocol.io/",
    envPrefix: "ADAPTER_NAVI", defaultMode: "live",
  },
  {
    key: "scallop-sui", shortKey: "scallop",
    aliases:   ["scallop", "scallop-sui", "scallop-lend", "sca"],
    name:      "Scallop", chain: "sui", category: "lending", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "supply", "borrow"],
    supportedTokens: ["SUI", "USDC", "USDT", "BUCK", "FDUSD", "USDY", "NAVX"],
    homepage:  "https://app.scallop.io/",
    envPrefix: "ADAPTER_SCALLOP", defaultMode: "live",
  },
  {
    key: "volo-sui", shortKey: "volo",
    aliases:   ["volo", "volo-sui", "volosui", "volo-liquid-staking"],
    name:      "Volo", chain: "sui", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "stake", "unstake", "deposit", "withdraw"],
    supportedTokens: ["SUI", "VSUI", "USDC", "USDT", "USDY", "NAVX"],
    homepage:  "https://www.volosui.com/stake",
    envPrefix: "ADAPTER_VOLO", defaultMode: "live",
  },
  {
    key: "haedal-sui", shortKey: "haedal",
    aliases:   ["haedal", "haedal-sui", "haedal-protocol"],
    name:      "Haedal", chain: "sui", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "stake", "unstake", "deposit", "withdraw"],
    supportedTokens: ["SUI", "HASUI", "USDC", "USDT", "USDY", "NAVX"],
    homepage:  "https://www.haedal.xyz/",
    envPrefix: "ADAPTER_HAEDAL", defaultMode: "live",
  },
  {
    key: "cetus-sui", shortKey: "cetus",
    aliases:   ["cetus", "cetus-sui", "cetus-clmm", "cetus-zone"],
    name:      "Cetus", chain: "sui", category: "dex", status: "active",
    actions:   ["quote", "swap", "plan"],
    supportedTokens: ["SUI", "USDC", "USDT", "BUCK", "FDUSD", "USDY", "NAVX", "VSUI", "HASUI"],
    homepage:  "https://cetus.zone/",
    envPrefix: "ADAPTER_CETUS", defaultMode: "live",
  },
  {
    key: "lisa-stacks", shortKey: "lisa",
    aliases:   ["lisa", "lisa-stacks", "lisalab", "lisa-lab", "listx", "vlistx"],
    name:      "LISA", chain: "stacks", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stack", "unstack"],
    supportedTokens: ["SBTC", "STX", "USDCX", "USDH", "USDA"],
    homepage:  "https://www.lisalab.io/",
    envPrefix: "ADAPTER_LISA", defaultMode: "live",
  },
  {
    key: "stackingdao-stacks", shortKey: "stackingdao",
    aliases:   ["stackingdao", "stacking-dao", "stackingdao-stacks", "sdao"],
    name:      "StackingDAO", chain: "stacks", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stack", "unstack"],
    supportedTokens: ["SBTC", "STX", "USDCX", "USDH", "USDA"],
    homepage:  "https://stackingdao.com/",
    envPrefix: "ADAPTER_STACKINGDAO", defaultMode: "live",
  },
  {
    key: "alex-stacks", shortKey: "alex",
    aliases:   ["alex", "alex-stacks", "alex-dex", "alex-lab", "alexlab"],
    name:      "ALEX", chain: "stacks", category: "dex", status: "active",
    actions:   ["quote", "swap", "plan", "bridge"],
    supportedTokens: ["SBTC", "STX", "USDCX", "USDH", "USDA"],
    homepage:  "https://app.alexlab.co/",
    envPrefix: "ADAPTER_ALEX", defaultMode: "live",
  },
  {
    key: "velar-stacks", shortKey: "velar",
    aliases:   ["velar", "velar-stacks", "velar-vault", "velar-protocol"],
    name:      "Velar (Stacks vaults)", chain: "stacks", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["SBTC", "STX", "USDCX", "USDH", "USDA"],
    homepage:  "https://www.velar.co/",
    envPrefix: "ADAPTER_VELAR", defaultMode: "live",
  },
  {
    key: "arkadiko-stacks", shortKey: "arkadiko",
    aliases:   ["arkadiko", "arkadiko-stacks", "diko", "arkadiko-vault"],
    name:      "Arkadiko (Stacks)", chain: "stacks", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw"],
    supportedTokens: ["SBTC", "STX", "USDCX", "USDH", "USDA"],
    homepage:  "https://arkadiko.finance/",
    envPrefix: "ADAPTER_ARKADIKO", defaultMode: "live",
  },
  {
    key: "hyperliquid-vaults", shortKey: "hyperliquid",
    aliases:   ["hyperliquid", "hl", "hyperliquid-l1", "hype-vault", "hyperliquid-vault"],
    name:      "Hyperliquid L1 vaults", chain: "hyperliquid", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["USDC", "USDH", "USDT", "USDe", "BOLD"],
    homepage:  "https://hyperliquid.xyz/",
    envPrefix: "ADAPTER_HYPERLIQUID", defaultMode: "live",
  },
  // ─── Ethereum liquid staking / restaking ───────────────────────────────────
  {
    key: "lido-ethereum", shortKey: "lido",
    aliases:   ["lido", "lido-ethereum", "steth", "stakehouse"],
    name:      "Lido", chain: "ethereum", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake", "unstake"],
    supportedTokens: ["ETH"],
    homepage:  "https://lido.fi/",
    envPrefix: "ADAPTER_LIDO", defaultMode: "live",
  },
  {
    key: "binance-staked-eth", shortKey: "beth",
    aliases:   ["beth", "binance-staked-eth", "wbeth", "binance-eth"],
    name:      "Binance Staked ETH", chain: "ethereum", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake", "unstake"],
    supportedTokens: ["ETH"],
    homepage:  "https://www.binance.com/en/staking",
    envPrefix: "ADAPTER_BETH", defaultMode: "live",
  },
  {
    key: "rocketpool-ethereum", shortKey: "rocketpool",
    aliases:   ["rocketpool", "rocket-pool", "reth", "rpl"],
    name:      "Rocket Pool", chain: "ethereum", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake", "unstake"],
    supportedTokens: ["ETH"],
    homepage:  "https://rocketpool.net/",
    envPrefix: "ADAPTER_ROCKETPOOL", defaultMode: "live",
  },
  {
    key: "mantle-staked-eth", shortKey: "mantle",
    aliases:   ["mantle", "mantle-staked-eth", "meth", "mnt", "cmeth", "cm-eth", "canonical-meth"],
    name:      "Mantle Staked Ether (mETH / cmETH)", chain: "mantle", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake", "unstake"],
    supportedTokens: ["MNT", "mETH", "cmETH", "AUSD", "USDC", "USDT0", "BTC", "FBTC"],
    homepage:  "https://www.mantle.xyz/",
    envPrefix: "ADAPTER_MANTLE", defaultMode: "live",
  },
  {
    key: "frax-eth", shortKey: "fraxeth",
    aliases:   ["fraxeth", "frax-eth", "frxeth", "frax-staking"],
    name:      "Frax ETH", chain: "ethereum", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake", "unstake"],
    supportedTokens: ["ETH"],
    homepage:  "https://fraxether.com/",
    envPrefix: "ADAPTER_FRAXETH", defaultMode: "live",
  },
  {
    key: "swell-ethereum", shortKey: "swell",
    aliases:   ["swell", "swell-ethereum", "sweth", "swell-restaking"],
    name:      "Swell", chain: "ethereum", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake", "restake"],
    supportedTokens: ["ETH"],
    homepage:  "https://www.swellnetwork.io/",
    envPrefix: "ADAPTER_SWELL", defaultMode: "live",
  },
  {
    key: "renzo-ethereum", shortKey: "renzo",
    aliases:   ["renzo", "renzo-ethereum", "ezeth", "eigenlayer", "restaking"],
    name:      "Renzo", chain: "ethereum", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "restake", "unstake"],
    supportedTokens: ["ETH"],
    homepage:  "https://www.renzoprotocol.com/",
    envPrefix: "ADAPTER_RENZO", defaultMode: "live",
  },
  {
    key: "etherfi-ethereum", shortKey: "etherfi",
    aliases:   ["etherfi", "ether-fi", "eeth", "liquid-restaking"],
    name:      "ether.fi", chain: "ethereum", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "restake", "unstake"],
    supportedTokens: ["ETH"],
    homepage:  "https://ether.fi/",
    envPrefix: "ADAPTER_ETHERFI", defaultMode: "live",
  },
  // ─── Vaults & yield protocols ──────────────────────────────────────────────
  {
    key: "vesu-starknet", shortKey: "vesu",
    aliases:   ["vesu", "vesu-starknet", "vesu-vault"],
    name:      "Vesu", chain: "starknet", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["STRK", "ETH", "BTC", "USDC", "LUSD"],
    homepage:  "https://vesu.xyz/",
    envPrefix: "ADAPTER_VESU", defaultMode: "live",
  },
  {
    key: "metapool-near", shortKey: "metapool",
    aliases:   ["metapool", "metapool-near", "meta-pool", "stnear"],
    name:      "Meta Pool", chain: "near", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake", "unstake"],
    supportedTokens: ["NEAR"],
    homepage:  "https://metapool.app/",
    envPrefix: "ADAPTER_METAPOOL", defaultMode: "live",
  },
  {
    key: "linear-near", shortKey: "linear",
    aliases:   ["linear", "linear-near", "linear-protocol", "linearprotocol", "lnear", "linearnear"],
    name:      "LiNEAR Protocol", chain: "near", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake", "unstake"],
    supportedTokens: ["NEAR"],
    homepage:  "https://app.linearprotocol.org/",
    envPrefix: "ADAPTER_LINEAR", defaultMode: "live",
  },
  {
    key: "usual-evm", shortKey: "usual",
    aliases:   ["usual", "usual-protocol", "usd0", "busd0", "usual-labs"],
    name:      "Usual", chain: "evm", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "swap", "stake"],
    supportedTokens: ["USDC", "EURC", "GHO", "ETH", "USDbC", "USDT", "BNB", "USDT0", "DAI", "AUSD", "USDe", "AVAX", "POL"],
    homepage:  "https://usual.money/",
    envPrefix: "ADAPTER_USUAL", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
    primaryCaip2: "eip155:1",
  },
  {
    key: "ethena-ethereum", shortKey: "ethena",
    aliases:   ["ethena", "ethena-ethereum", "usde", "susde", "usd-tb"],
    name:      "Ethena", chain: "ethereum", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "mint", "stake"],
    supportedTokens: ["USDe", "USDC", "USDT0", "ETH"],
    homepage:  "https://ethena.fi/",
    envPrefix: "ADAPTER_ETHENA", defaultMode: "live",
  },
  {
    key: "curve-multi", shortKey: "curve",
    aliases:   ["curve", "curve-finance", "curve-multi", "curve-fi"],
    name:      "Curve", chain: "multi", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "swap", "stake"],
    supportedTokens: ["USDC", "USDe", "GHO", "USDT0", "AUSD"],
    homepage:  "https://www.curve.finance/",
    envPrefix: "ADAPTER_CURVE", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
  },
  {
    key: "bedrock-multi", shortKey: "bedrock",
    aliases:   ["bedrock", "bedrock-technology", "uneth", "brbtc", "unibtc", "uniiotx", "merlin", "merlin-chain", "merlin-btc"],
    name:      "Bedrock", chain: "multi", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake", "restake"],
    supportedTokens: ["BTC", "FBTC", "ETH"],
    homepage:  "https://www.bedrock.technology/",
    envPrefix: "ADAPTER_BEDROCK", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
  },
  {
    key: "bitlayer-btcfi", shortKey: "bitlayer",
    aliases:   ["bitlayer", "bitlayer-btcfi", "bitlayer-vault", "ybtc", "ybtc.b"],
    name:      "Bitlayer BTCFi", chain: "bitlayer", category: "btcfi", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["BTC", "YBTC.B"],
    homepage:  "https://bitvmbridge.bitlayer.org/btcfi",
    envPrefix: "ADAPTER_BITLAYER", defaultMode: "live",
  },
  {
    key: "bob-btcfi", shortKey: "bob",
    aliases:   ["bob", "bob-network", "bob-btc-l2", "bob-gateway", "bob-earn"],
    name:      "BOB (Build on Bitcoin)", chain: "bob", category: "btcfi", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["BTC", "ETH"],
    homepage:  "https://docs.gobob.xyz/gateway",
    envPrefix: "ADAPTER_BOB", defaultMode: "live",
  },
  {
    key: "citrea-btcfi", shortKey: "citrea",
    aliases:   ["citrea", "citrea-btc-l2", "ctusd"],
    name:      "Citrea", chain: "citrea", category: "btcfi", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["BTC", "CTUSD"],
    homepage:  "https://citrea.xyz/",
    envPrefix: "ADAPTER_CITREA", defaultMode: "live",
  },
  {
    key: "bouncebit-btc", shortKey: "bouncebit",
    aliases:   ["bouncebit", "bounce-bit", "bbtc", "btcb", "cedefi"],
    name:      "BounceBit", chain: "bouncebit", category: "btcfi", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["BTC", "USDT", "ETH"],
    homepage:  "https://bouncebit.io/",
    envPrefix: "ADAPTER_BOUNCEBIT", defaultMode: "live",
  },
  {
    key: "rootstock-btcfi", shortKey: "rootstock",
    aliases:   ["rootstock", "rsk", "rootstock-btc", "sovryn-rbtc"],
    name:      "Rootstock (Bitcoin sidechain)", chain: "rootstock", category: "btcfi", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["BTC", "DLLR", "MOC", "RUSDT", "XUSD"],
    homepage:  "https://rootstock.io/",
    envPrefix: "ADAPTER_ROOTSTOCK", defaultMode: "live",
  },
  {
    key: "sovryn-rootstock", shortKey: "sovryn",
    aliases:   ["sovryn", "sovryn-rsk", "sovryn-rootstock", "sovryn-dex"],
    name:      "Sovryn", chain: "rootstock", category: "dex", status: "active",
    actions:   ["quote", "plan", "swap", "supply", "borrow", "deposit", "withdraw"],
    supportedTokens: ["BTC", "DLLR", "MOC", "RUSDT", "XUSD"],
    homepage:  "https://sovryn.app/",
    envPrefix: "ADAPTER_SOVRYN", defaultMode: "live",
  },
  {
    key: "yearn-ethereum", shortKey: "yearn",
    aliases:   ["yearn", "yearn-finance", "yearn-fi", "yvault"],
    name:      "Yearn", chain: "ethereum", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["ETH", "USDC", "DAI"],
    homepage:  "https://yearn.fi/",
    envPrefix: "ADAPTER_YEARN", defaultMode: "live",
  },
  {
    key: "firelight-flare", shortKey: "firelight",
    aliases:   ["firelight", "firelight-flare", "stxrp", "firelight-finance"],
    name:      "Firelight", chain: "flare", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "stake", "unstake", "deposit", "withdraw"],
    supportedTokens: ["RLUSD", "USDC", "XRP"],
    homepage:  "https://firelight.finance/",
    envPrefix: "ADAPTER_FIRELIGHT", defaultMode: "live",
  },
  {
    key: "earnxrp-flare", shortKey: "earnxrp",
    aliases:   ["earnxrp", "earnxrp-flare", "earn-xrp", "earnxrp-vault"],
    name:      "earnXRP Vault", chain: "flare", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["RLUSD", "USDC", "XRP"],
    homepage:  "https://xrpfi.flare.network/",
    envPrefix: "ADAPTER_EARNXRP", defaultMode: "live",
  },
  {
    key: "morpho-flare", shortKey: "morphoflare",
    aliases:   ["morphoflare", "morpho-flare", "morpho-flare-lending"],
    name:      "Morpho Lending (Flare)", chain: "flare", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw", "repay"],
    supportedTokens: ["RLUSD", "USDC", "XRP"],
    homepage:  "https://flare.network/news/first-modular-xrp-lending-debuts-on-flare-via-morpho-and-mystic",
    envPrefix: "ADAPTER_MORPHO_FLARE", defaultMode: "live",
  },
  // ── BNB/BSC adapters ─────────────────────────────────────────────────────
  {
    key: "venus-bsc", shortKey: "venus",
    aliases:   ["venus", "venus-bsc", "venus-protocol", "venusprotocol", "vbnb"],
    name:      "Venus Protocol", chain: "bsc", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw", "repay"],
    supportedTokens: ["BNB", "USDT", "USDC", "BUSD", "ETH", "BTC"],
    homepage:  "https://app.venus.io/",
    envPrefix: "ADAPTER_VENUS", defaultMode: "live",
  },
  {
    key: "pancakeswap-bsc", shortKey: "pancakeswap",
    aliases:   ["pancakeswap", "pancakeswap-bsc", "pancake", "cake", "pancake-v3"],
    name:      "PancakeSwap", chain: "bsc", category: "dex", status: "active",
    actions:   ["quote", "plan", "swap", "deposit", "withdraw"],
    supportedTokens: ["BNB", "USDT", "USDC", "BUSD", "CAKE", "ETH", "BTC"],
    homepage:  "https://pancakeswap.finance/",
    envPrefix: "ADAPTER_PANCAKESWAP", defaultMode: "live",
  },
  // ── Native XRPL adapters ─────────────────────────────────────────────────
  {
    key: "sologenic-xrp", shortKey: "sologenic",
    aliases:   ["sologenic", "sologenic-xrp", "solo-dex", "xrpl-dex", "solodex"],
    name:      "Sologenic DEX", chain: "xrp", category: "dex", status: "active",
    actions:   ["quote", "plan", "swap", "deposit", "withdraw"],
    supportedTokens: ["XRP", "RLUSD", "USDC", "SOLO"],
    homepage:  "https://sologenic.org/",
    envPrefix: "ADAPTER_SOLOGENIC", defaultMode: "live",
  },
  {
    key: "xrpl-amm", shortKey: "xrplamm",
    aliases:   ["xrplamm", "xrpl-amm", "xrpl-native-amm", "xrpl-liquidity"],
    name:      "XRPL Native AMM", chain: "xrp", category: "dex", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["XRP", "RLUSD", "USDC"],
    homepage:  "https://xrpl.org/docs/concepts/tokens/decentralized-exchange/automated-market-makers",
    envPrefix: "ADAPTER_XRPL_AMM", defaultMode: "live",
  },
  {
    key: "beefy-multi", shortKey: "beefy",
    aliases:   ["beefy", "beefy-finance", "beefy-multi", "bifi"],
    name:      "Beefy Finance", chain: "multi", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["ETH", "USDC"],
    homepage:  "https://beefy.com/",
    envPrefix: "ADAPTER_BEEFY", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
  },
  {
    key: "convex-ethereum", shortKey: "convex",
    aliases:   ["convex", "convex-finance", "convex-ethereum", "cvx"],
    name:      "Convex Finance", chain: "ethereum", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake"],
    supportedTokens: ["ETH", "USDC"],
    homepage:  "https://www.convexfinance.com/",
    envPrefix: "ADAPTER_CONVEX", defaultMode: "live",
  },
  {
    key: "compound-v3-evm", shortKey: "compoundv3",
    aliases:   ["compoundv3", "compound-v3", "compound3", "cusp"],
    name:      "Compound v3", chain: "evm", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw", "repay"],
    supportedTokens: ["USDC", "USDe", "USDT0", "ETH"],
    homepage:  "https://compound.finance/",
    envPrefix: "ADAPTER_COMPOUNDV3", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
    primaryCaip2: "eip155:1",
  },
  {
    key: "pendle-multi", shortKey: "pendle",
    aliases:   ["pendle", "pendle-finance", "pendle-multi", "pt"],
    name:      "Pendle", chain: "multi", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "mint"],
    supportedTokens: ["USDe", "USDC", "USDT0", "mETH", "cmETH"],
    homepage:  "https://www.pendle.finance/",
    envPrefix: "ADAPTER_PENDLE", defaultMode: "live",
    networks: [...CORE_EVM_NETWORK_DEFS],
  },
  {
    key: "marinade-solana", shortKey: "marinade",
    aliases:   ["marinade", "marinade-solana", "msol", "marinade-finance"],
    name:      "Marinade", chain: "solana", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "stake", "unstake", "deposit", "withdraw"],
    supportedTokens: ["SOL", "USDC", "USDT"],
    homepage:  "https://marinade.finance/",
    envPrefix: "ADAPTER_MARINADE", defaultMode: "live",
  },
  {
    key: "jito-solana", shortKey: "jito",
    aliases:   ["jito", "jito-solana", "jitosol", "jito-finance"],
    name:      "Jito", chain: "solana", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "stake", "unstake", "deposit", "withdraw"],
    supportedTokens: ["SOL", "USDC", "USDT"],
    homepage:  "https://www.jito.network/",
    envPrefix: "ADAPTER_JITO", defaultMode: "live",
  },
  {
    key: "benqi-avalanche", shortKey: "benqi",
    aliases:   ["benqi", "benqi-avalanche", "benqi-protocol", "qi"],
    name:      "Benqi", chain: "avalanche", category: "lending", status: "active",
    actions:   ["quote", "plan", "supply", "borrow", "withdraw", "repay"],
    supportedTokens: ["AVAX", "USDC", "USDT"],
    homepage:  "https://benqi.fi/",
    envPrefix: "ADAPTER_BENQI", defaultMode: "live",
  },
  {
    key: "tonyield-ton", shortKey: "tonyield",
    aliases:   ["tonyield", "ton-yield", "tonyield-ton", "levelq"],
    name:      "TONYield", chain: "ton", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["USDC", "USDT"],
    homepage:  "https://tonyield.app/",
    envPrefix: "ADAPTER_TONYIELD", defaultMode: "live",
  },
  {
    key: "troves-starknet", shortKey: "troves",
    aliases:   ["troves", "troves-starknet", "evergreen-vaults"],
    name:      "Troves", chain: "starknet", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["STRK", "ETH", "BTC", "LUSD"],
    homepage:  "https://troves.xyz/",
    envPrefix: "ADAPTER_TROVES", defaultMode: "live",
  },
  {
    key: "injective-lending", shortKey: "injective",
    aliases:   ["injective", "injective-lending", "inj", "injective-defi", "x402-injective"],
    name:      "Injective", chain: "injective", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake"],
    supportedTokens: ["INJ", "USDT", "USDC", "USDe"],
    homepage:  "https://injective.com/",
    envPrefix: "ADAPTER_INJECTIVE", defaultMode: "live",
  },
  {
    key: "hydro-injective", shortKey: "hydro",
    aliases:   ["hydro", "hydro-injective", "hydro-protocol", "hydroprotocol"],
    name:      "Hydro Protocol", chain: "injective", category: "dex", status: "active",
    actions:   ["quote", "plan", "swap", "deposit", "withdraw"],
    supportedTokens: ["INJ", "USDT", "USDC", "USDe"],
    homepage:  "https://app.hydroprotocol.finance/",
    envPrefix: "ADAPTER_HYDRO", defaultMode: "live",
  },
  {
    key: "mito-injective", shortKey: "mito",
    aliases:   ["mito", "mito-injective", "mito-vaults", "mitofi"],
    name:      "Mito", chain: "injective", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw"],
    supportedTokens: ["INJ", "USDT", "USDC", "USDe"],
    homepage:  "https://mito.fi/vaults/",
    envPrefix: "ADAPTER_MITO", defaultMode: "live",
  },
  {
    key: "helix-injective", shortKey: "helix",
    aliases:   ["helix", "helix-injective", "helixapp", "helix-dex"],
    name:      "Helix", chain: "injective", category: "dex", status: "active",
    actions:   ["quote", "plan", "swap"],
    supportedTokens: ["INJ", "USDT", "USDC", "USDe"],
    homepage:  "https://helixapp.com/",
    envPrefix: "ADAPTER_HELIX", defaultMode: "live",
  },
  {
    key: "osmosis-cosmos", shortKey: "osmosis",
    aliases:   ["osmosis", "osmosis-cosmos", "osmo", "osmosis-zone"],
    name:      "Osmosis", chain: "osmosis", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "stake", "lp"],
    supportedTokens: ["ATOM", "USDC"],
    homepage:  "https://osmosis.zone/",
    envPrefix: "ADAPTER_OSMOSIS", defaultMode: "live",
  },
  {
    key: "rubicon-sei", shortKey: "rubicon",
    aliases:   ["rubicon", "rubicon-sei", "rubicon-protocol"],
    name:      "Rubicon", chain: "sei", category: "vault", status: "active",
    actions:   ["quote", "plan", "deposit", "withdraw", "swap"],
    supportedTokens: ["USDC", "FRXUSD", "USDT0", "SEI"],
    homepage:  "https://rubicon.finance/",
    envPrefix: "ADAPTER_RUBICON", defaultMode: "live",
  },
  {
    key: "amnis-aptos", shortKey: "amnis",
    aliases:   ["amnis", "amnis-aptos", "amnis-finance", "amapt"],
    name:      "Amnis Finance", chain: "aptos", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "stake", "unstake", "deposit", "withdraw"],
    supportedTokens: ["APT"],
    homepage:  "https://amnis.finance/",
    envPrefix: "ADAPTER_AMNIS", defaultMode: "live",
  },
  {
    key: "stride-cosmos", shortKey: "stride",
    aliases:   ["stride", "stride-cosmos", "stride-labs", "stratom", "stosmo"],
    name:      "Stride", chain: "cosmos", category: "liquid-staking", status: "active",
    actions:   ["quote", "plan", "stake", "unstake", "liquid-stake"],
    supportedTokens: ["ATOM"],
    homepage:  "https://stride.zone/",
    envPrefix: "ADAPTER_STRIDE", defaultMode: "live",
  },
  {
    key: "eigenlayer-ethereum", shortKey: "eigenlayer",
    aliases:   ["eigenlayer", "eigenlayer-ethereum", "eigen-layer", "restaking"],
    name:      "EigenLayer", chain: "ethereum", category: "restaking", status: "active",
    actions:   ["quote", "plan", "restake", "withdraw", "delegate"],
    supportedTokens: ["ETH"],
    homepage:  "https://eigenlayer.xyz/",
    envPrefix: "ADAPTER_EIGENLAYER", defaultMode: "live",
  },
];

// Build alias → canonical key lookup map
const ALIAS_TO_KEY = (() => {
  const m = new Map();
  for (const d of ADAPTER_DEFS) {
    m.set(d.key, d.key);
    m.set(d.shortKey, d.key);
    for (const a of d.aliases || []) m.set(a, d.key);
  }
  return m;
})();

/** Slim rows for nested "by network" views — keeps GET /api/adapters payloads readable. */
function summarizeAdapterForNetworkGroup(a, bucketSlug) {
  const slugNorm = bucketSlug != null
    ? normalizeNetworkSlug(bucketSlug)
    : normalizeNetworkSlug(a.chain);
  const slug = slugNorm || String(a.chain || "unknown").toLowerCase();
  let caip2 = null;
  if (a.networks?.length && bucketSlug != null) {
    const want = normalizeNetworkSlug(bucketSlug);
    const hit = a.networks.find((n) => normalizeNetworkSlug(n.slug) === want);
    caip2 = hit?.caip2 ?? null;
  }
  return {
    key: a.key,
    shortKey: a.shortKey,
    name: a.name,
    category: a.category,
    chain: a.chain,
    networkSlug: slug,
    intentBase: getIntentBaseForSlug(slug),
    ...(caip2 ? { caip2 } : {}),
    enabled: a.enabled,
    executionState: a.executionState,
    detail: `/api/adapters/${a.shortKey}`,
  };
}

function groupAdaptersByNetwork(adapters) {
  const byNetwork = {};
  for (const a of adapters) {
    if (a.networks?.length) {
      for (const n of a.networks) {
        const slug = normalizeNetworkSlug(n.slug) || String(n.slug || "").toLowerCase();
        if (!slug) continue;
        if (!byNetwork[slug]) byNetwork[slug] = [];
        byNetwork[slug].push(summarizeAdapterForNetworkGroup(a, slug));
      }
    } else {
      const net = normalizeNetworkSlug(a.chain) || String(a.chain || "unknown").toLowerCase();
      if (!byNetwork[net]) byNetwork[net] = [];
      byNetwork[net].push(summarizeAdapterForNetworkGroup(a, net));
    }
  }
  const chains = Object.keys(byNetwork).sort((x, y) => {
    const cx = byNetwork[x].length;
    const cy = byNetwork[y].length;
    if (cy !== cx) return cy - cx;
    return x.localeCompare(y);
  });
  return { byNetwork, chains, chainCount: chains.length };
}

// Optional discovery metadata: apyRangeMin/Max (%), minAmount (USD or unit). Used by GET /api/adapters/discover.
const DISCOVERY_META = {
  // ── Existing ──────────────────────────────────────────────────────────────
  "rhea-near":           { apyRangeMin: 6,  apyRangeMax: 12,  minAmount: 1 },
  "babylon-btc":         { apyRangeMin: 3,  apyRangeMax: 6,   minAmount: 100 },
  "lido-ethereum":       { apyRangeMin: 3,  apyRangeMax: 4,   minAmount: 0.01 },
  "rocketpool-ethereum": { apyRangeMin: 3,  apyRangeMax: 4,   minAmount: 0.01 },
  "marinade-solana":     { apyRangeMin: 5,  apyRangeMax: 8,   minAmount: 0.1 },
  "jito-solana":         { apyRangeMin: 5,  apyRangeMax: 8,   minAmount: 0.1 },
  "glif-filecoin":       { apyRangeMin: 8,  apyRangeMax: 15,  minAmount: 1 },
  "amnis-aptos":         { apyRangeMin: 6,  apyRangeMax: 9,   minAmount: 1 },
  "stride-cosmos":       { apyRangeMin: 8,  apyRangeMax: 14,  minAmount: 1 },
  "eigenlayer-ethereum": { apyRangeMin: 4,  apyRangeMax: 12,  minAmount: 0.01 },
  // ── Stacks / BTCFi ────────────────────────────────────────────────────────
  "zest-stacks":         { apyRangeMin: 7,  apyRangeMax: 14,  minAmount: 0.001 },
  "hermetica-stacks":    { apyRangeMin: 8,  apyRangeMax: 18,  minAmount: 0.001 },
  "lisa-stacks":         { apyRangeMin: 5,  apyRangeMax: 9,   minAmount: 1 },
  "stackingdao-stacks":  { apyRangeMin: 6,  apyRangeMax: 10,  minAmount: 1 },
  "alex-stacks":         { apyRangeMin: 8,  apyRangeMax: 22,  minAmount: 1 },
  "velar-stacks":        { apyRangeMin: 4,  apyRangeMax: 14,  minAmount: 0.001 },
  "arkadiko-stacks":     { apyRangeMin: 3,  apyRangeMax: 12,  minAmount: 0.001 },
  "hyperliquid-vaults":  { apyRangeMin: 1,  apyRangeMax: 20,  minAmount: 0.001 },
  // ── EVM Lending ───────────────────────────────────────────────────────────
  "aave-evm":            { apyRangeMin: 3,  apyRangeMax: 8,   minAmount: 10 },
  "euler-evm":           { apyRangeMin: 4,  apyRangeMax: 10,  minAmount: 10 },
  "silo-evm":            { apyRangeMin: 4,  apyRangeMax: 12,  minAmount: 10 },
  "compound-v3-evm":     { apyRangeMin: 3,  apyRangeMax: 7,   minAmount: 10 },
  "morpho-flare":        { apyRangeMin: 4,  apyRangeMax: 9,   minAmount: 10 },
  "benqi-avalanche":     { apyRangeMin: 3,  apyRangeMax: 8,   minAmount: 10 },
  "kamino-solana":       { apyRangeMin: 5,  apyRangeMax: 12,  minAmount: 1 },
  "secured-filecoin":    { apyRangeMin: 4,  apyRangeMax: 9,   minAmount: 10 },
  "secured-axelar":      { apyRangeMin: 0,  apyRangeMax: 0,   minAmount: 1 },
  "justlend-tron":       { apyRangeMin: 3,  apyRangeMax: 7,   minAmount: 100 },
  "navi-sui":            { apyRangeMin: 4,  apyRangeMax: 10,  minAmount: 1 },
  "scallop-sui":         { apyRangeMin: 4,  apyRangeMax: 11,  minAmount: 1 },
  "suilend-sui":         { apyRangeMin: 4,  apyRangeMax: 10,  minAmount: 1 },
  "volo-sui":            { apyRangeMin: 3,  apyRangeMax: 8,   minAmount: 1 },
  "haedal-sui":          { apyRangeMin: 3,  apyRangeMax: 8,   minAmount: 1 },
  "cetus-sui":           { apyRangeMin: 0,  apyRangeMax: 0,   minAmount: 1 },
  // ── EVM Vaults / Yield ────────────────────────────────────────────────────
  "lombard-base":        { apyRangeMin: 4,  apyRangeMax: 8,   minAmount: 0.001 },
  "solv-multi":          { apyRangeMin: 5,  apyRangeMax: 10,  minAmount: 0.001 },
  "katana-evm":          { apyRangeMin: 6,  apyRangeMax: 14,  minAmount: 10 },
  "thevault-evm":        { apyRangeMin: 5,  apyRangeMax: 12,  minAmount: 10 },
  "yearn-ethereum":      { apyRangeMin: 4,  apyRangeMax: 15,  minAmount: 10 },
  "convex-ethereum":     { apyRangeMin: 5,  apyRangeMax: 18,  minAmount: 10 },
  "curve-multi":         { apyRangeMin: 4,  apyRangeMax: 12,  minAmount: 10 },
  "pendle-multi":        { apyRangeMin: 6,  apyRangeMax: 20,  minAmount: 10 },
  "beefy-multi":         { apyRangeMin: 5,  apyRangeMax: 25,  minAmount: 1 },
  "bedrock-multi":       { apyRangeMin: 5,  apyRangeMax: 15,  minAmount: 0.01 },
  "ethena-ethereum":     { apyRangeMin: 8,  apyRangeMax: 20,  minAmount: 10 },
  "usual-evm":           { apyRangeMin: 6,  apyRangeMax: 14,  minAmount: 10 },
  "clovis-sei":          { apyRangeMin: 5,  apyRangeMax: 12,  minAmount: 1 },
  "yei-sei":             { apyRangeMin: 4,  apyRangeMax: 11,  minAmount: 1 },
  "rubicon-sei":         { apyRangeMin: 4,  apyRangeMax: 10,  minAmount: 1 },
  // ── Liquid Staking ────────────────────────────────────────────────────────
  "binance-staked-eth":  { apyRangeMin: 3,  apyRangeMax: 4,   minAmount: 0.01 },
  "mantle-staked-eth":   { apyRangeMin: 3,  apyRangeMax: 5,   minAmount: 0.01 },
  "frax-eth":            { apyRangeMin: 3,  apyRangeMax: 5,   minAmount: 0.01 },
  "swell-ethereum":      { apyRangeMin: 3,  apyRangeMax: 5,   minAmount: 0.01 },
  "renzo-ethereum":      { apyRangeMin: 4,  apyRangeMax: 8,   minAmount: 0.01 },
  "etherfi-ethereum":    { apyRangeMin: 4,  apyRangeMax: 8,   minAmount: 0.01 },
  "metapool-near":       { apyRangeMin: 3,  apyRangeMax: 11,  minAmount: 1 },
  "linear-near":         { apyRangeMin: 3,  apyRangeMax: 11,  minAmount: 1 },
  "firelight-flare":     { apyRangeMin: 6,  apyRangeMax: 12,  minAmount: 1 },
  // ── Starknet ──────────────────────────────────────────────────────────────
  "endur-starknet":      { apyRangeMin: 4,  apyRangeMax: 9,   minAmount: 0.001 },
  "vesu-starknet":       { apyRangeMin: 4,  apyRangeMax: 10,  minAmount: 0.001 },
  "troves-starknet":     { apyRangeMin: 5,  apyRangeMax: 12,  minAmount: 0.001 },
  // ── Multi-chain / Other ───────────────────────────────────────────────────
  "sunswap-tron":        { apyRangeMin: 5,  apyRangeMax: 18,  minAmount: 100 },
  "venus-bsc":           { apyRangeMin: 3,  apyRangeMax: 10,  minAmount: 10 },
  "pancakeswap-bsc":     { apyRangeMin: 5,  apyRangeMax: 20,  minAmount: 10 },
  "sologenic-xrp":       { apyRangeMin: 5,  apyRangeMax: 15,  minAmount: 10 },
  "xrpl-amm":            { apyRangeMin: 3,  apyRangeMax: 12,  minAmount: 10 },
  "earnxrp-flare":       { apyRangeMin: 4,  apyRangeMax: 9,   minAmount: 10 },
  "tonyield-ton":        { apyRangeMin: 6,  apyRangeMax: 14,  minAmount: 1 },
  "osmosis-cosmos":      { apyRangeMin: 8,  apyRangeMax: 20,  minAmount: 1 },
  "injective-lending":   { apyRangeMin: 2,  apyRangeMax: 12,  minAmount: 1 },
  "hydro-injective":     { apyRangeMin: 2,  apyRangeMax: 10,  minAmount: 1 },
  "mito-injective":      { apyRangeMin: 3,  apyRangeMax: 12,  minAmount: 1 },
  "helix-injective":     { apyRangeMin: 1,  apyRangeMax: 15,  minAmount: 1 },
  "bitlayer-btcfi":      { apyRangeMin: 1,  apyRangeMax: 8,   minAmount: 0.001 },
  "bob-btcfi":           { apyRangeMin: 2,  apyRangeMax: 12,  minAmount: 0.001 },
  "citrea-btcfi":        { apyRangeMin: 2,  apyRangeMax: 8,   minAmount: 0.001 },
  "bouncebit-btc":       { apyRangeMin: 1,  apyRangeMax: 5,   minAmount: 0.001 },
  "rootstock-btcfi":     { apyRangeMin: 1,  apyRangeMax: 8,   minAmount: 0.001 },
  "sovryn-rootstock":    { apyRangeMin: 2,  apyRangeMax: 15,  minAmount: 0.001 },
  "jupiter-solana":      { apyRangeMin: 6,  apyRangeMax: 18,  minAmount: 1 },
  "allbridge-multi":     { apyRangeMin: 0,  apyRangeMax: 0,   minAmount: 1 },
  "openocean-evm":       { apyRangeMin: 0,  apyRangeMax: 0,   minAmount: 10 },
  "rubic-multi":         { apyRangeMin: 0,  apyRangeMax: 0,   minAmount: 10 },
  "bitcoinos-bitcoin":   { apyRangeMin: 3,  apyRangeMax: 7,   minAmount: 0.001 },
  "charms-bitcoin":      { apyRangeMin: 0,  apyRangeMax: 0,   minAmount: 0.0001 },
  "layerzero-multi":     { apyRangeMin: 0,  apyRangeMax: 0,   minAmount: 1 },
};

export function normalizeAdapterKey(input) {
  const check = validateAdapterKey(input);
  if (!check.valid) return null;
  const k = check.key;
  return ALIAS_TO_KEY.get(k) || k;
}

// ============================================================================
// Registry
// ============================================================================

// [G11] Merge KV-stored adapter overrides with built-in ADAPTER_DEFS.
// Admin writes: KV key "adapter_overrides" → JSON array of adapter defs.
// Schema must match ADAPTER_DEFS entries. KV overrides take priority by key.
let _kvAdaptersCache = null;
let _kvAdaptersCacheTs = 0;
const KV_ADAPTERS_TTL_MS = 5 * 60 * 1000;

async function getEffectiveAdapterDefs(env) {
  const defs = [...ADAPTER_DEFS];
  if (!env.ADAPTER_KV) return defs;
  if (_kvAdaptersCache && (Date.now() - _kvAdaptersCacheTs) < KV_ADAPTERS_TTL_MS) {
    return mergeAdapterDefs(defs, _kvAdaptersCache);
  }
  try {
    const raw = await env.ADAPTER_KV.get("adapter_overrides");
    if (raw) {
      const overrides = JSON.parse(raw);
      if (Array.isArray(overrides)) {
        _kvAdaptersCache = overrides;
        _kvAdaptersCacheTs = Date.now();
        return mergeAdapterDefs(defs, overrides);
      }
    }
  } catch { /* KV unavailable — use built-in defs */ }
  return defs;
}

function mergeAdapterDefs(builtIn, overrides) {
  const merged = [...builtIn];
  for (const o of overrides) {
    if (!o.key) continue;
    const idx = merged.findIndex(d => d.key === o.key);
    if (idx >= 0) merged[idx] = { ...merged[idx], ...o };
    else merged.push(o);
  }
  return merged;
}

export function createAdapterRegistry(env) {
  let _effectiveDefs = null;
  async function defs() {
    if (!_effectiveDefs) _effectiveDefs = await getEffectiveAdapterDefs(env);
    return _effectiveDefs;
  }
  return {
    async list() { return (await defs()).map((d) => materializeAdapter(d, env)); },
    async get(keyOrAlias) {
      const key = normalizeAdapterKey(keyOrAlias);
      const all = await defs();
      const def = all.find((d) => d.key === key);
      return def ? materializeAdapter(def, env) : null;
    },
    async resolve(k) { return this.get(k); },
    async has(k)     { return !!(await this.get(k)); },
  };
}

// ============================================================================
// /api/adapters/* route handler
// [FIX-A1] No CORS headers — gateway withCors() handles it
// ============================================================================

export function handleTokensApi(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/tokens") return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "GET") return new Response(JSON.stringify({ success: false, error: "Method Not Allowed" }), { status: 405, headers: { "content-type": "application/json" } });
  const tokens = Object.values(TOKEN_REGISTRY).map((t) => ({ ...t }));
  return new Response(JSON.stringify({ success: true, tokens, total: tokens.length, timestamp: new Date().toISOString() }, null, 2), {
    status: 200, headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function adapterRegistryKeyFingerprint(adapters) {
  const keys = [...new Set(adapters.map((a) => String(a.key || "")))].filter(Boolean).sort().join("\n");
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(keys));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleAdaptersApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/adapters")) return null;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const registry = createAdapterRegistry(env);
  const path     = url.pathname.replace(/^\/api\/adapters/, "") || "/";

  try {
    // GET /api/adapters
    // Optional: ?groupBy=chain — same flat `adapters` plus `byNetwork` + `networks` (sorted chain keys)
    if (path === "/" && request.method === "GET") {
      const adapters = await registry.list();
      const groupBy = url.searchParams.get("groupBy")?.toLowerCase().trim();
      const grouped = groupBy === "chain" || groupBy === "network" ? groupAdaptersByNetwork(adapters) : null;
      return json({
        success:  true,
        adapters,
        ...(grouped
          ? {
              byNetwork: grouped.byNetwork,
              networks:  grouped.chains,
              networkSummary: {
                chainCount: grouped.chainCount,
                hint: "Grouping expands adapters with def.networks into each slug. GET /api/adapters/discover?chain=<slug> matches home chain or networks[]. Intent bases: network-registry INTENT_BASE_BY_NETWORK_SLUG; venues: ROUTING_VENUES (re-exported from intent-chain-routing).",
              },
            }
          : {}),
        aliases:  Object.fromEntries([...ALIAS_TO_KEY.entries()]),
        summary: {
          total:       adapters.length,
          enabled:     adapters.filter((a) => a.enabled).length,
          liveReady:   adapters.filter((a) => a.executionState === "live-ready").length,
          simFallback: adapters.filter((a) => a.executionState === "sim-fallback").length,
          auto:        adapters.filter((a) => a.enabled && a.mode === "auto").length,
          sim:         adapters.filter((a) => a.enabled && a.mode === "sim").length,
          disabled:    adapters.filter((a) => !a.enabled).length,
        },
        routes: {
          health: "/api/adapters/health",
          discover: "/api/adapters/discover?chain=<network>",
          quote:  "/api/adapters/quote (POST)",
          plan:   "/api/adapters/plan (POST)",
          detail: "/api/adapters/:key",
          grouped: "/api/adapters?groupBy=chain",
        },
        timestamp: new Date().toISOString(),
      });
    }

    // GET /api/adapters/discover (public; filter by chain, category, minApy, maxApy, minAmount)
    if (path === "/discover" && request.method === "GET") {
      try {
        let adaptersDisc = await registry.list();
        const q = url.searchParams;
        const chainRaw = q.get("chain")?.trim() || null;
        const chain = chainRaw ? chainRaw.toLowerCase() : null;
        const category = q.get("category")?.toLowerCase().trim() || null;
        const minApy = q.has("minApy") ? Number(q.get("minApy")) : null;
        const maxApy = q.has("maxApy") ? Number(q.get("maxApy")) : null;
        const minAmount = q.has("minAmount") ? Number(q.get("minAmount")) : null;

        if (chain) {
          const want = normalizeNetworkSlug(chain);
          adaptersDisc = adaptersDisc.filter((a) => {
            const home = normalizeNetworkSlug(a.chain) === want;
            const onNet = a.networks?.some((n) => normalizeNetworkSlug(n.slug) === want);
            return home || onNet;
          });
        }

        const tokenFilter = q.get("token")?.trim() || null;

        let list = adaptersDisc.map((a) => {
          const meta = DISCOVERY_META[a.key] || {};
          const slugHome = normalizeNetworkSlug(a.chain) || a.chain;
          return {
            key:          a.key,
            shortKey:     a.shortKey,
            name:         a.name,
            chain:        a.chain,
            category:     a.category,
            executionState: a.executionState,
            enabled:      a.enabled,
            supportedTokens: a.supportedTokens ?? [],
            networks:     a.networks ?? null,
            primaryCaip2: a.primaryCaip2 ?? null,
            intentBase:   getIntentBaseForSlug(slugHome),
            apyRangeMin:  meta.apyRangeMin ?? null,
            apyRangeMax:  meta.apyRangeMax ?? null,
            minAmount:    meta.minAmount ?? null,
            detail:       `/api/adapters/${a.shortKey}`,
          };
        });
        if (tokenFilter) {
          const upper = tokenFilter.toUpperCase();
          list = list.filter((a) =>
            a.supportedTokens.length === 0 || a.supportedTokens.some((t) => t.toUpperCase() === upper)
          );
        }
        if (category) list = list.filter((a) => a.category === category);
        if (minApy != null && !Number.isNaN(minApy)) list = list.filter((a) => (a.apyRangeMax ?? a.apyRangeMin ?? 0) >= minApy);
        if (maxApy != null && !Number.isNaN(maxApy)) list = list.filter((a) => (a.apyRangeMin ?? a.apyRangeMax ?? 999) <= maxApy);
        if (minAmount != null && !Number.isNaN(minAmount)) list = list.filter((a) => (a.minAmount ?? 0) <= minAmount);

        const grouped = url.searchParams.get("grouped") === "1" || url.searchParams.get("groupBy") === "chain"
          ? groupAdaptersByNetwork(
              adaptersDisc.map((a) => ({
                key: a.key,
                shortKey: a.shortKey,
                name: a.name,
                chain: a.chain,
                category: a.category,
                enabled: a.enabled,
                executionState: a.executionState,
                networks: a.networks,
              }))
            )
          : null;

        const uniqueKeys = new Set(adaptersDisc.map((a) => a.key));
        return json({
          success: true,
          adapters: list,
          total:    list.length,
          ...(grouped ? { byNetwork: grouped.byNetwork, networks: grouped.chains } : {}),
          filters:  { chain, category, minApy, maxApy, minAmount },
          registryIntegrity: {
            runtimeListedCount: adaptersDisc.length,
            uniqueKeyCount:     uniqueKeys.size,
            keyFingerprintSha256: await adapterRegistryKeyFingerprint(adaptersDisc),
          },
          routes:   {
            detail: "/api/adapters/:key",
            discover: "/api/adapters/discover",
            groupedDiscover: "/api/adapters/discover?grouped=1 (adds byNetwork after filters)",
          },
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        return json({ success: true, adapters: [], total: 0, error: "Discovery temporarily unavailable", timestamp: new Date().toISOString() });
      }
    }

    // GET /api/adapters/health (public; never 500 — return degraded on failure)
    // Top-level status matches gateway /health vocabulary: operational | degraded.
    if (path === "/health" && request.method === "GET") {
      try {
        const adapters = await registry.list();
        return json({
          success:  true,
          status:   "operational",
          adapters: adapters.map((a) => ({
          key:               a.key,
          shortKey:          a.shortKey,
          name:              a.name,
          chain:             a.chain,
          enabled:           a.enabled,
          mode:              a.mode,
          configuredMode:    a.configuredMode,
          status:            a.status,
          liveConfigured:    a.liveConfigured,
          executionState:    a.executionState,
          availabilityReason: a.availabilityReason,
        })),
        time: new Date().toISOString(),
      });
      } catch (e) {
        return json({
          success:  true,
          status:   "degraded",
          adapters: [],
          error:    "Adapter registry temporarily unavailable",
          time:     new Date().toISOString(),
        });
      }
    }

    // POST /api/adapters/quote
    if (path === "/quote" && request.method === "POST") {
      const body    = await safeJson(request);
      if (body === null) return json({ success: false, error: "Invalid or too large JSON body (max 64 KB)" }, 413);
      const rawKey  = sanitizeRequestedAdapterKey(body?.adapter || body?.key || body?.protocol || body?.protocolKey);
      if (!rawKey) return json({ success: false, error: "Invalid adapter key format" }, 400);
      const adapter = await registry.get(rawKey);
      if (!adapter) return json({ success: false, error: "Adapter not found", provided: safeEchoKey(rawKey) }, 404);
      if (!adapter.enabled) return json({ success: false, error: "Adapter disabled" }, 403);
      const quote = await quoteAdapter(adapter, body || {}, env);
      return json({ success: true, adapter: adapter.key, shortKey: adapter.shortKey, quote });
    }

    // POST /api/adapters/plan
    if (path === "/plan" && request.method === "POST") {
      const body    = await safeJson(request);
      if (body === null) return json({ success: false, error: "Invalid or too large JSON body (max 64 KB)" }, 413);
      const rawKey  = sanitizeRequestedAdapterKey(body?.adapter || body?.key || body?.protocol || body?.protocolKey);
      if (!rawKey) return json({ success: false, error: "Invalid adapter key format" }, 400);
      const adapter = await registry.get(rawKey);
      if (!adapter) return json({ success: false, error: "Adapter not found", provided: safeEchoKey(rawKey) }, 404);
      if (!adapter.enabled) return json({ success: false, error: "Adapter disabled" }, 403);
      const plan = await planAdapter(adapter, body || {}, env);
      return json({ success: true, adapter: adapter.key, shortKey: adapter.shortKey, plan });
    }

    // /api/adapters/:key  /  /api/adapters/:key/quote  /  /api/adapters/:key/plan
    const RESERVED_ADAPTER_PATHS = new Set(["discover", "health", "quote", "plan"]);
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 1) {
      const keyPart = sanitizeRequestedAdapterKey(parts[0]);
      if (!keyPart) return json({ success: false, error: "Invalid adapter key format" }, 400);
      if (RESERVED_ADAPTER_PATHS.has(keyPart)) {
        return json({
          success: false,
          error:    "Reserved path — not an adapter key",
          provided: safeEchoKey(keyPart),
          hint:     keyPart === "discover" ? "Use GET /api/adapters/discover" : keyPart === "health" ? "Use GET /api/adapters/health" : "Use POST /api/adapters/quote or /api/adapters/plan with body.adapter",
        }, 404);
      }
      const adapter = await registry.get(keyPart);
      if (!adapter) {
        return json({
          success:  false,
          error:    "Adapter not found",
          provided: safeEchoKey(keyPart),
          hint:     "Use compound key (e.g. zest-stacks), shortKey (e.g. zest), or any alias",
        }, 404);
      }

      if (parts.length === 1 && request.method === "GET") {
        return json({
          success: true,
          adapter,
          aliases: adapter.aliases,
          routes: {
            detail: `/api/adapters/${adapter.key}`,
            quote:  `/api/adapters/${adapter.key}/quote`,
            plan:   `/api/adapters/${adapter.key}/plan`,
          },
        });
      }

      if (parts[1] === "quote" && request.method === "POST") {
        if (!adapter.enabled) return json({ success: false, error: "Adapter disabled" }, 403);
        const body  = await safeJson(request);
        if (body === null) return json({ success: false, error: "Invalid or too large JSON body (max 64 KB)" }, 413);
        const quote = await quoteAdapter(adapter, body || {}, env);
        return json({ success: true, adapter: adapter.key, shortKey: adapter.shortKey, quote });
      }

      if (parts[1] === "plan" && request.method === "POST") {
        if (!adapter.enabled) return json({ success: false, error: "Adapter disabled" }, 403);
        const body = await safeJson(request);
        if (body === null) return json({ success: false, error: "Invalid or too large JSON body (max 64 KB)" }, 413);
        const plan = await planAdapter(adapter, body || {}, env);
        return json({ success: true, adapter: adapter.key, shortKey: adapter.shortKey, plan });
      }
    }

    return json({ success: false, error: "Not found" }, 404);
  } catch (err) {
    const msg = err?.message || "Adapter API error";
    const status = msg.includes("requires live mode") ? 400 : 500;
    return json({ success: false, error: msg }, status);
  }
}

// ============================================================================
// Provenance classification — enterprise truth labeling (auditor-corrected model)
// ============================================================================

function classifyProvenance(liveOutput) {
  const raw = liveOutput?.result || {};
  const result =
    raw && typeof raw === "object" && raw.result != null && typeof raw.result === "object" && !Array.isArray(raw.result)
      ? raw.result
      : raw;
  const hasTee = !!(result.teeAttestation || liveOutput.teeAttestation);
  const upstreamDeclared = String(result.provenance || "").toLowerCase();

  if (["simulated", "mock", "stub"].includes(upstreamDeclared)) {
    return {
      provenance: "simulated",
      confidence: "low",
      verificationHint: "Simulated output — not protocol-native and not execution-verifiable",
    };
  }

  if (upstreamDeclared === "protocol-native") {
    return {
      provenance: "protocol-native",
      confidence: "high",
      verificationHint: "Data sourced directly from protocol RPC/on-chain state"
        + (hasTee ? ", TEE-attested" : ""),
    };
  }
  if (hasTee) {
    return {
      provenance: "tee-attested-agent",
      confidence: "medium",
      verificationHint: "Generated by agent inside NEAR Cloud TEE; computation is "
        + "attested but data may not be protocol-native — verify independently",
    };
  }
  return {
    provenance: "agent-llm",
    confidence: "medium-low",
    verificationHint: "LLM-generated via NEAR AI agent without TEE envelope; verify independently before execution",
  };
}

function confidenceToScore(confidence) {
  switch (String(confidence || "").toLowerCase()) {
    case "high": return 0.95;
    case "medium": return 0.65;
    case "medium-low": return 0.3;
    case "low": return 0.1;
    default: return 0;
  }
}

// ============================================================================
// Gateway-side TEE attestation
// ============================================================================
// When TEE_ATTEST_ADAPTER_RESPONSES=true (or TEE_MANAGED_MODE=true), the
// gateway calls the TEE signer after every successful live quote/plan to stamp
// the response with a TEE attestation — making provenance "tee-attested-agent"
// for ALL live adapter responses regardless of whether the upstream returns one.
// Controlled by:
//   TEE_ATTEST_ADAPTER_RESPONSES=true  — attest all live responses
//   TEE_MANAGED_MODE=true              — alias, same effect
//   TEE_SIGNER_URL                     — required; falls back gracefully if not set

async function gatewayTeeAttest(env, adapterKey, responseDigest) {
  const teeUrl = String(env.TEE_SIGNER_URL || "").trim().replace(/\/+$/, "");
  if (!teeUrl) return null;
  const internalKey = String(env.INTERNAL_KEY_SIGN || env.INTERNAL_SHARED_KEY || "").trim();
  if (!internalKey) return null;
  try {
    const resp = await fetch(`${teeUrl}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": internalKey },
      body: JSON.stringify({
        requestId:  crypto.randomUUID(),
        timestamp:  new Date().toISOString(),
        callerId:   "gateway-adapter",
        walletId:   String(env.TEE_WALLET_ID || "compat-attest-wallet"),
        chain:      "ethereum",
        action:     "attest",
        amount:     "0",
        payload:    { adapter: adapterKey, digest: responseDigest, source: "gateway-tee-attest" },
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (resp.status >= 500) return null;
    const data = await resp.json().catch(() => null);
    if (data?.success === true && data?.status === "signed") {
      return { source: "gateway-tee", status: data.status, attestedAt: new Date().toISOString(), signerUrl: teeUrl };
    }
    return null;
  } catch { return null; /* best-effort — never block adapter response */ }
}

function shouldTeeAttest(env) {
  const v = String(env.TEE_ATTEST_ADAPTER_RESPONSES || env.TEE_MANAGED_MODE || "false").toLowerCase();
  return ["1", "true", "yes", "on"].includes(v);
}

// ============================================================================
// Adapter execution
// ============================================================================

async function quoteAdapter(adapter, params, env) {
  const mode = adapter.mode || "live";
  const hook = LIVE_HOOKS[adapter.shortKey];

  const rawRequestedAsset = params?.asset || params?.token || null;
  const requestedAsset = rawRequestedAsset ? (resolveTokenSymbol(rawRequestedAsset) || String(rawRequestedAsset).trim().toUpperCase()) : null;
  if (requestedAsset && adapter.supportedTokens?.length) {
    if (!adapterSupportsToken(adapter, requestedAsset)) {
      throw new Error(`Token "${rawRequestedAsset}" not supported by ${adapter.key}. Supported: ${adapter.supportedTokens.join(", ")}`);
    }
  }

  logTelemetry("quote:start", adapter, { mode, action: params?.action || null });

  if ((mode === "live" || mode === "auto") && hook?.quote) {
    try {
      const out = await hook.quote(adapter, params, env);
      if (out) {
        logTelemetry("quote:live_ok", adapter, { mode });
        const { provenance, confidence, verificationHint } = classifyProvenance(out);
        const confidenceScore = confidenceToScore(confidence);
        if (mode === "live" && confidenceScore < MIN_CONFIDENCE_THRESHOLD) {
          throw new Error(`${adapter.key} live quote provenance below threshold (${confidence})`);
        }
        // Gateway-side TEE attestation — stamps every live response when TEE_ATTEST_ADAPTER_RESPONSES=true
        let teeAttestation = out.teeAttestation || null;
        if (!teeAttestation && shouldTeeAttest(env)) {
          teeAttestation = await gatewayTeeAttest(env, adapter.key, String(out.estimatedApyBps ?? out.expectedAmountOut ?? ""));
        }
        const finalProvenance = teeAttestation ? "tee-attested-agent" : provenance;
        const finalHint = teeAttestation
          ? "Gateway TEE-attested via NEAR AI Cloud enclave" + (verificationHint ? `; ${verificationHint}` : "")
          : verificationHint;
        return {
          ...out, adapter: adapter.key, shortKey: adapter.shortKey,
          mode: "live", status: "ok", quotedAt: new Date().toISOString(),
          provenance: finalProvenance, confidence, verificationHint: finalHint,
          ...(teeAttestation ? { teeAttestation } : {}),
          teeVerified: !!teeAttestation,
        };
      }
    } catch (err) {
      logTelemetry("quote:live_error", adapter, { mode, error: err?.message || "unknown" });
      if (mode === "live") throw new Error(err?.message || `${adapter.key} live quote failed`);
      // auto mode: fall through to sim
    }
  }

  if (mode === "sim") {
    logTelemetry("quote:sim_refused", adapter, { mode });
    throw new Error(`Adapter ${adapter.key} requires live mode for TEE verification. Set ADAPTER_*_MODE=live and configure ADAPTER_*_QUOTE_URL.`);
  }
  logTelemetry("quote:sim_fallback", adapter, { mode });
  return simulateQuote(adapter, params);
}

async function planAdapter(adapter, params, env) {
  const mode = adapter.mode || "live";
  const hook = LIVE_HOOKS[adapter.shortKey];

  const rawRequestedAsset = params?.asset || params?.token || null;
  const requestedAsset = rawRequestedAsset ? (resolveTokenSymbol(rawRequestedAsset) || String(rawRequestedAsset).trim().toUpperCase()) : null;
  if (requestedAsset && adapter.supportedTokens?.length) {
    if (!adapterSupportsToken(adapter, requestedAsset)) {
      throw new Error(`Token "${rawRequestedAsset}" not supported by ${adapter.key}. Supported: ${adapter.supportedTokens.join(", ")}`);
    }
  }

  logTelemetry("plan:start", adapter, { mode, action: params?.action || null });

  if ((mode === "live" || mode === "auto") && hook?.plan) {
    try {
      const out = await hook.plan(adapter, params, env);
      if (out) {
        logTelemetry("plan:live_ok", adapter, { mode });
        const { provenance, confidence, verificationHint } = classifyProvenance(out);
        const confidenceScore = confidenceToScore(confidence);
        if (mode === "live" && confidenceScore < MIN_CONFIDENCE_THRESHOLD) {
          throw new Error(`${adapter.key} live plan provenance below threshold (${confidence})`);
        }
        // Gateway-side TEE attestation — stamps every live plan when TEE_ATTEST_ADAPTER_RESPONSES=true
        let teeAttestation = out.teeAttestation || null;
        if (!teeAttestation && shouldTeeAttest(env)) {
          teeAttestation = await gatewayTeeAttest(env, adapter.key, String(out.txData || out.steps?.length || "plan"));
        }
        const finalProvenance = teeAttestation ? "tee-attested-agent" : provenance;
        const finalHint = teeAttestation
          ? "Gateway TEE-attested via NEAR AI Cloud enclave" + (verificationHint ? `; ${verificationHint}` : "")
          : verificationHint;
        return {
          ...out, adapter: adapter.key, shortKey: adapter.shortKey,
          mode: "live", status: "ok", plannedAt: new Date().toISOString(),
          provenance: finalProvenance, confidence, verificationHint: finalHint,
          ...(teeAttestation ? { teeAttestation } : {}),
          teeVerified: !!teeAttestation,
        };
      }
    } catch (err) {
      logTelemetry("plan:live_error", adapter, { mode, error: err?.message || "unknown" });
      if (mode === "live") throw new Error(err?.message || `${adapter.key} live plan failed`);
    }
  }

  if (mode === "sim") {
    logTelemetry("plan:sim_refused", adapter, { mode });
    throw new Error(`Adapter ${adapter.key} requires live mode for TEE verification. Set ADAPTER_*_MODE=live and configure ADAPTER_*_PLAN_URL.`);
  }
  logTelemetry("plan:sim_fallback", adapter, { mode });
  return simulatePlan(adapter, params);
}


function extractTeeEvidence(resp, parsed) {
  const bodyAttestation =
    parsed?.teeAttestation ||
    parsed?.attestation ||
    parsed?.tee_attestation ||
    parsed?.tee ||
    null;

  const headerMap = {
    signature: resp.headers.get("x-tee-signature") || resp.headers.get("X-TEE-Signature"),
    attestation: resp.headers.get("x-tee-attestation") || resp.headers.get("X-TEE-Attestation"),
    evidence: resp.headers.get("x-tee-evidence") || resp.headers.get("X-TEE-Evidence"),
    enclave: resp.headers.get("x-tee-enclave") || resp.headers.get("X-TEE-Enclave"),
    instance: resp.headers.get("x-tee-instance") || resp.headers.get("X-TEE-Instance"),
    timestamp: resp.headers.get("x-tee-timestamp") || resp.headers.get("X-TEE-Timestamp"),
    verified: resp.headers.get("x-tee-verified") || resp.headers.get("X-TEE-Verified"),
  };

  const headers = Object.fromEntries(
    Object.entries(headerMap).filter(([, v]) => v != null && v !== "")
  );

  if (bodyAttestation || Object.keys(headers).length > 0) {
    return {
      teeAttestation: bodyAttestation || { source: "headers", headers },
      teeHeaders: headers,
    };
  }

  return {};
}

// ============================================================================
// Live hooks — one entry per shortKey
// ============================================================================

const LIVE_HOOKS = {
  rhea:      { quote: (a,p,e) => callLive("RHEA",      "QUOTE",a,p,e), plan: (a,p,e) => callLive("RHEA",      "PLAN",a,p,e) },
  babylon:   { quote: (a,p,e) => callLive("BABYLON",   "QUOTE",a,p,e), plan: (a,p,e) => callLive("BABYLON",   "PLAN",a,p,e) },
  zest:      { quote: (a,p,e) => callLive("ZEST",      "QUOTE",a,p,e), plan: (a,p,e) => callLive("ZEST",      "PLAN",a,p,e) },
  lombard:   { quote: (a,p,e) => callLive("LOMBARD",   "QUOTE",a,p,e), plan: (a,p,e) => callLive("LOMBARD",   "PLAN",a,p,e) },
  solv:      { quote: (a,p,e) => callLive("SOLV",      "QUOTE",a,p,e), plan: (a,p,e) => callLive("SOLV",      "PLAN",a,p,e) },
  euler:     { quote: (a,p,e) => callLive("EULER",     "QUOTE",a,p,e), plan: (a,p,e) => callLive("EULER",     "PLAN",a,p,e) },
  aave:      { quote: (a,p,e) => callLive("AAVE",      "QUOTE",a,p,e), plan: (a,p,e) => callLive("AAVE",     "PLAN",a,p,e) },
  silo:      { quote: (a,p,e) => callLive("SILO",      "QUOTE",a,p,e), plan: (a,p,e) => callLive("SILO",      "PLAN",a,p,e) },
  suilend:   { quote: (a,p,e) => callLive("SUILEND",   "QUOTE",a,p,e), plan: (a,p,e) => callLive("SUILEND",   "PLAN",a,p,e) },
  clovis:    { quote: (a,p,e) => callLive("CLOVIS",    "QUOTE",a,p,e), plan: (a,p,e) => callLive("CLOVIS",    "PLAN",a,p,e) },
  katana:    { quote: (a,p,e) => callLive("KATANA",    "QUOTE",a,p,e), plan: (a,p,e) => callLive("KATANA",    "PLAN",a,p,e) },
  thevault:  { quote: (a,p,e) => callLive("THEVAULT",  "QUOTE",a,p,e), plan: (a,p,e) => callLive("THEVAULT",  "PLAN",a,p,e) },
  endur:     { quote: (a,p,e) => callLive("ENDUR",     "QUOTE",a,p,e), plan: (a,p,e) => callLive("ENDUR",     "PLAN",a,p,e) },
  bitcoinos:  { quote: (a,p,e) => callLive("BITCOINOS",  "QUOTE",a,p,e), plan: (a,p,e) => callLive("BITCOINOS",  "PLAN",a,p,e) },
  charms:     { quote: (a,p,e) => callLive("CHARMS",     "QUOTE",a,p,e), plan: (a,p,e) => callLive("CHARMS",     "PLAN",a,p,e) },
  layerzero:  { quote: (a,p,e) => callLive("LAYERZERO",  "QUOTE",a,p,e), plan: (a,p,e) => callLive("LAYERZERO",  "PLAN",a,p,e) },
  hermetica: { quote: (a,p,e) => callLive("HERMETICA", "QUOTE",a,p,e), plan: (a,p,e) => callLive("HERMETICA", "PLAN",a,p,e) },
  justlend:  { quote: (a,p,e) => callLive("JUSTLEND", "QUOTE",a,p,e),  plan: (a,p,e) => callLive("JUSTLEND", "PLAN",a,p,e) },
  sunswap:   { quote: (a,p,e) => callLive("SUNSWAP", "QUOTE",a,p,e),  plan: (a,p,e) => callLive("SUNSWAP", "PLAN",a,p,e) },
  secured:   { quote: (a,p,e) => callLive("SECURED",  "QUOTE",a,p,e),  plan: (a,p,e) => callLive("SECURED",  "PLAN",a,p,e) },
  glif:      { quote: (a,p,e) => callLive("GLIF",     "QUOTE",a,p,e),  plan: (a,p,e) => callLive("GLIF",     "PLAN",a,p,e) },
  jupiter:   { quote: (a,p,e) => callLive("JUPITER",  "QUOTE",a,p,e),  plan: (a,p,e) => callLive("JUPITER",  "PLAN",a,p,e) },
  allbridge: { quote: (a,p,e) => callLive("ALLBRIDGE", "QUOTE",a,p,e), plan: (a,p,e) => callLive("ALLBRIDGE", "PLAN",a,p,e) },
  openocean: { quote: (a,p,e) => callLive("OPENOCEAN","QUOTE",a,p,e),  plan: (a,p,e) => callLive("OPENOCEAN","PLAN",a,p,e) },
  rubic:     { quote: (a,p,e) => callLive("RUBIC",    "QUOTE",a,p,e),  plan: (a,p,e) => callLive("RUBIC",    "PLAN",a,p,e) },
  kamino:    { quote: (a,p,e) => callLive("KAMINO",   "QUOTE",a,p,e),  plan: (a,p,e) => callLive("KAMINO",   "PLAN",a,p,e) },
  lisa:      { quote: (a,p,e) => callLive("LISA",     "QUOTE",a,p,e),  plan: (a,p,e) => callLive("LISA",     "PLAN",a,p,e) },
  navi:      { quote: (a,p,e) => callLive("NAVI",     "QUOTE",a,p,e),  plan: (a,p,e) => callLive("NAVI",     "PLAN",a,p,e) },
  scallop:   { quote: (a,p,e) => callLive("SCALLOP",  "QUOTE",a,p,e),  plan: (a,p,e) => callLive("SCALLOP",  "PLAN",a,p,e) },
  volo:      { quote: (a,p,e) => callLive("VOLO",     "QUOTE",a,p,e),  plan: (a,p,e) => callLive("VOLO",     "PLAN",a,p,e) },
  haedal:    { quote: (a,p,e) => callLive("HAEDAL",   "QUOTE",a,p,e),  plan: (a,p,e) => callLive("HAEDAL",   "PLAN",a,p,e) },
  cetus:     { quote: (a,p,e) => callLive("CETUS",    "QUOTE",a,p,e),  plan: (a,p,e) => callLive("CETUS",    "PLAN",a,p,e) },
  stackingdao: { quote: (a,p,e) => callLive("STACKINGDAO", "QUOTE",a,p,e), plan: (a,p,e) => callLive("STACKINGDAO", "PLAN",a,p,e) },
  alex:      { quote: (a,p,e) => callLive("ALEX",     "QUOTE",a,p,e),  plan: (a,p,e) => callLive("ALEX",     "PLAN",a,p,e) },
  velar:     { quote: (a,p,e) => callLive("VELAR",    "QUOTE",a,p,e),  plan: (a,p,e) => callLive("VELAR",    "PLAN",a,p,e) },
  arkadiko:  { quote: (a,p,e) => callLive("ARKADIKO", "QUOTE",a,p,e),  plan: (a,p,e) => callLive("ARKADIKO", "PLAN",a,p,e) },
  hyperliquid: { quote: (a,p,e) => callLive("HYPERLIQUID", "QUOTE",a,p,e), plan: (a,p,e) => callLive("HYPERLIQUID", "PLAN",a,p,e) },
  lido:      { quote: (a,p,e) => callLive("LIDO",     "QUOTE",a,p,e),  plan: (a,p,e) => callLive("LIDO",     "PLAN",a,p,e) },
  beth:      { quote: (a,p,e) => callLive("BETH",     "QUOTE",a,p,e),  plan: (a,p,e) => callLive("BETH",     "PLAN",a,p,e) },
  rocketpool: { quote: (a,p,e) => callLive("ROCKETPOOL", "QUOTE",a,p,e), plan: (a,p,e) => callLive("ROCKETPOOL", "PLAN",a,p,e) },
  mantle:    { quote: (a,p,e) => callLive("MANTLE",   "QUOTE",a,p,e),  plan: (a,p,e) => callLive("MANTLE",   "PLAN",a,p,e) },
  fraxeth:   { quote: (a,p,e) => callLive("FRAXETH",  "QUOTE",a,p,e),  plan: (a,p,e) => callLive("FRAXETH",  "PLAN",a,p,e) },
  swell:     { quote: (a,p,e) => callLive("SWELL",    "QUOTE",a,p,e),  plan: (a,p,e) => callLive("SWELL",    "PLAN",a,p,e) },
  renzo:     { quote: (a,p,e) => callLive("RENZO",    "QUOTE",a,p,e),  plan: (a,p,e) => callLive("RENZO",    "PLAN",a,p,e) },
  etherfi:   { quote: (a,p,e) => callLive("ETHERFI",  "QUOTE",a,p,e),  plan: (a,p,e) => callLive("ETHERFI",  "PLAN",a,p,e) },
  vesu:      { quote: (a,p,e) => callLive("VESU",     "QUOTE",a,p,e),  plan: (a,p,e) => callLive("VESU",     "PLAN",a,p,e) },
  metapool:  { quote: (a,p,e) => callLive("METAPOOL", "QUOTE",a,p,e),  plan: (a,p,e) => callLive("METAPOOL", "PLAN",a,p,e) },
  linear:    { quote: (a,p,e) => callLive("LINEAR",   "QUOTE",a,p,e),  plan: (a,p,e) => callLive("LINEAR",   "PLAN",a,p,e) },
  usual:     { quote: (a,p,e) => callLive("USUAL",    "QUOTE",a,p,e),  plan: (a,p,e) => callLive("USUAL",    "PLAN",a,p,e) },
  ethena:    { quote: (a,p,e) => callLive("ETHENA",   "QUOTE",a,p,e),  plan: (a,p,e) => callLive("ETHENA",   "PLAN",a,p,e) },
  curve:     { quote: (a,p,e) => callLive("CURVE",    "QUOTE",a,p,e),  plan: (a,p,e) => callLive("CURVE",    "PLAN",a,p,e) },
  bedrock:   { quote: (a,p,e) => callLive("BEDROCK",  "QUOTE",a,p,e),  plan: (a,p,e) => callLive("BEDROCK",  "PLAN",a,p,e) },
  bitlayer:  { quote: (a,p,e) => callLive("BITLAYER", "QUOTE",a,p,e),  plan: (a,p,e) => callLive("BITLAYER", "PLAN",a,p,e) },
  bob:       { quote: (a,p,e) => callLive("BOB",       "QUOTE",a,p,e),  plan: (a,p,e) => callLive("BOB",       "PLAN",a,p,e) },
  citrea:    { quote: (a,p,e) => callLive("CITREA",    "QUOTE",a,p,e),  plan: (a,p,e) => callLive("CITREA",    "PLAN",a,p,e) },
  bouncebit: { quote: (a,p,e) => callLive("BOUNCEBIT", "QUOTE",a,p,e),  plan: (a,p,e) => callLive("BOUNCEBIT", "PLAN",a,p,e) },
  rootstock: { quote: (a,p,e) => callLive("ROOTSTOCK", "QUOTE",a,p,e),  plan: (a,p,e) => callLive("ROOTSTOCK", "PLAN",a,p,e) },
  sovryn:    { quote: (a,p,e) => callLive("SOVRYN",   "QUOTE",a,p,e),  plan: (a,p,e) => callLive("SOVRYN",   "PLAN",a,p,e) },
  yearn:     { quote: (a,p,e) => callLive("YEARN",    "QUOTE",a,p,e),  plan: (a,p,e) => callLive("YEARN",    "PLAN",a,p,e) },
  firelight: { quote: (a,p,e) => callLive("FIRELIGHT", "QUOTE",a,p,e), plan: (a,p,e) => callLive("FIRELIGHT", "PLAN",a,p,e) },
  earnxrp:   { quote: (a,p,e) => callLive("EARNXRP",   "QUOTE",a,p,e), plan: (a,p,e) => callLive("EARNXRP",   "PLAN",a,p,e) },
  morphoflare: { quote: (a,p,e) => callLive("MORPHO_FLARE", "QUOTE",a,p,e), plan: (a,p,e) => callLive("MORPHO_FLARE", "PLAN",a,p,e) },
  venus:        { quote: (a,p,e) => callLive("VENUS",       "QUOTE",a,p,e), plan: (a,p,e) => callLive("VENUS",       "PLAN",a,p,e) },
  pancakeswap:  { quote: (a,p,e) => callLive("PANCAKESWAP", "QUOTE",a,p,e), plan: (a,p,e) => callLive("PANCAKESWAP", "PLAN",a,p,e) },
  sologenic:    { quote: (a,p,e) => callLive("SOLOGENIC",   "QUOTE",a,p,e), plan: (a,p,e) => callLive("SOLOGENIC",   "PLAN",a,p,e) },
  xrplamm:      { quote: (a,p,e) => callLive("XRPL_AMM",    "QUOTE",a,p,e), plan: (a,p,e) => callLive("XRPL_AMM",    "PLAN",a,p,e) },
  beefy:       { quote: (a,p,e) => callLive("BEEFY",       "QUOTE",a,p,e), plan: (a,p,e) => callLive("BEEFY",       "PLAN",a,p,e) },
  convex:      { quote: (a,p,e) => callLive("CONVEX",      "QUOTE",a,p,e), plan: (a,p,e) => callLive("CONVEX",      "PLAN",a,p,e) },
  compoundv3:  { quote: (a,p,e) => callLive("COMPOUNDV3", "QUOTE",a,p,e), plan: (a,p,e) => callLive("COMPOUNDV3", "PLAN",a,p,e) },
  pendle:      { quote: (a,p,e) => callLive("PENDLE",      "QUOTE",a,p,e), plan: (a,p,e) => callLive("PENDLE",      "PLAN",a,p,e) },
  marinade:    { quote: (a,p,e) => callLive("MARINADE",    "QUOTE",a,p,e), plan: (a,p,e) => callLive("MARINADE",    "PLAN",a,p,e) },
  jito:        { quote: (a,p,e) => callLive("JITO",        "QUOTE",a,p,e), plan: (a,p,e) => callLive("JITO",        "PLAN",a,p,e) },
  benqi:       { quote: (a,p,e) => callLive("BENQI",       "QUOTE",a,p,e), plan: (a,p,e) => callLive("BENQI",       "PLAN",a,p,e) },
  tonyield:    { quote: (a,p,e) => callLive("TONYIELD",    "QUOTE",a,p,e), plan: (a,p,e) => callLive("TONYIELD",    "PLAN",a,p,e) },
  troves:      { quote: (a,p,e) => callLive("TROVES",      "QUOTE",a,p,e), plan: (a,p,e) => callLive("TROVES",      "PLAN",a,p,e) },
  injective:   { quote: (a,p,e) => callLive("INJECTIVE",   "QUOTE",a,p,e), plan: (a,p,e) => callLive("INJECTIVE",   "PLAN",a,p,e) },
  osmosis:     { quote: (a,p,e) => callLive("OSMOSIS",     "QUOTE",a,p,e), plan: (a,p,e) => callLive("OSMOSIS",     "PLAN",a,p,e) },
  rubicon:     { quote: (a,p,e) => callLive("RUBICON",     "QUOTE",a,p,e), plan: (a,p,e) => callLive("RUBICON",     "PLAN",a,p,e) },
  amnis:       { quote: (a,p,e) => callLive("AMNIS",       "QUOTE",a,p,e), plan: (a,p,e) => callLive("AMNIS",       "PLAN",a,p,e) },
  stride:      { quote: (a,p,e) => callLive("STRIDE",      "QUOTE",a,p,e), plan: (a,p,e) => callLive("STRIDE",      "PLAN",a,p,e) },
  eigenlayer:  { quote: (a,p,e) => callLive("EIGENLAYER",  "QUOTE",a,p,e), plan: (a,p,e) => callLive("EIGENLAYER",  "PLAN",a,p,e) },
};

// [FIX-A2] Upstream URL never included in response
// [FIX-A3] Throws on non-2xx — caught by quoteAdapter/planAdapter (auto mode falls through to sim)
// [FIX-A4] TEE attestation surfaced when upstream returns one or via TEE headers
async function callLive(prefix, kind, adapter, params, env) {
  const url = env[`ADAPTER_${prefix}_${kind}_URL`];
  if (!url) return null;

  const timeoutMs = Number(
    env[`ADAPTER_${prefix}_TIMEOUT_MS`] || env.ADAPTERS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS
  );

  const payload = {
    adapter:  adapter.key,
    shortKey: adapter.shortKey,
    chain:    adapter.chain,
    category: adapter.category,
    request:  params,
    context:  { env: env.ENV || "prod", ts: new Date().toISOString() },
  };

  const headers = {
    "content-type": "application/json",
    ...(env[`ADAPTER_${prefix}_API_KEY`]
      ? { authorization: `Bearer ${env[`ADAPTER_${prefix}_API_KEY`]}` }
      : {}),
    ...(String(env.INTERNAL_KEY_VERIFY || env.INTERNAL_SHARED_KEY || "").trim()
      ? { "x-internal-key": String(env.INTERNAL_KEY_VERIFY || env.INTERNAL_SHARED_KEY || "").trim() }
      : {}),
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let resp, text, parsed;
  try {
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
    text = await resp.text();
    try   { parsed = text ? JSON.parse(text) : null; }
    catch { parsed = { raw: text }; }
  } catch (err) {
    clearTimeout(t);
    throw new Error(`${adapter.key} upstream unreachable: ${err?.message || "fetch failed"}`);
  } finally {
    clearTimeout(t);
  }

  // [FIX-A3] Non-2xx → return null (sim fallback for auto) or throw (live mode)
  if (!resp.ok) {
    const preview = (text || "").slice(0, 300).replace(/\s+/g, " ");
    logTelemetry("callLive:upstream_error", adapter, { status: resp.status, kind });
    console.error("adapter_live_upstream_failed", JSON.stringify({
      adapter: adapter?.key || "unknown",
      op: kind,
      url,
      status: resp.status,
      responsePreview: (text || "").slice(0, 4000),
    }));
    throw new Error(`${adapter.key} live quote failed: upstream ${resp.status} ${preview}`);
  }

  // [FIX-A4] Surface TEE attestation if present in body or headers
  const { teeAttestation, teeHeaders } = extractTeeEvidence(resp, parsed);

  const stripState = { count: 0, keys: new Set() };
  const sanitized = stripSecrets(parsed, stripState);
  if (stripState.count > 0) {
    logTelemetry("callLive:secret_stripped", adapter, {
      count: stripState.count,
      keys: [...stripState.keys],
      kind,
    });
  }

  // [FIX-A2] Upstream URL is intentionally omitted from response
  return {
    result: sanitized,
    ...(teeAttestation ? { teeAttestation } : {}),
    ...(teeHeaders && Object.keys(teeHeaders).length ? { teeHeaders } : {}),
  };
}

// ============================================================================
// Simulated fallbacks
// ============================================================================

function simulateQuote(adapter, params) {
  const amount = String(params?.amount ?? "0");
  const asset  = params?.asset || defaultAssetFor(adapter.category, adapter.chain);
  const apyMap = {
    "rhea-near": 810, "babylon-btc": 450, "bitcoinos-bitcoin": 520,
    "lisa-stacks": 970, "stackingdao-stacks": 950,
    "lido-ethereum": 350, "rocketpool-ethereum": 340, "frax-eth": 330,
    "swell-ethereum": 400, "renzo-ethereum": 420, "etherfi-ethereum": 410,
    "venus-bsc": 560,
    "pancakeswap-bsc": 720,
    "sologenic-xrp": 620,
    "xrpl-amm": 480,
    "firelight-flare": 550,
    "earnxrp-flare": 600,
    "morpho-flare": 580,
    "beefy-multi": 720,
    "convex-ethereum": 680,
    "compound-v3-evm": 550,
    "pendle-multi": 650,
    "marinade-solana": 620,
    "jito-solana": 640,
    "benqi-avalanche": 520,
    "tonyield-ton": 580,
    "troves-starknet": 500,
    "injective-lending": 480,
    "osmosis-cosmos": 450,
    "rubicon-sei": 530,
    "amnis-aptos": 750,
    "stride-cosmos": 1000,
    "eigenlayer-ethereum": 650,
  };
  const apyCat = { lending: 620, vault: 780, btcfi: 540, "liquid-staking": 960, dex: 0, restaking: 600 };
  const apyBps = apyMap[adapter.key] ?? apyCat[adapter.category] ?? 500;

  return {
    mode:               "sim",
    adapter:            adapter.key,
    shortKey:           adapter.shortKey,
    provenance:         "simulated",
    confidence:         "low",
    verificationHint:   "Simulated data — not sourced from protocol or on-chain state",
    route:              `${params?.fromChain || adapter.chain}→${adapter.chain}`,
    action:             params?.action || adapter.actions?.[0] || "deposit",
    amount, asset,
    estimatedApyBps:    apyBps,
    estimatedFeeBps:    10,
    estimatedNetApyBps: apyBps - 10,
    quoteExpiresAt:     new Date(Date.now() + 60_000).toISOString(),
    note:               "Simulation — set ADAPTER_*_QUOTE_URL to wire live protocol data.",
  };
}

function simulatePlan(adapter, params) {
  const amount = String(params?.amount ?? "0");
  const asset  = params?.asset || defaultAssetFor(adapter.category, adapter.chain);
  const action = params?.action || adapter.actions?.[0] || "deposit";

  return {
    mode:             "sim",
    adapter:          adapter.key,
    shortKey:         adapter.shortKey,
    provenance:       "simulated",
    confidence:       "low",
    verificationHint: "Simulated plan — not sourced from protocol or on-chain state",
    action,
    summary:          `${action} ${amount} ${asset} via ${adapter.name} (${adapter.chain})`,
    steps: [
      { step: 1, type: "prepare", description: "Validate balances / approvals / wallet connectivity" },
      { step: 2, type: "approve", description: `Approve ${asset} to ${adapter.name} executor (if required)` },
      { step: 3, type: "execute", description: `${action} on ${adapter.name}` },
      { step: 4, type: "verify",  description: "Confirm position state and emit execution receipt" },
    ],
    note: "Simulation — set ADAPTER_*_PLAN_URL to wire live protocol data.",
  };
}

// ============================================================================
// Adapter materialization
// ============================================================================

function materializeAdapter(def, env) {
  const enabled    = toBool(env[`${def.envPrefix}_ENABLED`], true);
  const rawMode    = (env[`${def.envPrefix}_MODE`] || def.defaultMode || "live").toLowerCase();
  const configMode = ["live", "sim", "auto"].includes(rawMode) ? rawMode : "live";
  const timeoutMs  = Number(env[`${def.envPrefix}_TIMEOUT_MS`] || env.ADAPTERS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const quoteUrl   = env[`${def.envPrefix}_QUOTE_URL`] || null;
  const planUrl    = env[`${def.envPrefix}_PLAN_URL`]  || null;

  // Downgrade to sim only if configured live/auto but URLs not set
  const effectiveMode =
    (configMode === "live" || configMode === "auto") && !quoteUrl && !planUrl
      ? "sim" : configMode;

  // [UNIFIED-P3] Execution state truth — enterprise adapter transparency
  // Derives an explicit state so health/detail endpoints show real status.
  // quote OR plan URL is sufficient for live-ready (DEX adapters may only need quote).
  const liveConfigured = { quote: !!quoteUrl, plan: !!planUrl };
  const hasAnyLiveUrl  = liveConfigured.quote || liveConfigured.plan;

  let executionState     = "disabled";
  let availabilityReason = "adapter-disabled";

  if (enabled) {
    if (effectiveMode === "sim") {
      executionState     = (configMode === "live" || configMode === "auto") ? "sim-fallback" : "sim-explicit";
      availabilityReason = (configMode === "live" || configMode === "auto") ? "missing-live-endpoints" : "configured-for-simulation";
    } else if ((effectiveMode === "live" || effectiveMode === "auto") && hasAnyLiveUrl) {
      executionState     = "live-ready";
      availabilityReason = "live-endpoints-present";
    } else {
      executionState     = "degraded";
      availabilityReason = "partial-live-configuration";
    }
  }

  const resolvedNetworks = resolveNetworkMetadata(def.networks);

  const supportedTokens = def.supportedTokens || [];

  return {
    key:            def.key,
    shortKey:       def.shortKey,
    name:           def.name,
    chain:          def.chain,
    category:       def.category,
    status:         def.status,
    actions:        def.actions  || [],
    supportedTokens,
    homepage:       def.homepage || null,
    aliases:        def.aliases  || [],
    enabled,
    mode:           effectiveMode,
    configuredMode: configMode,
    timeoutMs,
    liveConfigured,
    executionState,
    availabilityReason,
    networks:       resolvedNetworks,
    primaryCaip2:   def.primaryCaip2 || resolvedNetworks?.[0]?.caip2 || null,
  };
}

// ============================================================================
// Shared helpers (adapter-local, no CORS)
// ============================================================================

// [FIX-A1] No CORS headers
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function safeJson(request) {
  try {
    const contentType = String(request.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("application/json")) return null;
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
    return text ? JSON.parse(text) : {};
  } catch { return null; }
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function defaultAssetFor(category, chain) {
  if (category === "btcfi") return "BTC";
  if (category === "liquid-staking") {
    if (chain === "stacks") return "STX";
    if (chain === "filecoin") return "FIL";
    if (chain === "xrp")   return "XRP";
    if (chain === "flare") return "FXRP";
    if (chain === "bsc" || chain === "bnb") return "BNB";
    if (chain === "solana") return "SOL";
    if (chain === "aptos") return "APT";
    if (chain === "cosmos") return "ATOM";
    if (chain === "mantle") return "mETH";
    return "ETH";
  }
  if (category === "restaking") return "ETH";
  if (category === "dex") return "STX/USDC";
  if (chain === "mantle") return "MNT";
  if (chain === "avalanche") return "AVAX";
  if (chain === "ton") return "TON";
  if (chain === "injective") return "INJ";
  if (chain === "osmosis") return "OSMO";
  if (chain === "sei") return "SEI";
  if (chain === "aptos") return "APT";
  if (chain === "cosmos") return "ATOM";
  return "USDC";
}

// [FIX-A6] Telemetry never throws
function logTelemetry(event, adapter, meta = {}) {
  try {
    const safeMeta = {};
    for (const [k, v] of Object.entries(meta || {})) {
      if (looksSensitiveKey(k)) {
        safeMeta[k] = "REDACTED";
        continue;
      }
      if (typeof v === "string") safeMeta[k] = v.slice(0, 256);
      else if (typeof v === "number" || typeof v === "boolean" || v == null) safeMeta[k] = v;
      else if (Array.isArray(v)) safeMeta[k] = v.slice(0, 10).map((x) => typeof x === "string" ? x.slice(0, 64) : x);
      else safeMeta[k] = "[object]";
    }
    console.log(JSON.stringify({
      ns:       "adapter-telemetry",
      event,
      adapter:  adapter?.key      || null,
      shortKey: adapter?.shortKey || null,
      chain:    adapter?.chain    || null,
      category: adapter?.category || null,
      ts:       new Date().toISOString(),
      ...safeMeta,
    }));
  } catch { /* telemetry must never break adapter execution */ }
}
