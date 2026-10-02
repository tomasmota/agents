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
// Sequence:
//   1. the "context" model-request hook measures system + tools + messages
//   2. over threshold -> one steer: "do a handoff with the handoff skill,
//      continuing this same work, then stop"
//
// The plugin never creates a session, submits a prompt, or touches tmux. Each
// session is steered at most once, recorded in plugin storage, so a server
// restart cannot cause a second steer.
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

const KEY = "handoffs"

const monitors = new Map()

// One threshold decision per model request. Returns what the monitor did, so
// tests can assert on it without a server.
export function check(monitor, event) {
  const request = recordOf(event)
  if (!monitor || monitor.state.status !== "watching") return "skip"
  const tokens = requestTokens(request)
  if (tokens < monitor.threshold) {
    monitor.state.tokens = tokens
    return "below"
  }
  monitor.state.status = "requested"
  monitor.state.tokens = tokens
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

  async function remember(entry) {
    try {
      const page = await config.storage.scan({ prefix: KEY, limit: 100 })
      const kept = [entry, ...(page?.items ?? []).filter((item) => recordOf(item)?.sessionID !== entry.sessionID)].slice(0, 100)
      await config.storage.set(KEY, kept)
    } catch (error) {
      log("auto-handoff could not record handoff:", String(recordOf(error)?.message ?? error).slice(0, 200))
    }
  }

  async function isHandled(sessionID) {
    try {
      const stored = await config.storage.get(KEY)
      return Array.isArray(stored) && stored.some((item) => recordOf(item)?.sessionID === sessionID)
    } catch {
      return false
    }
  }

  async function ask() {
    if (state.status !== "requested") return
    const { sessionID } = state
    if (await isHandled(sessionID)) {
      log(`auto-handoff: ${sessionID} already handed off`)
      return
    }
    const text = handoffInstruction({ threshold: monitor.threshold, tokens: state.tokens })
    await config.session.synthetic({ sessionID, text, description: "auto-handoff" })
    await remember({ sessionID, tokens: state.tokens })
    state.status = "done"
  }

  async function start(event) {
    const request = recordOf(event)
    state.sessionID = request.sessionID
    if (await isHandled(request.sessionID)) {
      log(`auto-handoff: ${request.sessionID} already handed off`)
      state.status = "handled"
      return
    }
    await ask()
  }

  function dispose() {
    monitors.delete(state.sessionID)
  }

  return { check, start, ask, dispose, state, threshold: monitor.threshold, isHandled, remember }
}

const testHelpers = {
  check,
  createMonitor,
  estimateContent,
  estimateText,
  handoffInstruction,
  requestTokens,
  thresholdOf,
}

export const AutoHandoffPlugin = Plugin.define({
  id: "tomas.auto-handoff",
  async setup(ctx) {
    const threshold = thresholdOf(ctx.options)
    await ctx.session.hook("context", async (event) => {
      if (monitors.has(event.sessionID)) return
      const monitor = createMonitor({
        threshold,
        session: ctx.session,
        storage: ctx.storage,
        log: (message, detail) => console.error(`auto-handoff: ${message}${detail ? ` ${detail}` : ""}`),
      })
      monitors.set(event.sessionID, monitor)
      if (check(monitor, event) !== "over") return
      try {
        await monitor.start(event)
      } catch (error) {
        monitor.state.status = "failed"
        monitor.state.error = String(error?.message ?? error).slice(0, 300)
        console.error(`auto-handoff failed (${monitor.state.error})`)
      }
    })
    return async () => {
      monitors.clear()
    }
  },
})

AutoHandoffPlugin.__test = () => testHelpers

export default AutoHandoffPlugin
