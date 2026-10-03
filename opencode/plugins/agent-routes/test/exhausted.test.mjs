import assert from "node:assert/strict"
import test from "node:test"

import {
  EXHAUSTED_BASE_MS,
  EXHAUSTED_MAX_MS,
  exhaustedSnapshot,
  isQuotaFailure,
  mergeExhausted,
  nextExhausted,
  onExhausted,
  recordExhausted,
  resetSharedExhausted,
  settleExhausted,
  settleSharedExhausted,
} from "../lib/exhausted.js"

const T0 = 1_000_000_000_000

test("classifies quota failures and ignores transient rate limits", () => {
  assert.equal(isQuotaFailure({ type: "provider.quota", message: "" }), true)
  assert.equal(isQuotaFailure({ type: "unknown", message: "The usage limit has been reached" }), true)
  assert.equal(isQuotaFailure({ type: "provider.invalid-request", message: "You exceeded your current quota" }), true)
  assert.equal(isQuotaFailure({ type: "unknown", message: "insufficient_quota" }), true)
  assert.equal(isQuotaFailure({ type: "unknown", message: "You've hit your limit" }), true)
  assert.equal(isQuotaFailure({ type: "provider.rate-limit", status: 429, message: "usage limit reached for this minute" }), false)
  assert.equal(isQuotaFailure({ type: "provider.rate-limit", message: "Rate limit reached for requests per minute" }), false)
  assert.equal(isQuotaFailure({ type: "provider.auth", message: "invalid key" }), false)
  assert.equal(isQuotaFailure({ type: "provider.transport", message: "socket closed" }), false)
  assert.equal(isQuotaFailure({ type: "unknown" }), false)
  assert.equal(isQuotaFailure(undefined), false)
  assert.equal(isQuotaFailure("usage limit"), false)
})

test("opens a window, ignores failures inside it and doubles when the limit persists", () => {
  const first = nextExhausted(undefined, T0)
  assert.deepEqual(first, { detectedAt: T0, until: T0 + EXHAUSTED_BASE_MS, windowMs: EXHAUSTED_BASE_MS })

  assert.equal(nextExhausted(first, T0 + 60_000), first, "a failure inside the window changes nothing")

  const soon = T0 + EXHAUSTED_BASE_MS + 1_000
  const second = nextExhausted(first, soon)
  assert.equal(second.windowMs, EXHAUSTED_BASE_MS * 2)
  assert.equal(second.until, soon + EXHAUSTED_BASE_MS * 2)

  const late = first.until + first.windowMs + 1
  assert.equal(nextExhausted(first, late).windowMs, EXHAUSTED_BASE_MS, "a long quiet period starts over")

  let entry = first
  for (let i = 0; i < 12; i++) entry = nextExhausted(entry, entry.until + 1)
  assert.equal(entry.windowMs, EXHAUSTED_MAX_MS)
})

test("an invalid previous entry is replaced by a fresh window", () => {
  assert.equal(nextExhausted({ detectedAt: "x", until: 1, windowMs: 1 }, T0).windowMs, EXHAUSTED_BASE_MS)
  assert.equal(nextExhausted({ detectedAt: T0, until: T0 - 1, windowMs: 1 }, T0).windowMs, EXHAUSTED_BASE_MS)
})

test("a newer quota reading supersedes the failure, an older one does not", () => {
  const entry = { detectedAt: T0, until: T0 + EXHAUSTED_BASE_MS, windowMs: EXHAUSTED_BASE_MS }
  const now = T0 + 60_000

  const unknown = settleExhausted({ openai: entry }, {}, now)
  assert.deepEqual([...unknown.active], ["openai"])
  assert.deepEqual(unknown.entries, { openai: entry })

  const older = settleExhausted({ openai: entry }, { openai: { fiveHourLeft: 90, checkedAt: T0 - 1 } }, now)
  assert.deepEqual([...older.active], ["openai"])

  const newer = settleExhausted({ openai: entry }, { openai: { fiveHourLeft: 90, checkedAt: T0 + 1 } }, now)
  assert.equal(newer.active.size, 0)
  assert.deepEqual(newer.entries, {}, "a superseded entry is dropped so it cannot return when the reading goes stale")

  const other = settleExhausted({ openai: entry }, { "claude-subscription": { fiveHourLeft: 90, checkedAt: T0 + 1 } }, now)
  assert.deepEqual([...other.active], ["openai"], "readings are per provider")
})

test("an expired entry keeps informing the next window, then goes away", () => {
  const entry = { detectedAt: T0, until: T0 + EXHAUSTED_BASE_MS, windowMs: EXHAUSTED_BASE_MS }
  const expired = settleExhausted({ openai: entry }, {}, entry.until + 1)
  assert.equal(expired.active.size, 0)
  assert.deepEqual(expired.entries, { openai: entry })

  const gone = settleExhausted({ openai: entry }, {}, entry.until + entry.windowMs)
  assert.deepEqual(gone.entries, {})

  const invalid = settleExhausted({ openai: { until: "soon" }, claude: null }, {}, T0)
  assert.deepEqual(invalid.entries, {})
})

test("the shared registry merges newer entries, notifies on a new window and settles", () => {
  resetSharedExhausted()
  const seen = []
  const stop = onExhausted((provider) => seen.push(provider))

  assert.equal(recordExhausted("openai", T0), true)
  assert.equal(recordExhausted("openai", T0 + 1_000), false, "inside the open window")
  assert.deepEqual(seen, ["openai"])

  const newer = { detectedAt: T0 + 5_000, until: T0 + 5_000 + EXHAUSTED_BASE_MS, windowMs: EXHAUSTED_BASE_MS }
  mergeExhausted({ openai: { detectedAt: T0 - 1, until: T0 + 10, windowMs: 10 }, claude: newer, junk: "x" })
  assert.equal(exhaustedSnapshot().openai.detectedAt, T0, "an older entry never replaces a newer one")
  assert.deepEqual(exhaustedSnapshot().claude, newer)
  assert.equal("junk" in exhaustedSnapshot(), false)

  assert.deepEqual([...settleSharedExhausted({ openai: { checkedAt: T0 + 1 } }, T0 + 2_000)], ["claude"])
  assert.equal("openai" in exhaustedSnapshot(), false)

  stop()
  recordExhausted("later", T0)
  assert.deepEqual(seen, ["openai"], "a stopped listener is not called")
  resetSharedExhausted()
})
