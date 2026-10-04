import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { JevAutoApprovePlugin } from "../auto-approve-jev.js"
import { createAgentRoutes } from "../../agent-routes/index.js"

const SAFE_JEV = {
  model: "jev-1.13.0",
  answers: {
    dangerousness: { type: "score", score: 1, confidence: 1, probabilities: {} },
    blast_radius: { type: "score", score: 1, confidence: 1, probabilities: {} },
    plausible_dev_purpose: { type: "noul", noul: 0.95 },
    risk_category: { type: "choice", choice: "routine_or_scoped", confidence: 1, probabilities: {} },
  },
  usage: { input_tokens: 800 },
}

const ENV_KEYS = [
  "TYPESAFE_API_KEY",
  "OPENCODE_SECRETS_FILE",
  "OPENCODE_JEV_DEBUG",
  "OPENCODE_JEV_FALLBACK_MODELS",
  "OPENCODE_JEV_ON_EXHAUSTION",
]

async function withEnv(t, values) {
  const originalFetch = globalThis.fetch
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const auditDirectory = await mkdtemp(join(tmpdir(), "jev-initial-deny-"))
  t.after(async () => {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(auditDirectory, { recursive: true, force: true })
  })
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.OPENCODE_SECRETS_FILE = "/nonexistent/jev-test-secrets.env"
  process.env.OPENCODE_JEV_DEBUG = join(auditDirectory, "decisions.jsonl")
  Object.assign(process.env, values)
  return { auditDirectory }
}

async function auditSnapshot(directory) {
  const files = (await readdir(directory)).sort()
  return Promise.all(files.map(async (file) => [file, await readFile(join(directory, file), "utf8")]))
}

function jevHarness(generate) {
  let evaluate
  const context = {
    location: { directory: "/work/fixture-app" },
    generate,
    permission: { hook: async (name, callback) => {
      assert.equal(name, "evaluate")
      evaluate = callback
    } },
  }
  return JevAutoApprovePlugin.setup(context).then(() => evaluate)
}

function countingFetch(body = SAFE_JEV) {
  const calls = { count: 0 }
  globalThis.fetch = async () => {
    calls.count++
    return new Response(JSON.stringify(body), { status: 200 })
  }
  return calls
}

function countingGenerate(text = '{"decision":"allow","reasonCode":"scoped_work","reason":"Scoped and recoverable."}') {
  const calls = { count: 0 }
  return {
    calls,
    generate: { text: async () => {
      calls.count++
      if (text instanceof Error) throw text
      return { text }
    } },
  }
}

// Each scenario would end in "allow" if the event did not arrive already denied.
const SCENARIOS = [
  {
    name: "question fast path",
    env: {},
    event: { action: "question", resources: ["*"] },
    jev: "throw",
    fallback: "throw",
  },
  {
    name: "ordinary Jev review",
    env: { TYPESAFE_API_KEY: "test-key" },
    event: { action: "subagent", resources: ["quick"] },
    jev: "safe",
    fallback: "throw",
  },
  {
    name: "LLM fallback",
    env: { OPENCODE_JEV_FALLBACK_MODELS: "fixture/test-model" },
    event: { action: "shell", resources: ["fixture-command"] },
    jev: "throw",
    fallback: "allow",
  },
  {
    name: "reviewer exhaustion fail-open",
    env: { OPENCODE_JEV_FALLBACK_MODELS: "fixture/test-model", OPENCODE_JEV_ON_EXHAUSTION: "allow" },
    event: { action: "shell", resources: ["fixture-command"] },
    jev: "throw",
    fallback: "fail",
  },
]

for (const scenario of SCENARIOS) {
  test(`an initially denied event stays denied through the ${scenario.name}`, async (t) => {
    const { auditDirectory } = await withEnv(t, scenario.env)
    const jevCalls = scenario.jev === "safe" ? countingFetch() : { count: 0 }
    if (scenario.jev === "throw") globalThis.fetch = async () => { jevCalls.count++; throw new Error("fixture Jev unavailable") }
    const { calls: fallbackCalls, generate } = countingGenerate(scenario.fallback === "fail" ? new Error("fixture fallback down") : undefined)
    const evaluate = await jevHarness(generate)

    // Control: without an initial deny, the same path ends in allow.
    const control = { sessionID: "ses_control", agent: "general", ...scenario.event, effect: "ask" }
    await evaluate(control)
    assert.equal(control.effect, "allow")
    const reviewerCalls = jevCalls.count + fallbackCalls.count
    const audit = await auditSnapshot(auditDirectory)
    assert.ok(audit.length > 0, "the control decision is audited")

    const message = "fixture route denied this"
    const event = { sessionID: "ses_denied", agent: "general", ...scenario.event, effect: "deny", message }
    const before = structuredClone(event)
    await evaluate(event)
    assert.deepEqual(event, before, "a denied event is left untouched")
    assert.equal(jevCalls.count + fallbackCalls.count, reviewerCalls, "no reviewer runs for a denied event")
    assert.deepEqual(await auditSnapshot(auditDirectory), audit, "no audit record for a denied event")
  })
}

const MODELS = [
  { providerID: "fixture", id: "main-model", variants: [] },
  { providerID: "fixture", id: "fast-model", variants: [] },
]

const ROUTES = {
  fallbacks: {},
  permissions: [
    { action: "question", resource: "*", effect: "deny", when: "child" },
    { action: "subagent", resource: "*", effect: "deny", when: "child" },
    { action: "subagent", resource: "explore", effect: "allow", when: "child" },
  ],
  agents: {
    general: { mode: "all", model: "fixture/main-model", description: "Default." },
    quick: { mode: "subagent", model: "fixture/fast-model", description: "Quick." },
    explore: { mode: "subagent", model: "fixture/fast-model", description: "Search." },
  },
}

async function routesHarness(t, sessions) {
  const dir = await mkdtemp(join(tmpdir(), "jev-routes-composed-"))
  const routesFile = join(dir, "subagents.jsonc")
  await writeFile(routesFile, JSON.stringify(ROUTES))
  const hooks = []
  const registration = { dispose: async () => {} }
  const ctx = {
    model: { list: async () => ({ data: MODELS }) },
    agent: { transform: async () => registration, reload: async () => {} },
    permission: { hook: async (name, cb) => {
      assert.equal(name, "evaluate")
      hooks.push(cb)
      return registration
    } },
    session: {
      get: async ({ sessionID }) => ({ data: sessions[sessionID] }),
      hook: async () => registration,
    },
  }
  const cleanup = await createAgentRoutes({
    routesFile,
    stateFile: join(dir, "state.json"),
    logFile: join(dir, "agent-routes.log"),
    pollFileMs: 50,
  }).setup(ctx)
  t.after(async () => {
    await cleanup()
    await rm(dir, { recursive: true, force: true })
  })
  return hooks
}

test("agent-routes child denies survive the later Jev hook", async (t) => {
  await withEnv(t, { TYPESAFE_API_KEY: "test-key", OPENCODE_JEV_DEBUG: "0" })
  const jevCalls = countingFetch()
  const { calls: fallbackCalls, generate } = countingGenerate(new Error("fallback must not run"))
  const routeHooks = await routesHarness(t, {
    ses_primary: { id: "ses_primary" },
    ses_child: { id: "ses_child", parentID: "ses_primary" },
  })
  const hooks = [...routeHooks, await jevHarness(generate)]

  const evaluate = async (sessionID, action, resource) => {
    const event = { sessionID, agent: "general", action, resources: [resource], effect: "ask" }
    for (const hook of hooks) await hook(event)
    return event
  }

  const childQuick = await evaluate("ses_child", "subagent", "quick")
  assert.equal(childQuick.effect, "deny")
  assert.match(childQuick.message, /general may not subagent quick here/)
  const childQuestion = await evaluate("ses_child", "question", "*")
  assert.equal(childQuestion.effect, "deny")
  assert.match(childQuestion.message, /general may not question/)
  assert.equal(jevCalls.count, 0, "denied child events never reach Jev")

  assert.equal((await evaluate("ses_child", "subagent", "explore")).effect, "allow")
  assert.equal((await evaluate("ses_primary", "subagent", "quick")).effect, "allow")
  assert.equal(jevCalls.count, 2)
  assert.equal(fallbackCalls.count, 0)
})
