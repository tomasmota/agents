import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createAgentRoutes } from "../index.js"
import { resetSharedExhausted } from "../lib/exhausted.js"
import { resetSharedQuota } from "../lib/quota-cache.js"

const MODELS = [
  { providerID: "claude-subscription", id: "claude-sonnet-5-5", variants: [{ id: "high" }] },
  { providerID: "claude-subscription", id: "claude-opus-5-5", variants: [{ id: "high" }, { id: "xhigh" }] },
  { providerID: "openai", id: "gpt-6.1-sol", variants: [{ id: "high" }, { id: "xhigh" }] },
  { providerID: "inco", id: "glm-5.3-flash:fast", variants: [] },
]

const ROUTES = {
  fallbacks: { openai: "claude-subscription/claude-opus-5-5", "claude-subscription": "openai/gpt-6.1-sol#high" },
  permissions: [
    { action: "question", resource: "*", effect: "deny", when: "child" },
    { action: "subagent", resource: "*", effect: "deny", when: "child" },
    { action: "subagent", resource: "explore", effect: "allow", when: "child" },
  ],
  agents: {
    general: { mode: "all", model: "claude-subscription/claude-sonnet-5-5#high", description: "Default." },
    terminal: { mode: "all", model: "openai/gpt-6.1-sol#xhigh", description: "Shell." },
    explore: {
      model: "inco/glm-5.3-flash:fast",
      description: "Search.",
      system: ["Search well."],
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ],
    },
  },
}

function defaultAgent(id) {
  return {
    id,
    name: id,
    mode: "primary",
    hidden: false,
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ],
  }
}

function eventStream() {
  const queue = []
  let wake
  const push = (event) => {
    queue.push(event)
    wake?.()
  }
  const subscribe = ({ signal } = {}) => ({
    async *[Symbol.asyncIterator]() {
      while (!signal?.aborted) {
        if (queue.length) {
          yield queue.shift()
          continue
        }
        await new Promise((resolve) => {
          wake = resolve
          signal?.addEventListener("abort", resolve, { once: true })
        })
        wake = undefined
      }
    },
  })
  return { push, subscribe }
}

function fakeContext({ models = MODELS, sessions = {} } = {}) {
  const events = eventStream()
  const transforms = []
  const permissionHooks = []
  const sessionHooks = {}
  const agents = new Map()
  const registration = { dispose: async () => {} }
  const editor = {
    remove: (id) => agents.delete(id),
    update: (id, fn) => {
      if (!agents.has(id)) agents.set(id, defaultAgent(id))
      fn(agents.get(id))
    },
  }
  const counts = { reload: 0 }
  const rebuild = () => {
    counts.reload++
    agents.clear()
    agents.set("general", { ...defaultAgent("general"), mode: "subagent", permissions: [{ action: "subagent", resource: "*", effect: "deny" }] })
    for (const transform of transforms) transform(editor)
  }
  return {
    agents,
    counts,
    events,
    permissionHooks,
    sessionHooks,
    ctx: {
      event: { subscribe: events.subscribe },
      model: { list: async () => ({ location: {}, data: typeof models === "function" ? models() : models }) },
      agent: {
        transform: async (cb) => (transforms.push(cb), registration),
        reload: async () => rebuild(),
      },
      permission: { hook: async (_name, cb) => (permissionHooks.push(cb), registration) },
      session: {
        get: async ({ sessionID }) => {
          const session = sessionID in sessions ? sessions[sessionID] : { id: sessionID }
          if (session instanceof Error) throw session
          return session
        },
        hook: async (name, cb) => ((sessionHooks[name] = cb), registration),
      },
    },
  }
}

async function setup(t, { dir, routes = ROUTES, routesText, quota = {}, quotaSources, models, sessions, keepShared = false } = {}) {
  resetSharedQuota()
  if (!keepShared) resetSharedExhausted()
  dir ??= await mkdtemp(join(tmpdir(), "agent-routes-plugin-"))
  const files = { routesFile: join(dir, "subagents.jsonc"), stateFile: join(dir, "state.json"), logFile: join(dir, "log") }
  await writeFile(files.routesFile, routesText ?? `// comment\n${JSON.stringify(routes, null, 2)}\n`)
  quotaSources ??= Object.fromEntries(Object.entries(quota).map(([provider, value]) => [provider, async () => value]))
  const fake = fakeContext({ models, sessions })
  const cleanup = await createAgentRoutes({ ...files, quotaSources, pollFileMs: 20 }).setup(fake.ctx)
  t.after(cleanup)
  return { ...fake, files, cleanup }
}

async function waitFor(check, timeoutMs = 3_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await check()
      if (result) return result
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("timed out")
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"))

test("replaces built-ins and generates agents from the routes file", async (t) => {
  const { agents } = await setup(t)
  const general = agents.get("general")
  assert.equal(general.mode, "all")
  assert.deepEqual(general.model, { providerID: "claude-subscription", id: "claude-sonnet-5-5", variant: "high" })
  assert.ok(!general.permissions.some((rule) => rule.action === "subagent"), "static child-only rules must not apply to primaries")
  assert.deepEqual(agents.get("explore").model, { providerID: "inco", id: "glm-5.3-flash:fast" })
  assert.equal(agents.get("explore").system, "Search well.")
  assert.deepEqual(agents.get("explore").permissions.at(-1), { action: "read", resource: "*", effect: "allow" })
})

test("routes low-quota providers to their fallback", async (t) => {
  const { agents, files } = await setup(t, {
    quota: { openai: { fiveHourLeft: 5, weeklyLeft: 50, checkedAt: Date.now() } },
  })
  await waitFor(() => agents.get("terminal")?.model?.providerID === "claude-subscription")
  assert.deepEqual(agents.get("terminal").model, { providerID: "claude-subscription", id: "claude-opus-5-5", variant: "xhigh" })
  const state = await readJson(files.stateFile)
  assert.deepEqual(state.low, ["openai"])
  assert.equal(state.agents.terminal.fallbackFrom, "openai/gpt-6.1-sol#xhigh")
})

test("falls back when a provider is not configured on this machine", async (t) => {
  const { agents } = await setup(t, { models: MODELS.filter((model) => model.providerID !== "claude-subscription") })
  assert.deepEqual(agents.get("general").model, { providerID: "openai", id: "gpt-6.1-sol", variant: "high" })
})

test("restricts child sessions to explore and leaves primaries alone", async (t) => {
  const { permissionHooks, sessionHooks } = await setup(t, { sessions: { child: { id: "child", parentID: "root" } } })
  const evaluate = async (sessionID, action, resource) => {
    const event = { sessionID, agent: "general", action, resources: [resource], effect: "allow" }
    for (const hook of permissionHooks) await hook(event)
    return event.effect
  }
  assert.equal(await evaluate("child", "subagent", "terminal"), "deny")
  assert.equal(await evaluate("child", "subagent", "explore"), "allow")
  assert.equal(await evaluate("child", "question", "*"), "deny")
  assert.equal(await evaluate("root", "subagent", "terminal"), "allow")

  const catalog = (sessionID) => ({
    sessionID,
    agent: "general",
    tools: { subagent: { description: "Spawn.\nAvailable subagents:\n- explore: Search.\n- terminal: Shell." } },
  })
  const child = catalog("child")
  await sessionHooks.context(child)
  assert.equal(child.tools.subagent.description, "Spawn.\nAvailable subagents:\n- explore: Search.")
  const root = catalog("root")
  await sessionHooks.context(root)
  assert.match(root.tools.subagent.description, /- terminal: Shell\./)
})

test("re-checks models when providers finish loading", async (t) => {
  let models = MODELS.filter((model) => model.providerID !== "claude-subscription")
  const { agents, events } = await setup(t, { models: () => models })
  assert.equal(agents.get("general").model.providerID, "openai")
  models = MODELS
  events.push({ type: "model.updated", data: {} })
  await waitFor(() => agents.get("general")?.model?.providerID === "claude-subscription")
  assert.deepEqual(agents.get("general").model, { providerID: "claude-subscription", id: "claude-sonnet-5-5", variant: "high" })
})

test("reuses fresh quota written by another process instead of fetching", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-routes-plugin-"))
  const checkedAt = Date.now()
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({ updatedAt: checkedAt, quota: { openai: { fiveHourLeft: 3, weeklyLeft: 50, checkedAt } } }),
  )
  let calls = 0
  const { agents } = await setup(t, {
    dir,
    quotaSources: {
      openai: async () => {
        calls++
        return undefined
      },
    },
  })
  await waitFor(() => agents.get("terminal")?.model?.providerID === "claude-subscription")
  assert.equal(calls, 0)
})

test("treats failed session lookups as child sessions", async (t) => {
  const { permissionHooks } = await setup(t, { sessions: { broken: new Error("boom"), empty: null } })
  for (const sessionID of ["broken", "empty"]) {
    const event = { sessionID, agent: "general", action: "subagent", resources: ["terminal"], effect: "allow" }
    for (const hook of permissionHooks) await hook(event)
    assert.equal(event.effect, "deny", sessionID)
  }
})

test("an invalid file at startup records errors and registers nothing", async (t) => {
  const { agents, files } = await setup(t, { routesText: "{ not valid" })
  const state = await readJson(files.stateFile)
  assert.equal(state.errors.length, 1)
  assert.deepEqual(state.agents, {})
  assert.equal(agents.get("general").mode, "subagent", "the built-in general stays untouched")
})

test("does not sync after cleanup when a quota refresh finishes late", async (t) => {
  let release
  const pending = new Promise((resolve) => (release = resolve))
  const { counts, files, cleanup } = await setup(t, {
    quotaSources: { openai: () => pending.then(() => ({ fiveHourLeft: 1, weeklyLeft: 1, checkedAt: Date.now() })) },
  })
  const before = { reload: counts.reload, state: await readFile(files.stateFile, "utf8") }
  await cleanup()
  release()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(counts.reload, before.reload)
  assert.equal(await readFile(files.stateFile, "utf8"), before.state)
})

test("hot-reloads edits and keeps the last good routes on invalid edits", async (t) => {
  const { agents, files } = await setup(t)
  const edited = structuredClone(ROUTES)
  edited.agents.general.model = "claude-subscription/claude-opus-5-5#high"
  await writeFile(files.routesFile, JSON.stringify(edited))
  await waitFor(() => agents.get("general")?.model?.id === "claude-opus-5-5")

  edited.agents.general.model = "claude-subscription/claude-opus-9"
  await writeFile(files.routesFile, JSON.stringify(edited))
  const state = await waitFor(async () => {
    const current = await readJson(files.stateFile)
    return current.errors.some((error) => /claude-opus-9 is not an available model/.test(error)) ? current : undefined
  })
  assert.equal(state.errors.length, 1)
  assert.equal(agents.get("general").model.id, "claude-opus-5-5")
  assert.match(await readFile(files.logFile, "utf8"), /kept the last good routes/)
})

const quotaFailure = (providerID, error = { type: "provider.quota", message: "The usage limit has been reached" }) => ({
  sessionID: "child",
  agent: "terminal",
  model: { providerID, id: "gpt-6.1-sol", variant: "xhigh" },
  error,
  attempt: 1,
  decision: { retry: false },
})

test("a quota failure with no quota source switches the provider's roles to the fallback", async (t) => {
  const { agents, files, sessionHooks } = await setup(t)
  assert.equal(agents.get("terminal").model.providerID, "openai")

  const event = quotaFailure("openai")
  await sessionHooks.retry(event)
  await waitFor(() => agents.get("terminal")?.model?.providerID === "claude-subscription")
  assert.deepEqual(agents.get("terminal").model, { providerID: "claude-subscription", id: "claude-opus-5-5", variant: "xhigh" })
  assert.deepEqual(event.decision, { retry: false }, "the hook only observes")

  const state = await waitFor(async () => {
    const current = await readJson(files.stateFile)
    return current.low.includes("openai") ? current : undefined
  })
  assert.equal(state.agents.terminal.fallbackFrom, "openai/gpt-6.1-sol#xhigh")
  assert.deepEqual(Object.keys(state.exhausted), ["openai"])
  assert.equal(agents.get("general").model.providerID, "claude-subscription", "other providers are unaffected")
  assert.match(await readFile(files.logFile, "utf8"), /openai hit its usage limit/)
})

test("transient rate limits, other errors and providers without a fallback do not switch roles", async (t) => {
  const { agents, files, sessionHooks } = await setup(t)
  await sessionHooks.retry(quotaFailure("openai", { type: "provider.rate-limit", status: 429, message: "slow down" }))
  await sessionHooks.retry(quotaFailure("openai", { type: "provider.transport", message: "socket closed" }))
  await sessionHooks.retry(quotaFailure("inco"))
  await sessionHooks.retry({ sessionID: "child", error: { type: "provider.quota", message: "x" } })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(agents.get("terminal").model.providerID, "openai")
  const state = await readJson(files.stateFile)
  assert.deepEqual(state.low, [])
  assert.deepEqual(state.exhausted, {})
})

test("a recorded quota failure survives a restart through the state file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-routes-plugin-"))
  const first = await setup(t, { dir })
  await first.sessionHooks.retry(quotaFailure("openai"))
  await waitFor(async () => (await readJson(first.files.stateFile)).low.includes("openai"))
  await first.cleanup()

  const second = await setup(t, { dir })
  assert.equal(second.agents.get("terminal").model.providerID, "claude-subscription")
})

test("a quota reading taken after the failure supersedes it; an older reading does not", async (t) => {
  const now = Date.now()
  const entry = { detectedAt: now - 60_000, until: now + 30 * 60_000, windowMs: 30 * 60_000 }

  const dir = await mkdtemp(join(tmpdir(), "agent-routes-plugin-"))
  await writeFile(join(dir, "state.json"), JSON.stringify({ updatedAt: now, quota: {}, exhausted: { openai: entry } }))
  const healthyNow = { fiveHourLeft: 90, weeklyLeft: 90, checkedAt: now }
  const newer = await setup(t, { dir, quota: { openai: healthyNow } })
  await waitFor(() => newer.agents.get("terminal")?.model?.providerID === "openai")
  assert.deepEqual((await readJson(newer.files.stateFile)).exhausted, {}, "a superseded failure is dropped")

  const olderReading = { ...healthyNow, checkedAt: now - 120_000 }
  const older = await setup(t, {
    quotaSources: { openai: async () => olderReading },
    dir: await mkdtemp(join(tmpdir(), "agent-routes-plugin-")),
  })
  await older.sessionHooks.retry(quotaFailure("openai"))
  await waitFor(() => older.agents.get("terminal")?.model?.providerID === "claude-subscription")
})

test("a quota failure seen by one plugin instance reaches the others in the process", async (t) => {
  const first = await setup(t)
  const second = await setup(t, { keepShared: true })
  assert.equal(second.agents.get("terminal").model.providerID, "openai")
  await first.sessionHooks.retry(quotaFailure("openai"))
  await waitFor(() => second.agents.get("terminal")?.model?.providerID === "claude-subscription")
})

test("does not fall back onto a provider that is also low", async (t) => {
  const { agents, sessionHooks } = await setup(t, {
    quota: { "claude-subscription": { fiveHourLeft: 2, weeklyLeft: 80, checkedAt: Date.now() } },
  })
  await waitFor(() => agents.get("general")?.model?.providerID === "openai")
  await sessionHooks.retry(quotaFailure("openai"))
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(agents.get("terminal").model.providerID, "openai", "no chaining: both low keeps the configured model")
  assert.equal(agents.get("general").model.providerID, "claude-subscription")
})

test("a sync picks up a newer reading another process wrote instead of resurrecting the failure", async (t) => {
  const { agents, events, files, sessionHooks } = await setup(t)
  await sessionHooks.retry(quotaFailure("openai"))
  await waitFor(() => agents.get("terminal")?.model?.providerID === "claude-subscription")

  const checkedAt = Date.now() + 1_000
  await writeFile(
    files.stateFile,
    JSON.stringify({ updatedAt: Date.now(), quota: { openai: { fiveHourLeft: 95, weeklyLeft: 95, checkedAt } }, exhausted: {} }),
  )
  events.push({ type: "model.updated", data: {} })
  await waitFor(() => agents.get("terminal")?.model?.providerID === "openai")
  const state = await readJson(files.stateFile)
  assert.deepEqual(state.low, [])
  assert.deepEqual(state.exhausted, {})
  assert.equal(state.quota.openai.checkedAt, checkedAt)
})
