# x402 discovery — resource list

Public discovery document: **`GET https://api.yieldagentx402.app/.well-known/x402`**

The JSON `resources` field is a **string[]** of payable (402-gated) HTTPS URLs. Counts **change when** routes are added/removed in [`gateway-clean-deploy/src/x402.js`](../gateway-clean-deploy/src/x402.js) (probe filters, skill catalog, static suffix list).

## Current baseline (update when you change discovery)

When editing **README**, **landing copy**, or **runbooks** that mention discovery size, re-run the verification commands below and align documented numbers.

| Metric | Baseline (2026-04-06 prod) | How to verify |
|--------|----------------------------|---------------|
| Total `resources` | **76** | `len(resources)` from curl below |
| Skill URLs (`/api/skills/`) | **42** | Count strings containing `/api/skills/` |
| Non-skill URLs | **34** | Total minus skills |

## Verification commands

```bash
# Total resources + skill count
curl -sS "https://api.yieldagentx402.app/.well-known/x402" | python3 -c "
import json, sys
d = json.load(sys.stdin)
r = d.get('resources') or []
n = len(r)
skills = sum(1 for x in r if isinstance(x, str) and '/api/skills/' in x)
print('resources', n)
print('skills', skills)
print('non_skill', n - skills)
"
```

Implementation notes:

- Skill paths come from [`shared/skills-catalog.js`](../shared/skills-catalog.js) via [`gateway-clean-deploy/src/agent-skills.js`](../gateway-clean-deploy/src/agent-skills.js) and env filters (`SKILL_LIFECYCLE_MIN`, allow/deny lists).
- Non-skill entries include adapter quote/plan, yields, federation, intents, bridge helpers, market routes, etc., subject to the gateway’s **402-only** resource filter.

## Related (not duplicated here)

- **Swap / bridge adapters:** Which aggregators are live (**1inch** including Fusion-capable deployment paths, **AllBridge**, OpenOcean, etc.) is documented in [`README.md`](../README.md) § *Adapters & Integrations*. **1inch and AllBridge are both live** — AllBridge adds cross-chain lanes; it is not a wholesale replacement for 1inch in the public docs or gateway adapter registry.

## Doc maintenance checklist

When you ship a gateway change that affects discovery:

1. Run the curl snippet above against **production** (or staging if documenting staging).
2. Update this file’s baseline table.
3. Update [`README.md`](../README.md) x402 discovery subsection if it cites totals.
4. Add a one-line note to [`CHANGES.md`](../CHANGES.md) if the change is user-visible.
