import assert from "node:assert/strict"
import test from "node:test"

import { AutoHandoffPlugin } from "../auto-handoff.js"

const {
  check,
  createMonitor,
  estimateText,
  handoffInstruction,
  paneInstruction,
  requestTokens,
  shellQuote,
  thresholdOf,
} = AutoHandoffPlugin.__test()

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

function fakeFs(files = {}) {
  return {
    open: async (pathname) => {
      if (!(pathname in files)) throw new Error("ENOENT")
      const content = files[pathname]
      let cursor = 0
      return {
        async read(buffer, offset, length) {
          const total = Buffer.byteLength(content)
          if (cursor >= total) return { bytesRead: 0 }
          const end = Math.min(cursor + length, total)
          const bytesRead = end - cursor
          Buffer.from(content).subarray(cursor, end).copy(buffer, offset)
          cursor = end
          return { bytesRead }
        },
        async stat() {
          return { size: Buffer.byteLength(content) }
        },
        async close() {
          return undefined
        },
      }
    },
  }
}

function harness({ threshold = 1000, directory = "/repo", documentPath = "/tmp/handoff.md", document = "# Handoff\n", files, waitTimeout, waitInterval, storage: stored = [] } = {}) {
  const calls = { synthetic: [], create: [], prompt: [], storage: [] }
  const monitor = createMonitor({
    threshold,
    directory,
    documentPath: () => documentPath,
    fs: fakeFs(files ?? { [documentPath]: document }),
    waitTimeout,
    waitInterval,
    log: () => {},
    session: {
      get: async ({ sessionID }) => ({
        data: { id: sessionID, agent: "coder", model: { id: "fake-model", providerID: "example", variant: "high" }, location: { directory } },
      }),
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

test("asks the current agent to use the handoff skill once over the threshold", async () => {
  const { monitor, calls } = harness()
  const event = requestEvent({ messages: [textMessage("z".repeat(40_000))] })
  assert.equal(check(monitor, event), "over")
  await monitor.start(event)
  assert.equal(monitor.state.status, "writing")
  assert.equal(calls.synthetic.length, 1)
  const steer = calls.synthetic[0]
  assert.equal(steer.sessionID, "ses_test")
  assert.match(steer.text, /handoff skill/)
  assert.match(steer.text, /document-only mode/)
  assert.match(steer.text, /\/tmp\/handoff\.md/)
  assert.match(steer.text, /Do not create or spawn a session/)
  assert.match(steer.text, /no new direction from the user/)
})

test("skips sessions that were already handed off", async () => {
  const { monitor, calls } = harness({ storage: [{ sessionID: "ses_test", successorID: "ses_old" }] })
  const event = requestEvent({ messages: [textMessage("z".repeat(40_000))] })
  check(monitor, event)
  await monitor.start(event)
  assert.equal(monitor.state.status, "handled")
  assert.equal(calls.synthetic.length, 0)
  assert.equal(calls.create.length, 0)
})

test("creates the successor with the same agent, model, and directory, then prompts it", async () => {
  const document = "# Handoff: widget-api\n\n## Next actions\n1. run the tests\n"
  const { monitor, calls } = harness({ document })
  const event = requestEvent({ messages: [textMessage("z".repeat(40_000))] })
  check(monitor, event)
  await monitor.start(event)
  await monitor.complete()
  assert.equal(calls.create.length, 1)
  assert.deepEqual(calls.create[0], {
    title: "Handoff: ses_test",
    location: { directory: "/repo" },
    agent: "coder",
    model: { providerID: "example", id: "fake-model", variant: "high" },
  })
  assert.deepEqual(calls.prompt, [{ sessionID: "ses_next", text: document }])
  assert.equal(monitor.state.status, "done")
})

test("asks the old session to open the tmux pane for the successor", async () => {
  const { monitor, calls } = harness()
  const event = requestEvent({ messages: [textMessage("z".repeat(40_000))] })
  check(monitor, event)
  await monitor.start(event)
  await monitor.complete()
  const pane = calls.synthetic.at(-1)
  assert.equal(pane.sessionID, "ses_test")
  assert.match(pane.text, /tmux split-window -h -c \/repo -t "\$TMUX_PANE" opencode --session ses_next/)
  assert.match(pane.text, /Do not continue the task in this session/)
})

test("the pane steer covers clients without tmux", () => {
  const text = paneInstruction({ sessionID: "ses_next", directory: "/repo", documentPath: "/tmp/d.md" })
  assert.match(text, /Inside tmux \(\$\{TMUX:-\} is set\)/)
  assert.match(text, /Outside tmux/)
  assert.match(text, /OpenChamber/)
  assert.match(text, /run no tmux command/)
})

test("remembers the handoff so it never fires twice", async () => {
  const { monitor, calls } = harness()
  const event = requestEvent({ messages: [textMessage("z".repeat(40_000))] })
  check(monitor, event)
  await monitor.start(event)
  await monitor.complete()
  assert.equal(calls.storage[0][0], "handoffs")
  assert.equal(calls.storage[0][1][0].sessionID, "ses_test")
  assert.equal(calls.storage[0][1][0].successorID, "ses_next")
  // A later request for the same session is ignored by the registry.
  assert.equal(check(monitor, requestEvent({ messages: [textMessage("q")] })), "skip")
})

test("leaves the session alone when no document appears", async () => {
  const { monitor, calls } = harness({ documentPath: "/tmp/missing.md", files: {}, waitTimeout: 0, waitInterval: 1 })
  const event = requestEvent({ messages: [textMessage("z".repeat(40_000))] })
  check(monitor, event)
  await monitor.start(event)
  await monitor.complete()
  assert.equal(monitor.state.status, "idle")
  assert.equal(calls.create.length, 0)
  assert.equal(calls.prompt.length, 0)
})

test("quotes directories with spaces for the tmux command", () => {
  assert.equal(shellQuote("/repo"), "/repo")
  assert.equal(shellQuote("/Users/me/My Repo"), "'/Users/me/My Repo'")
  assert.equal(shellQuote(""), "''")
})

test("the steer instructs the agent to use the skill rather than restating the format", () => {
  const text = handoffInstruction({ sessionID: "ses_x", threshold: 250000, tokens: 251234.5, documentPath: "/tmp/d.md" })
  assert.match(text, /251235 tokens/)
  assert.match(text, /handoff threshold 250000/)
  assert.ok(!text.includes("## Objective"))
})

test("pane steer names the document path and the new session", () => {
  const text = paneInstruction({ sessionID: "ses_next", directory: "/repo", documentPath: "/tmp/d.md" })
  assert.match(text, /ses_next/)
  assert.match(text, /\/tmp\/d\.md/)
})

test("registers only the context hook", async () => {
  const registrations = []
  const ctx = {
    location: { directory: "/repo" },
    options: {},
    session: {
      hook: async (name, callback) => {
        registrations.push(name)
        return { dispose: async () => {} }
      },
    },
    storage: { get: async () => undefined, set: async () => {}, scan: async () => ({ items: [] }) },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
  }
  await AutoHandoffPlugin.setup(ctx)
  assert.deepEqual(registrations, ["context"])
})
