# Semantic conflict detection

Jupiter's core rule is deterministic: two people on the **same** path collide if at
least one of them is editing. That rule is exact, instant, and needs no AI.

It also misses the other half of the problem. Nobody is on the same file, but:

- Ana is adding coupons to `src/checkout/cart.py` while Ben rewrites
  `tests/checkout/test_cart.py`;
- Cleo adds a column in `db/schema/orders.sql` while Ana maps it in
  `src/models/order.py`.

Different paths, same work. Semantic conflict detection asks a language model to spot
exactly those pairs, and surfaces them as **advisory** warnings.

## What it changes, and what it does not

| | |
|---|---|
| Same-path conflicts | Unchanged. Still deterministic, still the only thing that produces `blocked`. |
| Different-path overlaps | New. Advisory only - never blocks, never alters `status`. |
| With no gateway configured | Feature switches itself off; everything else behaves identically. |
| If the gateway errors or times out | The finding is dropped. Claims and conflicts are unaffected. |

The model is never allowed to override, suppress, or re-rank a real conflict.

## Setup

Any OpenAI-compatible gateway works. Copy [`.env.example`](../.env.example) to `.env`:

```bash
JUPITER_LLM_API_KEY=sk-...
JUPITER_LLM_MODEL=deepseek-v4-pro-0813
JUPITER_LLM_BASE_URL=https://model-iq.aicore.accenture.com/v1
```

`OPENAI_API_KEY` and `OPENAI_BASE_URL` are honoured too, so a `.env` shared with
another tool usually works unchanged. Set `JUPITER_LLM_ENABLED=0` to keep the key
configured but the feature off.

`.env` is searched for next to the package, at the repo root, and in the working
directory. Real environment variables always win over file values. The server prints
what it resolved at start-up:

```
Jupiter 0.1.0
  database : sqlite:///home/you/.jupiter/jupiter.db
  lock TTL : 300s
  semantic : deepseek-v4-pro-0813 via https://model-iq.aicore.accenture.com/v1
  listening: http://0.0.0.0:7420  (docs at /docs)
```

`.env` is gitignored. `.env.example` is not - never put a real key in it.

## What is sent

Only what the team can already see on the dashboard: **file paths, intents, holder
display names, and the short notes people wrote**. No file contents, no diffs, no
repository data ever leave your network.

## Cost and caching

Findings are cached per *set of active claims*, fingerprinted over paths, intents,
holders and notes. The model is called only when that set actually changes - not on a
timer, and not when a claim is merely refreshed. A team whose claims are stable costs
one request, however many dashboards are open.

Analysis runs in a background thread and never blocks a request:

- `GET /semantic` answers immediately with `pending` the first time, then `ready`.
- `POST /locks` reads the cache only. A cold cache yields no hints rather than waiting.

Jupiter also declines to call the model at all when there is nothing to compare - fewer
than two distinct paths, or only one person involved.

## Trusting the output

A model will happily invent a filename. Every finding is checked against the real claim
set before it is shown, and dropped unless:

- every path it names is genuinely claimed right now;
- at least two distinct paths remain after de-duplication;
- at least two **different** people hold them (judged from Jupiter's own data, not the
  model's claim about who holds what);
- it carries a non-empty reason.

`confidence` is normalised to `high`/`medium`/`low`, and at most 8 findings are kept.
The prompt tells the model that an empty list is the correct answer when nothing
overlaps, because precision matters far more than recall here.

## Where it shows up

**Dashboard** - a *Possible overlaps* card on **Overview** and **Files**, and an inline
`≈ related to …` marker on the affected row of the claims table. These use the reserved
`warning` colour, never the `critical` colour that means a real conflict, and always
carry an icon plus a text label. **Settings** shows the model, gateway, last analysis
time and any error.

**Claude Code** - `jupiter_lock_file` appends any cached hint to its result, so the
agent hears about related work on the same call it already makes:

```
clear - you hold tests/checkout/test_cart.py (editing) until 2026-09-22T12:41:03Z
Heads-up, related work on other files (AI-suggested, advisory):
  - Ana holds src/checkout/cart.py (high confidence) - Implementation and its
    test file for coupon support.
```

`jupiter_who_is_working` lists them too, under a heading that marks them as advisory.

## API

```
GET /semantic          # member or org admin key
```

```json
{
  "status": "ready",
  "overlaps": [
    {
      "paths": ["src/checkout/cart.py", "tests/checkout/test_cart.py"],
      "members": ["Ana", "Ben"],
      "reason": "Implementation and its test file for coupon support.",
      "confidence": "high"
    }
  ],
  "analyzed_at": "2026-09-22T12:18:33Z",
  "model": "deepseek-v4-pro-0813",
  "error": null,
  "llm": { "enabled": true, "model": "…", "base_url": "…", "reason": null }
}
```

`status` is one of `ready`, `pending`, `error`, `disabled`. The response never contains
the API key.
