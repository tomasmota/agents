// Reactive fallback signal: a provider that just failed with a quota error is treated as low
// for a while. It is the backup for providers whose quota source returns no reading (no source
// on this machine, failing, or stale); a reading taken after the failure always wins.

export const EXHAUSTED_BASE_MS = 30 * 60_000
export const EXHAUSTED_MAX_MS = 6 * 60 * 60_000

const QUOTA_ERROR_TYPE = "provider.quota"
const QUOTA_MESSAGE =
  /usage limit|insufficient[_ ]quota|quota (?:has been |was )?(?:exceeded|exhausted)|(?:exceeded|exhausted) (?:your )?(?:current )?quota|hit your (?:usage )?limit/i

// Plain rate limits (`provider.rate-limit`) are transient and must not count.
export function isQuotaFailure(error) {
  if (!error || typeof error !== "object") return false
  if (error.type === QUOTA_ERROR_TYPE) return true
  return error.type !== "provider.rate-limit" && typeof error.message === "string" && QUOTA_MESSAGE.test(error.message)
}

const validEntry = (entry) =>
  entry !== null &&
  typeof entry === "object" &&
  [entry.detectedAt, entry.until, entry.windowMs].every(Number.isFinite) &&
  entry.until > entry.detectedAt

// A failure while the window is open changes nothing. Failing again soon after the window
// closed means the limit persists, so the next window doubles up to the cap.
export function nextExhausted(previous, now = Date.now()) {
  if (validEntry(previous) && now < previous.until) return previous
  const again = validEntry(previous) && now - previous.until <= previous.windowMs
  const windowMs = again ? Math.min(previous.windowMs * 2, EXHAUSTED_MAX_MS) : EXHAUSTED_BASE_MS
  return { detectedAt: now, until: now + windowMs, windowMs }
}

// Drops entries a newer quota reading supersedes, and expired ones once they no longer inform
// the next window. Returns the kept entries and the providers whose window is still open.
export function settleExhausted(entries, quota, now = Date.now()) {
  const kept = {}
  const active = new Set()
  for (const [provider, entry] of Object.entries(entries ?? {})) {
    if (!validEntry(entry)) continue
    if (quota?.[provider]?.checkedAt > entry.detectedAt) continue
    if (now >= entry.until + entry.windowMs) continue
    kept[provider] = entry
    if (now < entry.until) active.add(provider)
  }
  return { entries: kept, active }
}

// Shared by every plugin instance in this process; other processes exchange it through the state file.
const shared = (globalThis[Symbol.for("tomas.agent-routes.exhausted")] ??= { entries: {}, listeners: new Set() })

export function exhaustedSnapshot() {
  return { ...shared.entries }
}

export function mergeExhausted(raw) {
  for (const [provider, entry] of Object.entries(raw ?? {})) {
    if (validEntry(entry) && entry.detectedAt > (shared.entries[provider]?.detectedAt ?? 0)) shared.entries[provider] = entry
  }
}

export function settleSharedExhausted(quota, now = Date.now()) {
  const { entries, active } = settleExhausted(shared.entries, quota, now)
  shared.entries = entries
  return active
}

// Returns true when this opened a new window.
export function recordExhausted(provider, now = Date.now()) {
  const previous = shared.entries[provider]
  const next = nextExhausted(previous, now)
  if (next === previous) return false
  shared.entries[provider] = next
  for (const listener of shared.listeners) listener(provider)
  return true
}

export function onExhausted(listener) {
  shared.listeners.add(listener)
  return () => shared.listeners.delete(listener)
}

export function resetSharedExhausted() {
  shared.entries = {}
  shared.listeners.clear()
}
