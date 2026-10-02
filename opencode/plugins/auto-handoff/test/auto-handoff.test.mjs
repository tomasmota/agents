import assert from "node:assert/strict"
import test from "node:test"

import { AutoHandoffPlugin } from "../auto-handoff.js"

const { check, createMonitor, estimateText, handoffInstruction, requestTokens, thresholdOf } = AutoHandoffPlugin.__test()

const SYSTEM = [{ type: "text", text: "You are a helpful assistant." }]
const TOOLS = {
  bash: { description: "Run a shell command in the current directory", input: { type: "object", properties: { command: { type: "string" } } } },
  read: { description: "Read a file from disk", input: { type: "object" } },
}

function textMessage(text) {
  return { role: "user", content: [{ type: "text", text }] }
}

function toolResult(text) {
  return {
    role: "assistant",
    content: [
      { type: "tool-call", name: "bash", input: { command: "npm test" } },
      { type: "tool-result", toolCallId: "call_1", result: { type: "content", value: [{ type: "text", text }] } },
    ],
  }
}

function requestEvent({ sessionID = "ses_test", system = SYSTEM, messages = [], tools = TOOLS } = {}) {
  return { sessionID, agent: "build", model: { providerID: "example", id: "fake-model" }, system, messages, options: {}, tools }
}

function harness({ threshold = 1000, storage: stored = [] } = {}) {
  const calls = { synthetic: [], create: [], prompt: [], storage: [] }
  const monitor = createMonitor({
    threshold,
    log: () => {},
    session: {
      synthetic: async (input) => {
        calls.synthetic.push(input)
        return { data: { id: "msg_1" } }
      },
      create: async (input) => {
        calls.create.push(input)
        return { data: { id: "ses_next" } }
      },
      prompt: async (input) => {
        calls.prompt.push(input)
        return { data: { id: "msg_2" } }
      },
    },
    storage: {
      get: async () => stored,
      set: async (key, value) => {
        calls.storage.push([key, value])
        stored = value
      },
      scan: async ({ prefix }) => ({ items: stored.filter((item) => Object.keys(item)[0]?.startsWith(prefix)) ?? [] }),
    },
  })
  return { monitor, calls, stored: () => stored }
}

function overThresholdEvent() {
  return requestEvent({ messages: [textMessage("z".repeat(40_000))] })
}

test("estimates text at four characters per token", () => {
  assert.equal(estimateText(""), 0)
  assert.equal(estimateText("abcd"), 1)
  assert.equal(estimateText("abcde"), 2)
  assert.equal(estimateText(undefined), 0)
})

test("counts system, tools, and message content in a request", () => {
  const small = requestTokens(requestEvent({ messages: [textMessage("hello")] }))
  const large = requestTokens(requestEvent({ messages: [textMessage("hello".repeat(1000))] }))
  assert.ok(large > small)
  assert.ok(small > 0)
  assert.equal(requestTokens(null), 0)
})

test("counts media as flat estimates and tool results as text", () => {
  const withImage = requestTokens(
    requestEvent({ messages: [{ role: "user", content: [{ type: "media", media: { mediaType: "image/png" } }] }] }),
  )
  const withText = requestTokens(requestEvent({ messages: [textMessage("x".repeat(6000))] }))
  assert.ok(withImage >= 1500)
  assert.ok(withText >= 1500)
  assert.ok(requestTokens(requestEvent({ messages: [toolResult("y".repeat(4000))] })) > 0)
})

test("reads the threshold from options before the environment", () => {
  assert.equal(thresholdOf({}, {}), 250000)
  assert.equal(thresholdOf({ threshold: 400000 }, {}), 400000)
  assert.equal(thresholdOf({}, { OPENCODE_HANDOFF_THRESHOLD: "120000" }), 120000)
  assert.equal(thresholdOf({ threshold: 120000 }, { OPENCODE_HANDOFF_THRESHOLD: "400000" }), 120000)
  // An explicit but unusable option falls back to the default rather than the
  // environment, matching the sibling plugins' `options.x ?? env.X` handling.
  assert.equal(thresholdOf({ threshold: "nope" }, { OPENCODE_HANDOFF_THRESHOLD: "50000" }), 250000)
  assert.equal(thresholdOf({ threshold: 5 }, {}), 250000)
})

test("stays below the threshold while the request is small", () => {
  const { monitor } = harness()
  assert.equal(check(monitor, requestEvent({ messages: [textMessage("tiny")] })), "below")
  assert.equal(monitor.state.status, "watching")
})

test("asks the current agent to do a handoff once over the threshold", async () => {
  const { monitor, calls } = harness()
  const event = overThresholdEvent()
  assert.equal(check(monitor, event), "over")
  await monitor.start(event)
  assert.equal(monitor.state.status, "done")
  assert.equal(calls.synthetic.length, 1)
  const steer = calls.synthetic[0]
  assert.equal(steer.sessionID, "ses_test")
  assert.match(steer.text, /handoff skill/)
  assert.match(steer.text, /do a handoff/)
  assert.match(steer.text, /no new direction from the user/)
  assert.match(steer.text, /Then stop/)
  // The plugin steers only; it names no document path and spawns nothing.
  assert.ok(!steer.text.includes("/tmp/"))
  assert.equal(calls.create.length, 0)
  assert.equal(calls.prompt.length, 0)
})

test("steers at most once per session", async () => {
  const { monitor, calls } = harness()
  const event = overThresholdEvent()
  check(monitor, event)
  await monitor.start(event)
  assert.equal(check(monitor, overThresholdEvent()), "skip")
  await monitor.ask()
  assert.equal(calls.synthetic.length, 1)
})

test("skips sessions that were already handed off", async () => {
  const { monitor, calls } = harness({ storage: [{ sessionID: "ses_test", tokens: 251_000 }] })
  const event = overThresholdEvent()
  check(monitor, event)
  await monitor.start(event)
  assert.equal(monitor.state.status, "handled")
  assert.equal(calls.synthetic.length, 0)
  assert.equal(calls.storage.length, 0)
})

test("remembers the steer so a restart cannot fire it twice", async () => {
  const { monitor, calls, stored } = harness()
  const event = overThresholdEvent()
  check(monitor, event)
  await monitor.start(event)
  assert.equal(calls.storage[0][0], "handoffs")
  assert.equal(calls.storage[0][1][0].sessionID, "ses_test")
  assert.ok(calls.storage[0][1][0].tokens > 1000)
  // A fresh monitor for the same session sees the registry entry.
  const next = harness({ storage: stored() })
  const again = overThresholdEvent()
  check(next.monitor, again)
  await next.monitor.start(again)
  assert.equal(next.monitor.state.status, "handled")
  assert.equal(next.calls.synthetic.length, 0)
})

test("still records the steer when storage write fails", async () => {
  const calls = { synthetic: [], storage: [] }
  const monitor = createMonitor({
    threshold: 1000,
    log: () => {},
    session: {
      synthetic: async (input) => {
        calls.synthetic.push(input)
        return { data: { id: "msg_1" } }
      },
    },
    storage: {
      get: async () => [],
      set: async () => {
        throw new Error("disk full")
      },
      scan: async () => ({ items: [] }),
    },
  })
  const event = overThresholdEvent()
  check(monitor, event)
  await monitor.start(event)
  assert.equal(calls.synthetic.length, 1)
  assert.equal(monitor.state.status, "done")
})

test("the steer instructs the agent to use the skill rather than restating the format", () => {
  const text = handoffInstruction({ threshold: 250000, tokens: 251234.5 })
  assert.match(text, /251235 tokens/)
  assert.match(text, /handoff threshold 250000/)
  assert.ok(!text.includes("## Objective"))
  assert.ok(!text.includes("tmux"))
})

test("registers only the context hook and never subscribes to events", async () => {
  const registrations = []
  const ctx = {
    options: {},
    session: {
      hook: async (name, callback) => {
        registrations.push(name)
        return { dispose: async () => {} }
      },
    },
    storage: { get: async () => undefined, set: async () => {}, scan: async () => ({ items: [] }) },
  }
  await AutoHandoffPlugin.setup(ctx)
  assert.deepEqual(registrations, ["context"])
})
