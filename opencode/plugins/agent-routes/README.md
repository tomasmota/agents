# agent-routes

Generates OpenCode agents from a routes file (`subagents.jsonc`), hot-reloads edits,
applies quota/availability fallbacks and enforces `when`-scoped permission rules.
Options: `routesFile`, `stateFile`, `quotaAdapter`.

## Fallbacks

A role's model is replaced by `fallbacks[provider]` when its provider is **low** or **not
configured** on this machine. A fallback without `#variant` keeps the role's variant. There is
no chaining: when the fallback provider is also low or unavailable, the configured model stays.
Unknown or stale quota never triggers a fallback.

A provider is low when its quota reading says so (`fiveHourLeft < quotaLow.fiveHour`, default
20, or `weeklyLeft < quotaLow.weekly`, default 10), or, as a backup, after a quota failure.

1. **Quota readings (primary).** The consumer supplies `quotaAdapter`, a module exporting
   `QUOTA_SOURCES`: provider ID to an async function returning
   `{ fiveHourLeft?, weeklyLeft?, checkedAt }` (percent left) or `undefined`. Credential
   discovery and quota clients stay in the consumer. Readings refresh every 5 minutes and are
   shared between processes through the state file.
2. **Quota failures (backup).** The plugin watches OpenCode's session `retry` hook, which sees
   every provider failure. A `provider.quota` failure (OpenCode's classification of
   "usage limit", `insufficient_quota` and similar), or a usage-limit style message that is not
   a plain rate limit, marks that provider low for 30 minutes. If it fails again soon after the
   window closes, the window doubles up to 6 hours. This only applies to providers that have a
   `fallbacks` entry and never changes OpenCode's own retry decision.
   A reading taken **after** the failure supersedes it, so a machine with a working quota
   source behaves as if the backup did not exist. Without a source for a provider (or while
   its source returns nothing), the marker is all there is: the request that hit the limit
   still fails, later calls use the fallback, and one call per window probes the original
   provider again.

State file (`stateFile`): `low`, `agents[id].fallbackFrom`, `quota`, and `exhausted`
(`{ [provider]: { detectedAt, until, windowMs } }`). Concurrent processes write it with an
atomic rename but without a lock: a marker written in the same instant as another process's
write can be lost, which the writing process repairs on its next sync (at most one extra
failed probe after a restart in that window).

## Tests

```sh
npm test
```
