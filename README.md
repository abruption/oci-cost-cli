<div align="center">

# oci-cost-cli

[![npm version](https://img.shields.io/npm/v/oci-cost-cli?color=cb3837&logo=npm)](https://www.npmjs.com/package/oci-cost-cli)
[![npm downloads](https://img.shields.io/npm/dm/oci-cost-cli?color=cb3837&logo=npm)](https://www.npmjs.com/package/oci-cost-cli)
[![CI](https://github.com/abruption/oci-cost-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/abruption/oci-cost-cli/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![node](https://img.shields.io/node/v/oci-cost-cli?color=339933&logo=node.js)](https://www.npmjs.com/package/oci-cost-cli)
[![license](https://img.shields.io/npm/l/oci-cost-cli?color=blue)](LICENSE)

**Fast, readable OCI cost/usage/outbound-traffic summary across multiple tenancies — no OCI SDK, no Python `oci` CLI required.**

Reads the same `~/.oci/config` the official SDKs and CLI use, signs Usage API requests itself (OCI API Signature v1), and turns the response into a clean table instead of a wall of near-null JSON fields. Optional Telegram reports on a cron schedule.

</div>

---

```text
▸ DEFAULT  (ocid1.tenancy.oc1..aaaaa…, ap-chuncheon-1)
  SERVICE                SKU                             USAGE                    COST
  ---------------------  ------------------------------  -----------------------  --------
  Virtual Cloud Network  Outbound Data Transfer Zone 2   0.62 GB Months           0.00 SGD
  Compute                Standard - A1 - Memory          294 Gigabyte Per Hour    0.00 SGD
  Block Storage          Block Volume - Free             6.72 GB Months           0.00 SGD
  Compute                Standard - A1                   49 OCPU Per Hour         0.00 SGD
  outbound transfer:      0.619 GB

▸ US  (ocid1.tenancy.oc1..aaaaa…, us-phoenix-1)
  (no usage in this period)
  outbound transfer:      0.000 GB
```

---

## Why

OCI's Usage API (`request-summarized-usages`) is the only reliable way to check cost/usage without opening the console, but the raw response is painful to work with directly:

- Each line item has ~20 mostly-null fields, with the value scattered across `computedAmount`/`computedQuantity`/`currency`/`service`/`skuName`/…
- The same SKU commonly appears **multiple times in different currencies** for a single $0 free-tier line (e.g. once in `SGD`, once in `USD`) — naively summing them double-counts.
- You almost always want to check **more than one tenancy** at once (e.g. a Korea region + a US region on separate "Always Free" accounts), which means running the query twice and reconciling by hand.
- Unlike AWS, which has community tools like [`aws-cost-cli`](https://github.com/kilianc/aws-cost-cli), there is currently no equivalent for OCI on npm — only the official raw SDK client packages and a couple of unmaintained demo scripts.

`oci-cost-cli` exists to turn "run a Usage API call, hand-parse the JSON" into one readable command.

## Quick start

```bash
# Run once, no install — reads your existing ~/.oci/config
npx oci-cost-cli
```

```bash
# Scope to one profile, a specific month, or the previous month
npx oci-cost-cli --profile DEFAULT
npx oci-cost-cli --month 2026-06
npx oci-cost-cli --last-month

# Machine-readable output for scripting (--json is a shorthand for --output json)
npx oci-cost-cli --output json
npx oci-cost-cli --json
```

No separate auth setup — it reads the same `~/.oci/config` (`user`, `fingerprint`, `tenancy`, `region`, `key_file`) that the official OCI SDKs and CLI already use. If you have `oci setup config` working, `oci-cost-cli` works.

## Multiple tenancies at once

If your `~/.oci/config` has more than one `[SECTION]`, every profile is queried in parallel and shown separately — this is the actual use case that motivated the tool (a Korea-region "Always Free" tenancy and a separate US-region one):

```ini
[DEFAULT]
user=ocid1.user.oc1..aaaa...
fingerprint=aa:bb:cc:...
tenancy=ocid1.tenancy.oc1..aaaa...
region=ap-chuncheon-1
key_file=/home/you/.oci/oci_api_key.pem

[US]
user=ocid1.user.oc1..bbbb...
fingerprint=11:22:33:...
tenancy=ocid1.tenancy.oc1..bbbb...
region=us-phoenix-1
key_file=/home/you/.oci/oci_api_key_us.pem
```

```bash
npx oci-cost-cli                    # both profiles
npx oci-cost-cli --profile US       # just one (repeatable: --profile A --profile B)
```

A malformed profile (missing a required key) is reported and skipped — it won't block the other profiles from being queried.

## Free Tier guard

If you're running "Always Free" infrastructure, the thing you actually care about is usually *"did anything start costing money?"*, not the full itemized table:

```bash
npx oci-cost-cli --preset free-tier
```

```text
▸ DEFAULT  ✅ all items within Free Tier
▸ US       ✅ all items within Free Tier
```

If something starts incurring real cost, it's called out explicitly instead of being buried in a full table:

```text
▸ DEFAULT  ⚠️  1 item(s) outside Free Tier eligibility
  SERVICE  SKU            COST
  -------  -------------  --------
  Compute  Standard - A1  4.20 USD
```

Other built-in presets: `--preset compute`, `--preset storage`, `--preset network`. Combine with `--service <name>` (repeatable) for an arbitrary custom filter. Filtering happens on already-fetched data — it never triggers an extra API call.

## Machine-readable / agent-first output

`--output json` (alias: `--json`) prints the aggregated `lineItems` this tool already trusts — the same data the text table renders from:

```bash
npx oci-cost-cli --output json --profile DEFAULT
```

```json
[
  {
    "profile": "DEFAULT",
    "tenancy": "ocid1.tenancy.oc1..aaaa...",
    "region": "ap-chuncheon-1",
    "costApiFailed": false,
    "error": null,
    "outboundGB": 11.559428631747,
    "lineItems": [
      { "service": "Compute", "skuName": "Standard - A1", "unit": "OCPU Per Hour", "quantity": 689.48, "cost": 0, "currency": "SGD", "isFreeTierSku": false }
    ]
  }
]
```

Add `--raw` to also include the **unaggregated** USAGE/COST API responses this tool's aggregation is built from — for a consumer (e.g. an agent) that would rather apply its own logic than trust the heuristics documented below in "Aggregation caveats":

```bash
npx oci-cost-cli --output json --raw --profile DEFAULT
```

```json
[
  {
    "profile": "DEFAULT",
    "...": "... same fields as above ...",
    "raw": {
      "usage": [{ "service": "Compute", "skuName": "Standard - A1", "skuPartNumber": "B93297", "unit": "OCPU Per Hour", "computedQuantity": 689.48, "computedAmount": 0, "currency": null }],
      "cost": [{ "service": "Compute", "skuName": "Standard - A1", "skuPartNumber": "B93297", "unit": null, "computedQuantity": null, "computedAmount": 0, "currency": "SGD" }]
    }
  }
]
```

`--raw` has genuinely caught a real OCI quirk: some Cost API line items come back with a **blank-string** (not empty/absent) `currency`, which the aggregation layer correctly treats as "no cost data" (`cost: null`) — `raw` is what lets you see *why* a `lineItems` entry has a null cost instead of just the null.

`--raw` only affects `--output json`; it's a no-op in the default text output.

## Preview before you commit: --dry-run

Every command with a real side effect (sending a Telegram message, writing to the OS keyring/a config file, editing your crontab) supports `--dry-run`, so you (or an agent driving this CLI) can see exactly what would happen first:

```bash
npx oci-cost-cli report --preset free-tier --dry-run          # builds the message from real OCI data, never calls Telegram
npx oci-cost-cli config set-telegram --token x --chat-id y --dry-run   # reports keyring vs file, never writes
npx oci-cost-cli config clear --dry-run                        # reports what would be removed, never deletes
npx oci-cost-cli install-cron --cron "0 0 15 * *" --dry-run -- report  # reports the line that would be added, never touches crontab
```

## Telegram reports + cron

Credentials are stored once via the OS keyring (falling back to a `0600` config file when no keyring is available — the common case for a headless server cron job), so they never need to appear in your crontab or shell history:

```bash
# One-time setup (interactive, e.g. over SSH)
npx oci-cost-cli config set-telegram --token <bot-token> --chat-id <chat-id>
npx oci-cost-cli config show    # sanity-check — values are always masked
```

```bash
# Send a report right now, using the stored credential
npx oci-cost-cli report --preset free-tier
```

```bash
# Schedule it — installs a crontab line that invokes this exact command,
# idempotent (running it again won't create a duplicate line)
npx oci-cost-cli install-cron --cron "0 0 15 * *" -- report --preset free-tier
```

`--telegram-token`/`--telegram-chat-id` flags are also accepted directly on `report`, for one-off use without saving anything.

## Checking for updates

If installed globally (rather than run via `npx`, which always fetches the latest anyway), `update` checks npm for a newer release:

```bash
oci-cost-cli update              # check only — prints "already up to date" or the available version
oci-cost-cli update --apply           # actually run npm install -g to update
oci-cost-cli update --apply --dry-run # preview the exact npm command without running it
```

Bare `update` never touches your global npm packages — same `--dry-run`-by-default spirit as every other side-effecting subcommand. `--apply` is required to actually install.

## What this is (and isn't)

`oci-cost-cli` is a **companion** to the official `oci` CLI for a fast, human-readable check — not a replacement for full resource management. If you need anything beyond cost/usage reporting, reach for the official CLI or SDK.

## Aggregation caveats

- **Cost API failure is never silently reported as $0.** Unlike the Usage API (which throws on a non-200 response), OCI's Cost API can degrade to an empty result set on failure. When that happens, `oci-cost-cli` shows an explicit `⚠️ Cost API failed` warning instead of a bare `0.00`.
- **Currency handling**: when a SKU is reported in multiple currencies, USD is preferred; non-USD entries for that SKU are only summed together when no USD entry exists. Currencies are never summed together across different currencies.
- **Free Tier detection is cost-based, not name-based.** Some Always Free coverage (e.g. outbound transfer within the free allowance) never gets a distinguishing `"- Free"` SKU suffix — only `cost > 0` is treated as "outside Free Tier."
- **Outbound-transfer detection** is a case-insensitive substring match on `skuName` (`"outbound data transfer"`) — a heuristic that matches OCI's current SKU naming, not a guaranteed-stable API contract.

## Security notes

- Telegram bot token/chat ID: OS keyring first (macOS Keychain / Linux Secret Service via [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring)), falling back to `~/.config/oci-cost-cli/config.json` with `0600`/`0700` permissions — the same trust model as `~/.aws/credentials` or `~/.npmrc`, not application-level encryption (a cipher whose key must also live on disk for unattended cron access provides no real additional security over plain file permissions).
- `~/.oci/config` private keys are read as-is; encrypted keys (`pass_phrase` set) are not yet supported.

## License

MIT
