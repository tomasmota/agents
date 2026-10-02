// Automatic handoff to a fresh session at a context threshold.
//
// Long sessions get expensive and the model gets less reliable as the context
// grows. This plugin watches each session's real request size and, once it
// crosses a threshold, asks the *current* agent to do a handoff with the
// existing `handoff` skill. The skill owns every mechanic — the document, model
// resolution, session creation, pane attach — and the plugin owns only the
// measurement and the trigger. An automatic handoff carries no new direction
// from the user, because the user is not there to give any.
//
// Sequence, repeated on every model request of every session:
//   1. the "context" model-request hook measures system + tools + messages
//   2. still below threshold -> remember the size and wait for the next request
//      (a session that starts small only crosses later, so the watch never ends
//      after the first request)
//   3. over threshold -> reserve one durable record for the session, then one
//      steer: "do a handoff with the handoff skill, continuing this same work,
//      then stop"
//
// The plugin never creates a session, submits a prompt, or touches tmux. Each
// session is reserved before steering. This guards concurrent requests within
// this instance and reloads with working storage; it is not a distributed lock.
//
// The size is an estimate of the assembled request (OpenCode estimates prompt
// text at about four characters per token, with flat estimates for media), not
// a provider billing count. It slightly overestimates, which is the safe
// direction for a guard.
//
// Options (plugin options take precedence):
//   threshold   context tokens that trigger a handoff, default 250000
//               (env OPENCODE_HANDOFF_THRESHOLD)

import { Plugin } from "@opencode/plugin"

const DEFAULT_THRESHOLD = 250_000
const CHARS_PER_TOKEN = 4
const IMAGE_TOKENS = 1_500
const PDF_TOKENS = 2_000

function recordOf(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null
}

function estimateText(value) {
  return typeof value === "string" ? Math.ceil(value.length / CHARS_PER_TOKEN) : 0
}

function estimateMedia(media) {
  const mime = typeof media?.mediaType === "string" ? media.mediaType : ""
  if (mime.startsWith("image/")) return IMAGE_TOKENS
  if (mime === "application/pdf") return PDF_TOKENS
  return IMAGE_TOKENS
}

function estimateContent(content) {
  if (!Array.isArray(content)) return 0
  return content.reduce((sum, part) => {
    const item = recordOf(part)
    if (!item) return sum
    if (item.type === "media") return sum + estimateMedia(item.media)
    if (item.type === "effort") return sum
    if (item.type === "tool-call" || item.type === "tool-use")
      return sum + estimateText(item.name) + estimateText(JSON.stringify(item.input ?? {}))
    if (item.result?.type === "content" && Array.isArray(item.result.value))
      return (
        sum +
        item.result.value.reduce(
          (inner, entry) => inner + (recordOf(entry)?.type === "text" ? estimateText(entry.text) : estimateMedia(entry)),
          0,
        )
      )
    return sum + estimateText(item.text)
  }, 0)
}

function estimateTools(tools) {
  if (!recordOf(tools)) return 0
  return Object.entries(tools).reduce(
    (sum, [name, tool]) =>
      sum +
      estimateText(name) +
      estimateText(tool?.description) +
      estimateText(JSON.stringify(tool?.input ?? {})),
    0,
  )
}

// The size of one assembled model request: system instructions, tool schemas, and messages.
export function requestTokens(event) {
  const request = recordOf(event)
  if (!request) return 0
  const system = Array.isArray(request.system)
    ? request.system.reduce((sum, part) => sum + estimateText(recordOf(part)?.text), 0)
    : 0
  const messages = Array.isArray(request.messages)
    ? request.messages.reduce((sum, message) => sum + estimateContent(recordOf(message)?.content), 0)
    : 0
  return system + estimateTools(request.tools) + messages
}

function numberOption(value, min, fallback) {
  const parsed = typeof value === "string" ? Number(value) : value
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback
}

export function thresholdOf(options = {}, env = process.env) {
  return numberOption(options.threshold ?? env.OPENCODE_HANDOFF_THRESHOLD, 10_000, DEFAULT_THRESHOLD)
}

// The steer the current agent receives. It points at the user's own skill
// instead of restating any mechanics: the skill decides the document path, the
// model, how the next session is created, and how the user is attached to it.
export function handoffInstruction({ threshold, tokens }) {
  return [
    `Context for this session has reached ${Math.round(tokens)} tokens (handoff threshold ${threshold}).`,
    "Stop working on the task and do a handoff with the handoff skill now: write the handoff document and spawn the next session with it as the first prompt, following that skill in full.",
    "The handoff continues this same work with no new direction from the user: record the current state, decisions, and next actions so a fresh agent can continue.",
    "Then stop. Do not continue the task in this session.",
  ].join("\n")
}

// Durable state, one record per session, keyed by the session itself.
//
// The key's presence is the whole dedupe check, so it needs exactly one read
// and no reconstruction: no scan to read with the wrong shape, no capped list
// that eventually forgets an old session and re-steers it, and no
// read-modify-write window in which one session's write drops another's.
const RECORD_PREFIX = "handoff/"

// Older versions kept every handed-off session in one capped array under this
// key, and the cap did drop old entries. It is still read, so upgrading cannot
// re-steer a session that was already handed off; it is never written, rewritten
// or deleted again, so there is no migration to undo.
const LEGACY_KEY = "handoffs"

function recordKey(sessionID) {
  return `${RECORD_PREFIX}${sessionID}`
}

// A key that exists means this session was already steered. Absence is
// `undefined`, per the `Json | undefined` read contract, so anything else
// counts as stored: wrongly believing a session was steered costs one handoff,
// wrongly believing it was not re-steers a session that already handed off.
function recorded(value) {
  return value !== undefined
}

// One threshold decision per model request. Returns what the monitor did, so
// tests can assert on it without a server.
export function check(monitor, event) {
  const request = recordOf(event)
  if (!monitor || monitor.state.status !== "watching") return "skip"
  const tokens = requestTokens(request)
  monitor.state.tokens = tokens
  // The status flips synchronously, before this returns and before any caller
  // awaits, so a request that arrives while the steer is still in flight is
  // already "skip".
  if (tokens < monitor.threshold) return "below"
  monitor.state.status = "requested"
  return "over"
}

export function createMonitor(config) {
  const state = {
    status: "watching",
    tokens: 0,
    sessionID: undefined,
    error: undefined,
  }
  const monitor = { config, threshold: config.threshold, state }

  function log(...args) {
    if (typeof config.log === "function") config.log(...args)
  }

  function timestamp() {
    return typeof config.now === "function" ? config.now() : new Date().toISOString()
  }

  const active = () => state.status !== "disposed" && (config.active?.() ?? true)

  // Reserve before attempting the steer. A crash between these two operations
  // can lose a steer, deliberately preferring that to a duplicate successor.
  async function remember(entry) {
    try {
      await config.storage.set(recordKey(entry.sessionID), {
        sessionID: entry.sessionID,
        tokens: entry.tokens,
        at: timestamp(),
      })
      return true
    } catch (error) {
      log("could not record handoff:", String(recordOf(error)?.message ?? error).slice(0, 200))
      return false
    }
  }

  async function legacySessions() {
    try {
      const list = await config.storage.get(LEGACY_KEY)
      if (!Array.isArray(list)) return new Set()
      return new Set(list.map((item) => recordOf(item)?.sessionID).filter((id) => typeof id === "string" && id !== ""))
    } catch {
      return new Set()
    }
  }

  async function isHandled(sessionID) {
    if (typeof sessionID !== "string" || sessionID === "") return false
    if ((await legacySessions()).has(sessionID)) return true
    try {
      return recorded(await config.storage.get(recordKey(sessionID)))
    } catch {
      // Best effort: a read outage can prevent restart deduplication.
      return false
    }
  }

  // Runs at most once per monitor, before any measurement. A session that
  // already has a record is parked instead of being steered again later.
  let admitted = null
  function admit(event) {
    const request = recordOf(event)
    if (typeof request?.sessionID === "string") state.sessionID = request.sessionID
    admitted ??= isHandled(state.sessionID).then((handled) => {
      if (handled && active()) {
        log(`${state.sessionID} already handed off`)
        state.status = "handled"
      }
      return handled
    })
    return admitted
  }

  // Every request is measured, not just the first one: a session that starts
  // small only crosses the threshold several turns later.
  async function observe(event) {
    await admit(event)
    if (!active()) return "skip"
    return check(monitor, event)
  }

  async function trigger() {
    if (!active() || state.status !== "requested") return "skip"
    state.status = "reserving"
    const { sessionID, tokens } = state
    await remember({ sessionID, tokens })
    if (!active()) return "skip"
    await config.session.synthetic({
      sessionID,
      text: handoffInstruction({ threshold: monitor.threshold, tokens }),
      description: "auto-handoff",
    })
    if (active()) state.status = "done"
    return "done"
  }

  const dispose = () => { state.status = "disposed" }
  return { observe, admit, check, trigger, dispose, isHandled, remember, state, threshold: monitor.threshold }
}

const testHelpers = {
  check,
  createMonitor,
  estimateContent,
  estimateText,
  handoffInstruction,
  recordKey,
  requestTokens,
  thresholdOf,
  LEGACY_KEY,
  RECORD_PREFIX,
}

export const AutoHandoffPlugin = Plugin.define({
  id: "tomas.auto-handoff",
  async setup(ctx) {
    // Plugin setup is location-scoped. Never share another location's monitor,
    // session client, threshold, or cleanup through a module-global map.
    const monitors = new Map()
    let active = true
    const threshold = thresholdOf(ctx.options)
    const log = (message, detail) => console.error(`auto-handoff: ${message}${detail ? ` ${detail}` : ""}`)
    const registration = await ctx.session.hook("context", async (event) => {
      if (!active) return
      const sessionID = recordOf(event)?.sessionID
      if (typeof sessionID !== "string" || sessionID === "") return
      // Created on the session's first request, then reused: a monitor is never
      // treated as a reason to stop watching the session.
      let monitor = monitors.get(sessionID)
      if (!monitor) {
        monitor = createMonitor({ threshold, session: ctx.session, storage: ctx.storage, log, active: () => active })
        monitors.set(sessionID, monitor)
      }
      if ((await monitor.observe(event)) !== "over") return
      try {
        await monitor.trigger()
      } catch (error) {
        if (!active) return
        monitor.state.status = "failed"
        monitor.state.error = String(recordOf(error)?.message ?? error).slice(0, 300)
        log(`failed (${monitor.state.error})`)
      }
    })
    return async () => {
      // Drop the in-memory monitors and unregister the hook. The durable
      // records are what survive, so a reload re-reads them rather than
      // re-steering.
      active = false
      for (const monitor of monitors.values()) monitor.dispose()
      monitors.clear()
      await registration?.dispose?.()
    }
  },
})

AutoHandoffPlugin.__test = () => testHelpers

export default AutoHandoffPlugin
