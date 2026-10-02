// Automatic handoff to a fresh session at a context threshold.
//
// Long sessions get expensive and the model gets less reliable as the context
// grows. This plugin watches each session's real request size and, once it
// crosses a threshold, asks the *current* agent to write a handoff document with
// the existing `handoff` skill, then starts a fresh session whose first prompt
// is that document. The successor continues the same work: an automatic handoff
// carries no new direction from the user, because the user is not there to give
// any.
//
// Sequence:
//   1. the "context" model-request hook measures system + tools + messages
//   2. over threshold -> one steer: "use the handoff skill, write the document
//      to <path>, document-only mode, then stop and wait"
//   3. when that session goes idle, the plugin reads the document
//   4. a new session is created in the same directory with the same agent and
//      model, and the document is submitted as its first prompt
//   5. the old session is told to run the tmux split that attaches the new
//      session to a pane, then to stop
//
// The document is written in a temp directory, never in the worktree, and stays
// on disk as a fallback. Nothing is lost if a step fails: the old session keeps
// working and the document is still readable.
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

import { open } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const DEFAULT_THRESHOLD = 250_000
const CHARS_PER_TOKEN = 4
const IMAGE_TOKENS = 1_500
const PDF_TOKENS = 2_000
const CHUNK_BYTES = 65_536
/** A handoff document is prose; anything larger is not one, and the read stays bounded. */
const MAX_DOCUMENT_BYTES = 1_000_000
const FILE_WAIT_MS = 300_000
const FILE_POLL_MS = 2_000

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
// instead of restating the document format, and forbids spawning anything: the
// plugin owns session creation and the tmux pane.
export function handoffInstruction({ sessionID, threshold, tokens, documentPath }) {
  return [
    `Context for this session has reached ${Math.round(tokens)} tokens (handoff threshold ${threshold}).`,
    "Stop working on the task and use the handoff skill in document-only mode: write the handoff document and nothing else.",
    `Write it to exactly ${documentPath}.`,
    "The handoff continues this same work with no new direction from the user: record the current state, decisions, and next actions so a fresh agent can continue.",
    "Do not create or spawn a session, do not touch tmux, and do not write the document anywhere else.",
    "Then stop and wait. Do not continue the task in this session.",
  ].join("\n")
}

export function paneInstruction({ sessionID, directory, documentPath }) {
  const pane = `tmux split-window -h -c ${shellQuote(directory)} -t "$TMUX_PANE" opencode --session ${sessionID}`
  return [
    `The handoff document is at ${documentPath} and a new session (${sessionID}) has been created with it as its first prompt. It is already running.`,
    "Attach the user to it the way this client supports, then stop:",
    `- Inside tmux (\${TMUX:-} is set), run exactly: ${pane}`,
    "- Outside tmux, for example in OpenChamber or a plain terminal, run no tmux command: the new session already exists and is listed in this client. Report its ID and the document path instead.",
    "Do not continue the task in this session.",
  ].join("\n")
}

function shellQuote(value) {
  const raw = String(value ?? "")
  if (raw && /^[A-Za-z0-9_@%+=:,./-]+$/.test(raw)) return raw
  return `'${raw.replaceAll("'", `'\\''`)}'`
}

const KEY = "handoffs"

function refOf(model) {
  const ref = recordOf(model)
  if (!ref || typeof ref.providerID !== "string" || typeof ref.id !== "string") return undefined
  return typeof ref.variant === "string" && ref.variant !== ""
    ? { providerID: ref.providerID, id: ref.id, variant: ref.variant }
    : { providerID: ref.providerID, id: ref.id }
}

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
    completing: false,
    tokens: 0,
    sessionID: undefined,
    directory: undefined,
    documentPath: undefined,
    successorID: undefined,
    error: undefined,
  }
  const monitor = { config, threshold: config.threshold, state }

  function log(...args) {
    if (typeof config.log === "function") config.log(...args)
  }

  function fail(error) {
    const message = String(recordOf(error)?.message ?? error).slice(0, 300)
    state.status = "failed"
    state.error = message
    log("auto-handoff failed:", message)
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

  async function info(sessionID) {
    const result = await config.session.get({ sessionID })
    return recordOf(recordOf(result)?.data ?? result)
  }

  async function ask() {
    if (state.status !== "requested") return
    const { sessionID, documentPath } = state
    if (await isHandled(sessionID)) {
      log(`auto-handoff: ${sessionID} already handed off`)
      return
    }
    state.status = "writing"
    const text = handoffInstruction({ sessionID, threshold: monitor.threshold, tokens: state.tokens, documentPath })
    await config.session.synthetic({ sessionID, text, description: "auto-handoff" })
  }

  async function readDocument(pathname) {
    const handle = await config.fs.open(pathname, "r")
    try {
      const chunks = []
      let size = 0
      while (size < MAX_DOCUMENT_BYTES) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, MAX_DOCUMENT_BYTES - size))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (!Number.isFinite(bytesRead) || bytesRead <= 0) break
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
        size += bytesRead
      }
      return Buffer.concat(chunks).toString("utf8")
    } finally {
      await handle.close()
    }
  }

  // Runs when the old session goes idle: the document should exist by then.
  // Single-flight: the event stream invokes this unawaited for every event,
  // and concurrent callers would each pass the status check before the first
  // await and create their own successor session. Every exit path below sets
  // a terminal status, so the flag never needs clearing.
  async function complete() {
    if (state.status !== "writing" || state.completing) return
    state.completing = true
    const ready = await waitForDocument(state.documentPath, config.fs, {
      timeout: config.waitTimeout,
      interval: config.waitInterval,
    })
    if (ready !== true) {
      log(`auto-handoff: no document at ${state.documentPath}; leaving ${state.sessionID} alone`)
      state.status = "idle"
      return
    }
    const document = await readDocument(state.documentPath)
    if (document.trim() === "") {
      log(`auto-handoff: empty document at ${state.documentPath}; leaving ${state.sessionID} alone`)
      state.status = "idle"
      return
    }
    state.status = "starting"
    const model = refOf(state.model)
    const input = {
      title: `Handoff: ${state.sessionID}`,
      location: { directory: state.directory },
      ...(state.agent ? { agent: state.agent } : {}),
      ...(model ? { model } : {}),
    }
    const created = await config.session.create(input)
    const successor = recordOf(recordOf(created)?.data ?? created)
    const successorID = typeof successor?.id === "string" ? successor.id : undefined
    if (!successorID) throw new Error("session.create returned no id")
    state.successorID = successorID
    await config.session.prompt({ sessionID: successorID, text: document })
    await remember({ sessionID: state.sessionID, successorID, documentPath: state.documentPath, tokens: state.tokens })
    state.status = "done"
    await config.session.synthetic({
      sessionID: state.sessionID,
      text: paneInstruction({ sessionID: successorID, directory: state.directory, documentPath: state.documentPath }),
      description: "auto-handoff",
    })
  }

  async function start(event) {
    const request = recordOf(event)
    state.sessionID = request.sessionID
    if (await isHandled(request.sessionID)) {
      log(`auto-handoff: ${request.sessionID} already handed off`)
      state.status = "handled"
      return
    }
    const session = await info(request.sessionID)
    state.agent = typeof session?.agent === "string" ? session.agent : undefined
    state.model = session?.model
    state.directory = typeof session?.location?.directory === "string" ? session.location.directory : config.directory
    state.documentPath = config.documentPath(request.sessionID)
    await ask()
  }

  async function dispose() {
    monitors.delete(state.sessionID)
  }

  return { check, start, complete, ask, dispose, state, threshold: monitor.threshold, isHandled, remember, readDocument, info }
}

// Waits for the document to appear and stop growing. Returns undefined on timeout.
export async function waitForDocument(pathname, fs, options = {}) {
  const timeout = options.timeout ?? FILE_WAIT_MS
  const interval = options.interval ?? FILE_POLL_MS
  const deadline = Date.now() + timeout
  let previous = -1
  while (Date.now() < deadline) {
    const handle = await fs.open(pathname, "r").catch(() => undefined)
    if (handle) {
      let size = 0
      try {
        size = (await handle.stat()).size
      } catch {
        size = 0
      } finally {
        await handle.close().catch(() => {})
      }
      if (size > 0 && size === previous) return true
      previous = size
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return undefined
}

function documentPathFor(sessionID) {
  return path.join(os.tmpdir(), "opencode", `handoff-auto-${sessionID}.md`)
}

const testHelpers = {
  check,
  createMonitor,
  documentPathFor,
  estimateContent,
  estimateText,
  handoffInstruction,
  paneInstruction,
  requestTokens,
  shellQuote,
  thresholdOf,
  waitForDocument,
}

export const AutoHandoffPlugin = Plugin.define({
  id: "tomas.auto-handoff",
  async setup(ctx) {
    const threshold = thresholdOf(ctx.options)
    const documentPath = (sessionID) => documentPathFor(sessionID)
    const controller = new AbortController()
    const loop = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const monitor = monitors.get(event?.data?.sessionID)
        if (monitor === undefined) continue
        // Never awaited here: waiting for a document must not stall the event
        // stream for other sessions.
        void monitor.complete().catch((error) => {
          monitor.state.status = "failed"
          monitor.state.error = String(error?.message ?? error).slice(0, 300)
          console.error(`auto-handoff failed (${monitor.state.error})`)
        })
      }
    })()
    await ctx.session.hook("context", async (event) => {
      if (monitors.has(event.sessionID)) return
      const monitor = createMonitor({
        threshold,
        session: ctx.session,
        storage: ctx.storage,
        directory: ctx.location.directory,
        documentPath,
        fs: { open },
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
      controller.abort()
      await loop.catch(() => {})
      monitors.clear()
    }
  },
})

AutoHandoffPlugin.__test = () => testHelpers

export default AutoHandoffPlugin
