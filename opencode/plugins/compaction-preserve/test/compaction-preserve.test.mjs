import assert from "node:assert/strict"
import test from "node:test"

import { CompactionPreservePlugin } from "../compaction-preserve.js"
import { PRESERVATION_INSTRUCTIONS } from "../instructions.js"

const { preserve } = CompactionPreservePlugin.__test()

function compactionEvent(overrides = {}) {
  return {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "example", id: "fake-model" },
    kind: "compaction",
    system: [{ type: "text", text: "You are a summarizer." }],
    messages: [{ role: "user", content: [{ type: "text", text: "summarize" }] }],
    options: { maxTokens: 32000 },
    tools: {
      bash: { description: "Run a shell command", input: { type: "object" } },
      read: { description: "Read a file", input: { type: "object" } },
    },
    ...overrides,
  }
}

test("exposes the plugin id and policy text", () => {
  assert.equal(CompactionPreservePlugin.id, "tomas.compaction-preserve")
  assert.ok(PRESERVATION_INSTRUCTIONS.includes("## Important Context"))
  assert.ok(PRESERVATION_INSTRUCTIONS.length > 1000)
})

test("appends the preservation policy as a system text part", () => {
  const event = compactionEvent()
  const report = preserve(event)
  assert.deepEqual(report, { policy: true, tools: true })
  assert.equal(event.system.length, 2)
  assert.deepEqual(event.system[1], { type: "text", text: PRESERVATION_INSTRUCTIONS })
})

test("leaves model, messages, and options untouched", () => {
  const event = compactionEvent()
  const before = {
    model: event.model,
    messages: event.messages,
    options: event.options,
    sessionID: event.sessionID,
    agent: event.agent,
  }
  preserve(event)
  assert.equal(event.model, before.model)
  assert.equal(event.messages, before.messages)
  assert.equal(event.options, before.options)
  assert.equal(event.options.maxTokens, 32000)
  assert.equal(event.sessionID, before.sessionID)
  assert.equal(event.agent, before.agent)
})

test("clears tools so the summarizer cannot call them", () => {
  const event = compactionEvent()
  preserve(event)
  assert.deepEqual(event.tools, {})
})

test("never sets a result: OpenCode still generates the summary", () => {
  const event = compactionEvent()
  preserve(event)
  assert.equal("result" in event, false)
})

test("is idempotent across repeated transformations", () => {
  const event = compactionEvent()
  preserve(event)
  const second = preserve(event)
  assert.deepEqual(second, { policy: false, tools: true })
  assert.equal(event.system.length, 2)
})

test("skips everything when another hook already supplied the summary", () => {
  const event = compactionEvent({ result: { summary: "## Objective\n- done" } })
  const report = preserve(event)
  assert.deepEqual(report, { policy: false, tools: false })
  assert.equal(event.system.length, 1)
  assert.equal(Object.keys(event.tools).length, 2)
})

test("ignores non-object events", () => {
  assert.deepEqual(preserve(null), { policy: false, tools: false })
  assert.deepEqual(preserve(undefined), { policy: false, tools: false })
  assert.deepEqual(preserve("compaction"), { policy: false, tools: false })
})

test("registers the compaction hook without provider scoping", async () => {
  const registrations = []
  const ctx = {
    session: {
      hook: async (name, callback, options) => {
        registrations.push({ name, callback, options })
        return { dispose: async () => {} }
      },
    },
  }
  await CompactionPreservePlugin.setup(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, "compaction")
  assert.equal(registrations[0].options, undefined)
})

test("the registered hook transforms a compaction request", async () => {
  let registered = null
  const ctx = {
    session: {
      hook: async (name, callback) => {
        registered = { name, callback }
        return { dispose: async () => {} }
      },
    },
  }
  await CompactionPreservePlugin.setup(ctx)
  const event = compactionEvent()
  registered.callback(event)
  assert.equal(event.system.length, 2)
  assert.deepEqual(event.tools, {})
})

test("the registered hook survives a throwing event", async () => {
  let registered = null
  const ctx = {
    session: {
      hook: async (name, callback) => {
        registered = { name, callback }
        return { dispose: async () => {} }
      },
    },
  }
  await CompactionPreservePlugin.setup(ctx)
  // A null prototype getter that throws exercises the guard around preserve().
  const bomb = {}
  Object.defineProperty(bomb, "system", {
    get() {
      throw new Error("boom")
    },
    configurable: true,
  })
  assert.doesNotThrow(() => registered.callback(bomb))
})
