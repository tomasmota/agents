// Auto-retitle sessions when focus changes.
//
// After a session goes idle, this plugin asks a cheap model whether the recent
// user messages show clearly different work than the current session title
// suggests. When they do, it renames the session. The bar is deliberately
// high: follow-ups, clarifications, and continuations keep the current title.
//
// A title the user set manually is never overwritten. The first externally
// observed title is treated as OpenCode's initial auto-title and adopted as
// the baseline; any later external title change opts that session out of
// automatic retitling. There is no per-session rename cap: every idle turn
// with new user messages is evaluated.
//
// Runtime configuration (plugin options take precedence):
//   model            "providerID/modelID#variant", default "openai/gpt-6-luna#low"
//                    (env OPENCODE_RETITLE_MODEL)
//   maxMessages      recent user messages sent to the judge, 1-10, default 3
//                    (env OPENCODE_RETITLE_MAX_MESSAGES)
//   userChars        total user-text budget for the judge, 200-10000, default 2000
//                    (env OPENCODE_RETITLE_USER_CHARS)

import { Plugin } from "@opencode/plugin"

const DEFAULT_MODEL_REF = "openai/gpt-6-luna#low"
const DEFAULT_MAX_MESSAGES = 3
const DEFAULT_USER_CHARS = 2000
const MAX_TITLE_CHARS = 80

function recordOf(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null
}

// "providerID/modelID#variant" -> { providerID, id, variant? }. The variant
// is required by OpenCode's own model rules only when the listing exposes it;
// gpt-6-luna does ("low"), so the default includes it.
function parseModelRef(value, fallback = DEFAULT_MODEL_REF) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback
  const [ref, variant] = raw.split("#")
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) {
    return parseModelRef(fallback === raw ? DEFAULT_MODEL_REF : fallback, DEFAULT_MODEL_REF)
  }
  const parsed = {
    providerID: ref.slice(0, slash),
    id: ref.slice(slash + 1),
  }
  if (variant) parsed.variant = variant
  return parsed
}

function numberOption(value, min, max, fallback) {
  const n = typeof value === "string" ? Number(value) : value
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback
}

function retitleConfig(options = {}, env = process.env) {
  return {
    model: parseModelRef(options.model ?? env.OPENCODE_RETITLE_MODEL),
    maxMessages: numberOption(
      options.maxMessages ?? env.OPENCODE_RETITLE_MAX_MESSAGES,
      1, 10, DEFAULT_MAX_MESSAGES,
    ),
    userChars: numberOption(
      options.userChars ?? env.OPENCODE_RETITLE_USER_CHARS,
      200, 10000, DEFAULT_USER_CHARS,
    ),
  }
}

function userTextOf(message) {
  const info = recordOf(message?.info) ?? recordOf(message) ?? {}
  if (info.type !== undefined && info.type !== "user") return ""
  if (typeof info.text === "string" && info.text.trim()) return info.text.trim()
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const text = parts
    .filter((part) => recordOf(part)?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
  return text
}

// Newest user turns that the judge sees, oldest first, within the char budget.
function recentUserTexts(messages, { maxMessages, userChars }) {
  if (!Array.isArray(messages)) return []
  const collected = []
  for (let i = messages.length - 1; i >= 0 && collected.length < maxMessages; i--) {
    const text = userTextOf(messages[i])
    if (!text) continue
    collected.unshift({ id: typeof messages[i]?.id === "string" ? messages[i].id : null, text })
  }
  let budget = userChars
  const fitted = []
  for (let i = collected.length - 1; i >= 0; i--) {
    if (budget <= 0) break
    const text = collected[i].text.slice(0, budget)
    budget -= text.length
    fitted.unshift({ ...collected[i], text })
  }
  return fitted.filter((entry) => entry.text.trim())
}

function buildJudgePrompt(title, excerpts) {
  const numbered = excerpts.map((entry, index) => `${index + 1}. ${entry.text}`).join("\n")
  return [
    "You maintain short titles for AI coding sessions.",
    `Current title: "${title}"`,
    "Recent user messages (oldest first):",
    numbered,
    "",
    "Decide: has the session's focus clearly changed to different work, so the current title is now misleading or stale?",
    "Be conservative: follow-ups, clarifications, error reports, and continuations of the same work mean NO change.",
    "Answer true only when the user has moved on to clearly different work.",
    'Respond with JSON only: {"needs_update": <boolean>, "title": "<proposed title>"}',
    `When needs_update is false, repeat the current title. When true, propose a different short title (max ${MAX_TITLE_CHARS} characters).`,
  ].join("\n")
}

function stripFences(text) {
  const match = String(text).match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return (match ? match[1] : String(text)).trim()
}

// Parsed judge verdict, or null when the response is unusable or asks for no
// effective change. Never throws.
function parseJudgeResponse(text, currentTitle) {
  let parsed
  try {
    parsed = JSON.parse(stripFences(text))
  } catch {
    return null
  }
  const rec = recordOf(parsed)
  if (!rec || typeof rec.needs_update !== "boolean") return null
  const title = typeof rec.title === "string" ? rec.title.trim() : ""
  if (!rec.needs_update) return { needs_update: false, title: currentTitle }
  if (!title || title.length > MAX_TITLE_CHARS) return null
  if (title.toLowerCase() === String(currentTitle).trim().toLowerCase()) return null
  return { needs_update: true, title }
}

function createRetitler({ config, generate, session, directory }) {
  const states = new Map()
  const inflight = new Map()
  let disposed = false

  const stateOf = (sessionID) => {
    let state = states.get(sessionID)
    if (!state) {
      state = { adopted: false, lastKnown: undefined, pending: undefined, lastKey: undefined, optedOut: false }
      states.set(sessionID, state)
      // Never evict a manual-rename opt-out while this instance is alive.
    }
    return state
  }

  // Tracks session.renamed. Our own rename is expected (pending); the first
  // external title is adopted as OpenCode's initial auto-title baseline; any
  // later external change is a manual rename and opts the session out.
  function renamed(sessionID, title) {
    if (disposed) return
    if (typeof sessionID !== "string" || typeof title !== "string") return
    const state = stateOf(sessionID)
    if (state.optedOut) return
    if (state.pending !== undefined && state.pending === title) {
      state.pending = undefined
      state.lastKnown = title
      return
    }
    // Our own rename observed after evaluate() already finished, or a
    // duplicate event: the title is already the known one.
    if (title === state.lastKnown) return
    if (!state.adopted) {
      state.adopted = true
      state.lastKnown = title
      return
    }
    state.optedOut = true
  }

  async function evaluate(sessionID) {
    if (disposed) return
    if (typeof sessionID !== "string" || sessionID === "") return
    if (inflight.has(sessionID)) return
    const work = run(sessionID).catch((error) => {
      console.error(`auto-retitle failed for ${sessionID} (${String(error?.message ?? error).slice(0, 200)})`)
    })
    inflight.set(sessionID, work)
    try {
      await work
    } finally {
      if (inflight.get(sessionID) === work) inflight.delete(sessionID)
    }
  }

  async function run(sessionID) {
    const state = stateOf(sessionID)
    if (state.optedOut) return
    const info = await session.get({ sessionID })
    if (disposed || info?.parentID || (directory && info?.location?.directory !== directory)) return
    const title = typeof info?.title === "string" ? info.title.trim() : ""
    if (!title) return
    // A title change we missed via events (e.g. plugin loaded late) follows
    // the same rule as renamed(): adopt the first, treat later ones as manual.
    if (state.pending === undefined && state.lastKnown !== undefined && title !== state.lastKnown) {
      if (!state.adopted) {
        state.adopted = true
      } else {
        state.optedOut = true
        return
      }
    }
    state.lastKnown = title
    if (!state.adopted) state.adopted = true
    const messages = await session.context({ sessionID })
    if (disposed || state.optedOut) return
    const excerpts = recentUserTexts(messages, config)
    if (excerpts.length === 0) return
    const key = `${title}\0${excerpts.map((entry) => entry.id ?? entry.text).join("\0")}`
    if (key === state.lastKey) return
    state.lastKey = key
    const response = await generate({ model: config.model, prompt: buildJudgePrompt(title, excerpts) })
    if (disposed || state.optedOut) return
    const verdict = parseJudgeResponse(response?.text, title)
    if (!verdict?.needs_update) return
    // A user can rename while the judge is awaiting I/O. Do not overwrite that
    // edit even if its event has not reached this instance yet.
    const latest = await session.get({ sessionID })
    if (disposed || state.optedOut || latest?.title?.trim() !== title) return
    state.pending = verdict.title
    try {
      await session.update({ sessionID, title: verdict.title })
      state.lastKnown = verdict.title
    } finally {
      if (state.pending === verdict.title) state.pending = undefined
    }
  }

  function dispose() {
    disposed = true
    states.clear()
    inflight.clear()
  }

  return { evaluate, renamed, dispose, states }
}

const testHelpers = {
  MAX_TITLE_CHARS,
  buildJudgePrompt,
  createRetitler,
  parseJudgeResponse,
  parseModelRef,
  recentUserTexts,
  retitleConfig,
}

export const AutoRetitlePlugin = Plugin.define({
  id: "tomas.auto-retitle",
  async setup(ctx) {
    const config = retitleConfig(ctx.options)
    const list = await ctx.model.list()
    const models = Array.isArray(list) ? list : list?.data ?? []
    const judge = models.find((model) => model.providerID === config.model.providerID && model.id === config.model.id)
    if (!judge || (config.model.variant && !(judge.variants ?? []).some((variant) => (variant.id ?? variant) === config.model.variant))) {
      throw new Error("auto-retitle judge model/variant unavailable; no fallback is configured")
    }
    const retitler = createRetitler({
      config,
      generate: (input) => ctx.generate.text(input),
      session: ctx.session,
      directory: ctx.location?.directory,
    })
    const controller = new AbortController()
    const loop = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (event?.type === "session.idle" && typeof event?.data?.sessionID === "string") {
            void retitler.evaluate(event.data.sessionID)
          } else if (event?.type === "session.renamed" && typeof event?.data?.sessionID === "string") {
            retitler.renamed(event.data.sessionID, event.data.title)
          }
        } catch (error) {
          console.error(`auto-retitle event failed (${String(error?.message ?? error).slice(0, 200)})`)
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) {
        console.error(`auto-retitle subscription ended (${String(error?.message ?? error).slice(0, 200)})`)
      }
    })
    return async () => {
      retitler.dispose()
      controller.abort()
      await loop
    }
  },
})

AutoRetitlePlugin.__test = () => testHelpers

export default AutoRetitlePlugin
