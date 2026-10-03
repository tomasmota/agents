import assert from "node:assert/strict"
import test from "node:test"

import { AutoHandoffPlugin } from "../auto-handoff.js"

const { check, createMonitor, estimateText, handoffInstruction, recordKey, requestTokens, thresholdOf } =
  AutoHandoffPlugin.__test()

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

function smallEvent(sessionID = "ses_test") {
  return requestEvent({ sessionID, messages: [textMessage("tiny")] })
}

function overThresholdEvent(sessionID = "ses_test") {
  return requestEvent({ sessionID, messages: [textMessage("z".repeat(80_000))] })
}

// The real V2 storage contract: exact-key reads, and a scan that returns
// `{entries: [{key, value}], next}` rather than a bare item list. Mirroring the
// real shape is what makes a wrong assumption about `scan` fail here.
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  const calls = { get: [], set: [], remove: [], scan: [] }
  const clone = (value) => (value === undefined ? undefined : structuredClone(value))
  return {
    calls,
    data,
    get: async (key) => {
      calls.get.push(key)
      return clone(data.get(key))
    },
    set: async (key, value) => {
      calls.set.push([key, clone(value)])
      data.set(key, clone(value))
    },
    remove: async (key) => {
      calls.remove.push(key)
      data.delete(key)
    },
    scan: async ({ prefix, limit = 50, after } = {}) => {
      calls.scan.push(prefix)
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = after ? Math.max(keys.indexOf(after) + 1, 0) : 0
      const page = keys.slice(start, start + limit)
      const entries = page.map((key) => ({ key, value: clone(data.get(key)) }))
      return { entries, next: start + limit < keys.length ? page.at(-1) : undefined }
    },
  }
}

// Registers the plugin for real and hands back the callback it registered, so
// the lifecycle tests exercise the setup hook instead of internals. The
// threshold goes through plugin options, which floor at 10000, so the fixtures
// above sit either side of that rather than of an arbitrary number.
const THRESHOLD = 10_000

async function pluginHarness({ threshold = THRESHOLD, storage = memoryStorage(), plugin = AutoHandoffPlugin,
  sessionLookup = async ({ sessionID }) => ({ id: sessionID }) } = {}) {
  const registrations = []
  const calls = { synthetic: [], create: [], prompt: [], get: [] }
  const ctx = {
    options: { threshold },
    session: {
      get: async (input) => {
        calls.get.push(input)
        return sessionLookup(input)
      },
      hook: async (name, callback) => {
        const registration = { name, callback, disposed: 0 }
        registrations.push(registration)
        return {
          dispose: async () => {
            registration.disposed += 1
          },
        }
      },
      synthetic: async (input) => {
        calls.synthetic.push(input)
        return { data: { id: `msg_${calls.synthetic.length}` } }
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
    storage,
  }
  const cleanup = await plugin.setup(ctx)
  const registration = registrations[0]
  return { calls, ctx, cleanup, registrations, request: (event) => registration.callback(event), storage }
}

// The plugin logs through console.error; collect it instead of printing it.
async function quiet(body) {
  const original = console.error
  const logs = []
  console.error = (...args) => logs.push(args.join(" "))
  try {
    return await body(logs)
  } finally {
    console.error = original
  }
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

test("stays below the threshold while the request is small", async () => {
  const monitor = createMonitor({ threshold: 1000, log: () => {}, session: {}, storage: memoryStorage() })
  assert.equal(await monitor.observe(smallEvent()), "below")
  assert.equal(monitor.state.status, "watching")
  assert.ok(monitor.state.tokens > 0)
  assert.equal(await monitor.observe(overThresholdEvent()), "over")
  assert.equal(monitor.state.status, "requested")
})

test("registers only the context hook and never subscribes to events", async () => {
  await quiet(async () => {
    const h = await pluginHarness()
    assert.deepEqual(
      h.registrations.map((registration) => registration.name),
      ["context"],
    )
    await h.cleanup()
    assert.equal(h.registrations[0].disposed, 1)
  })
})

test("keeps watching a session that starts small and steers it once over the threshold", async () => {
  await quiet(async () => {
    const h = await pluginHarness()
    await h.request(smallEvent())
    assert.equal(h.calls.synthetic.length, 0)
    // Every later request is still measured, so the crossing is noticed even
    // though the session's first request was tiny.
    await h.request(overThresholdEvent())
    await h.request(overThresholdEvent())
    await h.request(overThresholdEvent())
    assert.equal(h.calls.synthetic.length, 1)
    const steer = h.calls.synthetic[0]
    assert.equal(steer.sessionID, "ses_test")
    assert.equal(steer.description, "auto-handoff")
    assert.match(steer.text, /handoff skill/)
    assert.match(steer.text, /do a handoff/)
    assert.match(steer.text, /no new direction from the user/)
    assert.match(steer.text, /Then stop/)
    // The plugin steers only; it names no document path and spawns nothing.
    assert.ok(!steer.text.includes("/tmp/"))
    assert.equal(h.calls.create.length, 0)
    assert.equal(h.calls.prompt.length, 0)
    await h.cleanup()
  })
})

test("records nothing while a session stays below the threshold", async () => {
  await quiet(async () => {
    const h = await pluginHarness()
    await h.request(smallEvent())
    await h.request(smallEvent())
    assert.deepEqual(h.storage.calls.set, [])
    // Dedupe needs only exact-key reads, never a scan it could misread: the
    // legacy list, then this session's own key.
    assert.deepEqual(h.storage.calls.scan, [])
    assert.deepEqual(h.storage.calls.get, ["handoffs", "handoff/ses_test"])
    await h.cleanup()
  })
})

test("reserves one durable record per session and steers exactly once", async () => {
  await quiet(async () => {
    const h = await pluginHarness()
    await h.request(overThresholdEvent("ses_a"))
    await h.request(overThresholdEvent("ses_b"))
    await h.request(overThresholdEvent("ses_a"))
    assert.equal(h.calls.synthetic.length, 2)
    assert.deepEqual(
      h.storage.calls.set.map(([key]) => key),
      ["handoff/ses_a", "handoff/ses_b"],
    )
    // Each session gets its own key, so one record can never evict another's.
    const record = h.storage.data.get("handoff/ses_a")
    assert.equal(record.sessionID, "ses_a")
    assert.ok(record.tokens > 1000)
    assert.equal(typeof record.at, "string")
    await h.cleanup()
  })
})

test("writes the record before the steer, so a crash cannot double-steer", async () => {
  await quiet(async () => {
    const order = []
    const storage = memoryStorage()
    const original = storage.set
    storage.set = async (key, value) => {
      order.push(`set:${key}`)
      await original(key, value)
    }
    const h = await pluginHarness({ storage })
    const originalSynthetic = h.ctx.session.synthetic
    h.ctx.session.synthetic = async (input) => {
      order.push(`steer:${input.sessionID}`)
      return originalSynthetic(input)
    }
    await h.request(overThresholdEvent("ses_a"))
    assert.deepEqual(order, ["set:handoff/ses_a", "steer:ses_a"])
    await h.cleanup()
  })
})

test("keeps both sessions deduped across a server reload", async () => {
  await quiet(async () => {
    const storage = memoryStorage()
    const first = await pluginHarness({ storage })
    await first.request(overThresholdEvent("ses_a"))
    await first.request(overThresholdEvent("ses_b"))
    assert.equal(first.calls.synthetic.length, 2)
    await first.cleanup()

    // A fresh module instance is a real reload: no in-memory monitors survive.
    const { AutoHandoffPlugin: reloaded } = await import(`../auto-handoff.js?reload=${Date.now()}`)
    const second = await pluginHarness({ storage, plugin: reloaded })
    const writesBefore = storage.calls.set.length
    await second.request(overThresholdEvent("ses_a"))
    await second.request(overThresholdEvent("ses_b"))
    assert.equal(second.calls.synthetic.length, 0)
    assert.deepEqual(storage.calls.set.slice(writesBefore), [])
    // A session first seen after the reload is still watched normally.
    await second.request(smallEvent("ses_c"))
    await second.request(overThresholdEvent("ses_c"))
    assert.equal(second.calls.synthetic.length, 1)
    assert.equal(second.calls.synthetic[0].sessionID, "ses_c")
    await second.cleanup()
  })
})

test("steers once for concurrent over-threshold requests of one session", async () => {
  await quiet(async () => {
    const h = await pluginHarness()
    const event = overThresholdEvent("ses_a")
    await Promise.all([h.request(event), h.request(event), h.request(event), h.request(event)])
    assert.equal(h.calls.synthetic.length, 1)
    assert.equal(h.storage.calls.set.length, 1)
    assert.equal(h.calls.get.length, 1)
    await h.cleanup()
  })
})

test("keeps concurrent sessions independent", async () => {
  await quiet(async () => {
    const h = await pluginHarness()
    await Promise.all([
      h.request(overThresholdEvent("ses_a")),
      h.request(overThresholdEvent("ses_b")),
      h.request(smallEvent("ses_c")),
      h.request(overThresholdEvent("ses_a")),
    ])
    assert.deepEqual(
      h.calls.synthetic.map((input) => input.sessionID).sort(),
      ["ses_a", "ses_b"],
    )
    assert.deepEqual(
      h.storage.calls.set.map(([key]) => key).sort(),
      ["handoff/ses_a", "handoff/ses_b"],
    )
    await h.cleanup()
  })
})

test("cleanup unregisters the hook and keeps the durable dedupe", async () => {
  await quiet(async () => {
    const storage = memoryStorage()
    const h = await pluginHarness({ storage })
    await h.request(overThresholdEvent("ses_a"))
    await h.cleanup()
    assert.equal(h.registrations[0].disposed, 1)

    // Same process, monitors gone: the record, not memory, is what prevents a
    // second steer.
    const again = await pluginHarness({ storage })
    await again.request(overThresholdEvent("ses_a"))
    assert.equal(again.calls.synthetic.length, 0)
    await again.cleanup()
  })
})

test("honors the legacy capped handoffs list without rewriting it", async () => {
  await quiet(async () => {
    const legacy = [{ sessionID: "ses_old", tokens: 251_000 }, { sessionID: "ses_test", tokens: 251_000 }]
    const storage = memoryStorage({ handoffs: legacy })
    const h = await pluginHarness({ storage })
    await h.request(overThresholdEvent("ses_test"))
    assert.equal(h.calls.synthetic.length, 0)
    assert.deepEqual(h.storage.calls.set, [])
    // A session the legacy list never saw is recorded the new way, and the
    // legacy key is left exactly as it was found.
    await h.request(overThresholdEvent("ses_new"))
    assert.equal(h.calls.synthetic.length, 1)
    assert.deepEqual(
      h.storage.calls.set.map(([key]) => key),
      ["handoff/ses_new"],
    )
    assert.deepEqual(storage.data.get("handoffs"), legacy)
    assert.deepEqual(h.storage.calls.remove, [])
    await h.cleanup()
  })
})

test("steers when the record cannot be written, and only once", async () => {
  await quiet(async (logs) => {
    const storage = memoryStorage()
    storage.set = async () => {
      throw new Error("disk full")
    }
    const h = await pluginHarness({ storage })
    await h.request(overThresholdEvent("ses_a"))
    await h.request(overThresholdEvent("ses_a"))
    // Losing the record must not cost the session its steer, and the monitor
    // still guards against repeating it in this process.
    assert.equal(h.calls.synthetic.length, 1)
    assert.ok(logs.some((line) => line.includes("could not record handoff") && line.includes("disk full")))
    await h.cleanup()
  })
})

test("steers when storage cannot be read at all", async () => {
  await quiet(async () => {
    const storage = memoryStorage()
    storage.get = async () => {
      throw new Error("storage offline")
    }
    const h = await pluginHarness({ storage })
    await h.request(overThresholdEvent("ses_a"))
    await h.request(overThresholdEvent("ses_a"))
    assert.equal(h.calls.synthetic.length, 1)
    await h.cleanup()
  })
})

test("records the failure and stops steering that session when the steer throws", async () => {
  await quiet(async (logs) => {
    const h = await pluginHarness()
    h.ctx.session.synthetic = async () => {
      throw new Error("session busy")
    }
    await h.request(overThresholdEvent("ses_a"))
    await h.request(overThresholdEvent("ses_a"))
    assert.equal(h.storage.calls.set.length, 1)
    assert.ok(logs.some((line) => line.includes("failed") && line.includes("session busy")))
    await h.cleanup()
  })
})

test("ignores requests without a usable session id", async () => {
  await quiet(async () => {
    const h = await pluginHarness()
    await h.request(null)
    await h.request({ ...overThresholdEvent(), sessionID: "" })
    await h.request({ ...overThresholdEvent(), sessionID: 7 })
    assert.equal(h.calls.synthetic.length, 0)
    assert.deepEqual(h.storage.calls.set, [])
    await h.cleanup()
  })
})

test("the steer instructs the agent to use the skill rather than restating the format", () => {
  const text = handoffInstruction({ threshold: 250000, tokens: 251234.5 })
  assert.match(text, /251235 tokens/)
  assert.match(text, /handoff threshold 250000/)
  assert.ok(!text.includes("## Objective"))
  assert.ok(!text.includes("tmux"))
})

test("a record key is the session's own durable identity", () => {
  assert.equal(recordKey("ses_test"), "handoff/ses_test")
  // Session ids carry no separator that could collide across sessions.
  assert.notEqual(recordKey("ses_a"), recordKey("ses_b"))
})

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test("location instances have independent thresholds, clients and cleanup", async () => {
  const first = await pluginHarness({ threshold: 30_000 })
  const second = await pluginHarness()
  await first.request(overThresholdEvent())
  await second.request(overThresholdEvent())
  assert.equal(first.calls.synthetic.length, 0)
  assert.equal(second.calls.synthetic.length, 1)
  await second.cleanup()
  await first.request(requestEvent({ messages: [textMessage("x".repeat(160_000))] }))
  assert.equal(first.calls.synthetic.length, 1)
  await first.cleanup()
})

test("unload during a storage read prevents a late reservation or steer", async () => {
  const entered = deferred()
  const release = deferred()
  const storage = memoryStorage()
  const get = storage.get
  storage.get = async (key) => {
    entered.resolve()
    await release.promise
    return get(key)
  }
  const h = await pluginHarness({ storage })
  const pending = h.request(overThresholdEvent())
  await entered.promise
  await h.cleanup()
  release.resolve()
  await pending
  await h.request(overThresholdEvent())
  assert.equal(h.calls.synthetic.length, 0)
  assert.equal(storage.calls.set.length, 0)
})

test("unload during reservation preserves the record but prevents a late steer", async () => {
  const entered = deferred()
  const release = deferred()
  const storage = memoryStorage()
  const set = storage.set
  storage.set = async (...args) => {
    entered.resolve()
    await release.promise
    return set(...args)
  }
  const h = await pluginHarness({ storage })
  const pending = h.request(overThresholdEvent())
  await entered.promise
  await h.cleanup()
  release.resolve()
  await pending
  assert.equal(h.calls.synthetic.length, 0)
  assert.equal(storage.calls.set.length, 1)
  const next = await pluginHarness({ storage })
  await next.request(overThresholdEvent())
  assert.equal(next.calls.synthetic.length, 0)
  await next.cleanup()
})

test("direct concurrent triggers reserve only once", async () => {
  let steers = 0
  const monitor = createMonitor({ threshold: THRESHOLD, storage: memoryStorage(), session: {
    synthetic: async () => { steers++ },
  } })
  await monitor.observe(overThresholdEvent())
  await Promise.all([monitor.trigger(), monitor.trigger()])
  assert.equal(steers, 1)
})

test("children and nested children never reserve or receive successor steers", async () => {
  const sessions = {
    ses_root: { id: "ses_root" },
    ses_child: { id: "ses_child", parentID: "ses_root" },
    ses_nested: { id: "ses_nested", parentID: "ses_child" },
  }
  const h = await pluginHarness({ sessionLookup: async ({ sessionID }) => sessions[sessionID] })
  for (const agent of ["general", "explore"]) {
    for (const sessionID of ["ses_child", "ses_nested"]) {
      await h.request({ ...overThresholdEvent(sessionID), agent })
    }
  }
  assert.deepEqual(h.calls.synthetic, [])
  assert.deepEqual(h.storage.calls.set, [])
  await h.request(overThresholdEvent("ses_root"))
  assert.equal(h.calls.synthetic.length, 1)
  assert.equal(h.calls.synthetic[0].sessionID, "ses_root")
  assert.equal(h.calls.get.length, 3, "each known session's scope is looked up once")
  await h.cleanup()
})

test("missing, malformed and failed scope lookups fail closed and can recover on a later request", async () => {
  await quiet(async () => {
    let lookup = 0
    const h = await pluginHarness({ sessionLookup: async ({ sessionID }) => {
      lookup++
      if (lookup === 1) throw new Error("lookup offline")
      if (lookup === 2) return null
      if (lookup === 3) return {}
      if (lookup === 4) return { id: "ses_other" }
      return { id: sessionID }
    } })
    for (let i = 0; i < 4; i++) await h.request(overThresholdEvent())
    assert.equal(h.calls.synthetic.length, 0)
    assert.equal(h.storage.calls.set.length, 0)
    await h.request(overThresholdEvent())
    assert.equal(h.calls.synthetic.length, 1)
    await h.cleanup()
  })
})

test("unload during a scope lookup prevents a late reservation or steer", async () => {
  const entered = deferred()
  const release = deferred()
  const h = await pluginHarness({ sessionLookup: async ({ sessionID }) => {
    entered.resolve()
    await release.promise
    return { id: sessionID }
  } })
  const pending = h.request(overThresholdEvent())
  await entered.promise
  await h.cleanup()
  release.resolve()
  await pending
  assert.equal(h.calls.synthetic.length, 0)
  assert.equal(h.storage.calls.set.length, 0)
})
