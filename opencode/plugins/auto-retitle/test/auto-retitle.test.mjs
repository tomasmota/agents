import assert from "node:assert/strict"
import test from "node:test"

import { AutoRetitlePlugin } from "../auto-retitle.js"

const {
  MAX_TITLE_CHARS,
  buildJudgePrompt,
  createRetitler,
  parseJudgeResponse,
  parseModelRef,
  recentUserTexts,
  retitleConfig,
} = AutoRetitlePlugin.__test()

const baseConfig = { model: { providerID: "openai", id: "gpt-6-luna", variant: "low" }, maxMessages: 3, userChars: 2000 }

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => { data.set(key, value) },
  }
}

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

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function userMessage(id, text) {
  return { id, type: "user", text, time: { created: 1 } }
}

function assistantMessage(id) {
  return { id, type: "assistant", parts: [{ type: "text", text: "done" }], time: { created: 2 } }
}

function harness({ title = "Fix login bug", messages = [userMessage("m1", "fix the login bug")], verdict = null,
  generateError = null, storage = memoryStorage() } = {}) {
  const calls = []
  const session = {
    get: async (input) => {
      calls.push(["get", input])
      return { id: input.sessionID, title }
    },
    context: async (input) => {
      calls.push(["context", input])
      return messages
    },
    update: async (input) => {
      calls.push(["update", input])
    },
  }
  const generations = []
  const generate = async (input) => {
    generations.push(input)
    if (generateError) throw generateError
    return { text: verdict }
  }
  const retitler = createRetitler({ config: baseConfig, generate, session, storage })
  return { retitler, calls, generations, storage }
}

test("parses provider/model#variant refs with fallback", () => {
  assert.deepEqual(parseModelRef("openai/gpt-6-luna#low"), { providerID: "openai", id: "gpt-6-luna", variant: "low" })
  assert.deepEqual(parseModelRef("anthropic/claude-sonnet-4-6"), { providerID: "anthropic", id: "claude-sonnet-4-6" })
  assert.deepEqual(parseModelRef("bogus", "openai/gpt-6-luna#low"), { providerID: "openai", id: "gpt-6-luna", variant: "low" })
  assert.deepEqual(parseModelRef(undefined), { providerID: "openai", id: "gpt-6-luna", variant: "low" })
})

test("reads config from options before env", () => {
  assert.deepEqual(retitleConfig({}, {}), {
    model: { providerID: "openai", id: "gpt-6-luna", variant: "low" },
    maxMessages: 3,
    userChars: 2000,
  })
  const env = { OPENCODE_RETITLE_MODEL: "anthropic/claude-sonnet-4-6", OPENCODE_RETITLE_MAX_MESSAGES: "5" }
  const fromEnv = retitleConfig({}, env)
  assert.equal(fromEnv.model.id, "claude-sonnet-4-6")
  assert.equal(fromEnv.maxMessages, 5)
  assert.equal(retitleConfig({ maxMessages: 2 }, env).maxMessages, 2)
  assert.equal(retitleConfig({ maxMessages: 99 }, {}).maxMessages, 3)
})

test("collects newest user texts within budget", () => {
  const messages = [
    userMessage("m1", "first"),
    assistantMessage("a1"),
    userMessage("m2", "  "),
    userMessage("m3", "second"),
    { id: "s1", type: "system", text: "ignored" },
  ]
  assert.deepEqual(
    recentUserTexts(messages, { maxMessages: 3, userChars: 2000 }).map((entry) => entry.text),
    ["first", "second"],
  )
  assert.deepEqual(recentUserTexts(messages, { maxMessages: 1, userChars: 2000 }).map((entry) => entry.id), ["m3"])
  const long = recentUserTexts([userMessage("m1", "abcdefghij")], { maxMessages: 3, userChars: 4 })
  assert.equal(long[0].text, "abcd")
  assert.equal(recentUserTexts("nope", baseConfig).length, 0)
})

test("judge prompt carries title and messages", () => {
  const prompt = buildJudgePrompt("Fix login bug", [{ id: "m1", text: "now add dark mode" }])
  assert.match(prompt, /Fix login bug/)
  assert.match(prompt, /now add dark mode/)
  assert.match(prompt, /JSON only/)
})

test("parses judge verdicts defensively", () => {
  assert.deepEqual(
    parseJudgeResponse('{"needs_update": true, "title": "Add dark mode"}', "Fix login bug"),
    { needs_update: true, title: "Add dark mode" },
  )
  assert.deepEqual(
    parseJudgeResponse('```json\n{"needs_update": false, "title": "Fix login bug"}\n```', "Fix login bug"),
    { needs_update: false, title: "Fix login bug" },
  )
  assert.equal(parseJudgeResponse("not json", "Fix login bug"), null)
  assert.equal(parseJudgeResponse('{"needs_update": "yes", "title": "x"}', "Fix login bug"), null)
  assert.equal(parseJudgeResponse('{"needs_update": true, "title": "Fix login bug"}', "Fix login bug"), null)
  assert.equal(parseJudgeResponse('{"needs_update": true, "title": "FIX LOGIN BUG"}', "Fix login bug"), null)
  assert.equal(parseJudgeResponse('{"needs_update": true, "title": ""}', "Fix login bug"), null)
  assert.equal(parseJudgeResponse(`{"needs_update": true, "title": "${"x".repeat(MAX_TITLE_CHARS + 1)}"}`, "Fix"), null)
})

test("no title means nothing to evaluate", async () => {
  const { retitler, generations } = harness({ title: "" })
  await retitler.evaluate("ses_1")
  assert.equal(generations.length, 0)
})

test("judge saying no change renames nothing", async () => {
  const { retitler, calls, generations } = harness({ verdict: '{"needs_update": false, "title": "Fix login bug"}' })
  retitler.renamed("ses_1", "Fix login bug")
  await retitler.evaluate("ses_1")
  assert.equal(generations.length, 1)
  assert.deepEqual(generations[0].model, baseConfig.model)
  assert.ok(!calls.some(([name]) => name === "update"))
})

test("judge detecting new focus renames the session", async () => {
  const { retitler, calls } = harness({ verdict: '{"needs_update": true, "title": "Add dark mode"}' })
  retitler.renamed("ses_1", "Fix login bug")
  await retitler.evaluate("ses_1")
  assert.deepEqual(calls.at(-1), ["update", { sessionID: "ses_1", title: "Add dark mode" }])
  // Our own rename event is consumed, not treated as manual.
  retitler.renamed("ses_1", "Add dark mode")
  assert.equal(retitler.states.get("ses_1").optedOut, false)
})

test("own rename arriving after evaluation is not manual", async () => {
  const { retitler, calls } = harness({ verdict: '{"needs_update": true, "title": "Add dark mode"}' })
  await retitler.evaluate("ses_1")
  assert.ok(calls.some(([name]) => name === "update"))
  retitler.renamed("ses_1", "Add dark mode")
  assert.equal(retitler.states.get("ses_1").optedOut, false)
})

test("same messages are not evaluated twice", async () => {
  const { retitler, generations } = harness({ verdict: '{"needs_update": false, "title": "Fix login bug"}' })
  await retitler.evaluate("ses_1")
  await retitler.evaluate("ses_1")
  assert.equal(generations.length, 1)
})

test("new user messages trigger a fresh evaluation", async () => {
  const messages = [userMessage("m1", "fix the login bug")]
  const { retitler, generations } = harness({ messages, verdict: '{"needs_update": false, "title": "Fix login bug"}' })
  await retitler.evaluate("ses_1")
  messages.push(userMessage("m2", "now add dark mode instead"))
  await retitler.evaluate("ses_1")
  assert.equal(generations.length, 2)
})

test("first external title is adopted, later ones opt out", async () => {
  const { retitler, generations } = harness({ verdict: '{"needs_update": false, "title": "Fix login bug"}' })
  retitler.renamed("ses_1", "Fix login bug")
  assert.equal(retitler.states.get("ses_1").optedOut, false)
  await retitler.evaluate("ses_1")
  assert.equal(generations.length, 1)
  retitler.renamed("ses_1", "My manual title")
  assert.equal(retitler.states.get("ses_1").optedOut, true)
  await retitler.evaluate("ses_1")
  assert.equal(generations.length, 1)
})

test("concurrent evaluations run the judge once", async () => {
  const { retitler, generations } = harness({ verdict: '{"needs_update": false, "title": "Fix login bug"}' })
  void retitler.evaluate("ses_1")
  void retitler.evaluate("ses_1")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(generations.length, 1)
})

test("judge failures never break the session", async () => {
  const { retitler, calls } = harness({ generateError: new Error("boom") })
  await retitler.evaluate("ses_1")
  assert.ok(!calls.some(([name]) => name === "update"))
})

test("garbage verdicts rename nothing", async () => {
  const { retitler, calls } = harness({ verdict: "definitely update!!" })
  await retitler.evaluate("ses_1")
  assert.ok(!calls.some(([name]) => name === "update"))
})

test("a manual rename during the judge cannot be overwritten", async () => {
  const { retitler, calls } = harness({ verdict: '{"needs_update":true,"title":"Other task"}' })
  // Baseline established, then the judge is deliberately suspended.
  retitler.renamed("ses_1", "Fix login bug")
  let release
  const slow = createRetitler({ config: baseConfig, storage: memoryStorage(), session: {
    get: async () => ({ title: "Fix login bug" }),
    context: async () => [userMessage("m1", "change focus")],
    update: async () => calls.push(["unexpected-update"]),
  }, generate: () => new Promise((resolve) => { release = resolve }) })
  const pending = slow.evaluate("ses_1")
  while (!release) await Promise.resolve()
  slow.renamed("ses_1", "My manual title")
  release({ text: '{"needs_update":true,"title":"Other task"}' })
  await pending
  assert.ok(!calls.some(([name]) => name.includes("update")))
})

test("unload while the judge is pending cannot rename", async () => {
  let release
  let updates = 0
  const retitler = createRetitler({ config: baseConfig, storage: memoryStorage(), session: {
    get: async () => ({ title: "Original" }),
    context: async () => [userMessage("m1", "new topic")],
    update: async () => updates++,
  }, generate: () => new Promise((resolve) => { release = resolve }) })
  const pending = retitler.evaluate("ses_1")
  while (!release) await Promise.resolve()
  retitler.dispose()
  release({ text: '{"needs_update":true,"title":"New topic"}' })
  await pending
  assert.equal(updates, 0)
})

test("manual-title opt-outs survive plugin-instance reloads without storing the title", async () => {
  const storage = memoryStorage()
  const first = harness({ storage })
  first.retitler.renamed("ses_1", "Fix login bug")
  await first.retitler.renamed("ses_1", "My manual title")
  await first.retitler.dispose()
  assert.deepEqual([...storage.data], [["manual-title/ses_1", true]])

  const second = harness({ title: "My manual title", storage,
    verdict: '{"needs_update":true,"title":"Other task"}' })
  await second.retitler.evaluate("ses_1")
  assert.equal(second.generations.length, 0)
  assert.ok(!second.calls.some(([name]) => name === "update"))
  assert.equal(second.retitler.states.get("ses_1").optedOut, true)
  await second.retitler.dispose()
})

test("a missed manual rename detected during evaluation is also persisted", async () => {
  const h = harness({ title: "My manual title" })
  h.retitler.renamed("ses_1", "Fix login bug")
  await h.retitler.evaluate("ses_1")
  assert.equal(h.generations.length, 0)
  assert.equal(h.storage.data.get("manual-title/ses_1"), true)
  await h.retitler.dispose()
})

test("a manual rename discovered after judging persists even without its event", async () => {
  const storage = memoryStorage()
  let title = "Initial title"
  let updates = 0
  const session = {
    get: async () => ({ title }),
    context: async () => [userMessage("m1", "new task")],
    update: async () => { updates++ },
  }
  const retitler = createRetitler({ config: baseConfig, storage, session, generate: async () => {
    title = "My manual title"
    return { text: '{"needs_update":true,"title":"Other task"}' }
  } })
  await retitler.evaluate("ses_1")
  assert.equal(updates, 0)
  assert.equal(storage.data.get("manual-title/ses_1"), true)
  await retitler.dispose()
  const reloaded = harness({ title, storage, verdict: '{"needs_update":true,"title":"Other task"}' })
  await reloaded.retitler.evaluate("ses_1")
  assert.equal(reloaded.generations.length, 0)
  await reloaded.retitler.dispose()
})

test("unload waits for a pending manual opt-out write, but never for a judge", async () => {
  const storage = memoryStorage()
  const set = storage.set
  let release
  storage.set = async (key, value) => {
    await new Promise((resolve) => { release = resolve })
    await set(key, value)
  }
  const h = harness({ storage })
  h.retitler.renamed("ses_1", "Fix login bug")
  const write = h.retitler.renamed("ses_1", "My manual title")
  while (!release) await Promise.resolve()
  let unloaded = false
  const unloading = h.retitler.dispose().then(() => { unloaded = true })
  await Promise.resolve()
  assert.equal(unloaded, false)
  release()
  await write
  await unloading
  assert.equal(storage.data.get("manual-title/ses_1"), true)
})

test("a storage read outage fails closed, then retries protection before judging", async () => {
  const storage = memoryStorage({ "manual-title/ses_1": true })
  const get = storage.get
  let reads = 0
  storage.get = async (key) => {
    if (++reads === 1) throw new Error("storage offline")
    return get(key)
  }
  const h = harness({ storage, verdict: '{"needs_update":true,"title":"Other task"}' })
  await h.retitler.evaluate("ses_1")
  assert.equal(h.generations.length, 0)
  await h.retitler.evaluate("ses_1")
  assert.equal(reads, 2)
  assert.equal(h.generations.length, 0)
  await h.retitler.dispose()
})

test("failed persistence preserves the in-memory manual opt-out", async () => {
  const h = harness({ storage: {
    get: async () => undefined,
    set: async () => { throw new Error("disk full") },
  } })
  h.retitler.renamed("ses_1", "Fix login bug")
  await h.retitler.renamed("ses_1", "My manual title")
  await h.retitler.evaluate("ses_1")
  assert.equal(h.generations.length, 0)
  assert.equal(h.retitler.states.get("ses_1").optedOut, true)
  await h.retitler.dispose()
})

test("a failed opt-out write recovers on idle activity and remains protected after reload", async () => {
  await quiet(async () => {
    const storage = memoryStorage()
    const set = storage.set
    let attempts = 0
    storage.set = async (key, value) => {
      if (++attempts === 1) throw new Error("storage offline")
      await set(key, value)
    }
    const first = harness({ storage, verdict: '{"needs_update":true,"title":"Other task"}' })
    first.retitler.renamed("ses_1", "Fix login bug")
    await first.retitler.renamed("ses_1", "My manual title")
    assert.equal(attempts, 1)
    assert.equal(storage.data.size, 0)
    await first.retitler.evaluate("ses_1")
    assert.equal(attempts, 2)
    assert.equal(storage.data.get("manual-title/ses_1"), true)
    assert.equal(first.generations.length, 0)
    assert.ok(!first.calls.some(([name]) => name === "update"))
    await first.retitler.dispose()

    const reloaded = harness({ storage, title: "My manual title", verdict: '{"needs_update":true,"title":"Other task"}' })
    await reloaded.retitler.evaluate("ses_1")
    assert.equal(reloaded.generations.length, 0)
    assert.ok(!reloaded.calls.some(([name]) => name === "update"))
    await reloaded.retitler.dispose()
  })
})

test("outages retry on multiple activities and once at cleanup, with bounded logs and no judging", async () => {
  await quiet(async (logs) => {
    let attempts = 0
    const h = harness({ storage: {
      get: async () => undefined,
      set: async () => { attempts++; throw new Error(`offline ${"x".repeat(1000)}`) },
    }, verdict: '{"needs_update":true,"title":"Other task"}' })
    h.retitler.renamed("ses_1", "Fix login bug")
    await h.retitler.renamed("ses_1", "My manual title")
    await h.retitler.renamed("ses_1", "Another manual title")
    await h.retitler.evaluate("ses_1")
    assert.equal(attempts, 3)
    assert.equal(h.retitler.states.get("ses_1").optedOut, true)
    assert.equal(h.generations.length, 0)
    assert.ok(!h.calls.some(([name]) => name === "update"))
    await h.retitler.dispose()
    assert.equal(attempts, 4, "cleanup makes one final attempt, not an unbounded retry loop")
    assert.equal(logs.length, 4)
    assert.ok(logs.every((log) => log.length < 400 && !log.includes("x".repeat(201))))
  })
})

test("concurrent rename and idle activity coalesce a recovered dirty opt-out write", async () => {
  await quiet(async () => {
    const storage = memoryStorage()
    const set = storage.set
    const entered = deferred()
    const release = deferred()
    let attempts = 0
    storage.set = async (key, value) => {
      if (++attempts === 1) throw new Error("storage offline")
      entered.resolve()
      await release.promise
      await set(key, value)
    }
    const h = harness({ storage })
    h.retitler.renamed("ses_1", "Fix login bug")
    await h.retitler.renamed("ses_1", "My manual title")
    const activities = Promise.all([
      h.retitler.renamed("ses_1", "Another manual title"),
      h.retitler.evaluate("ses_1"),
      h.retitler.renamed("ses_1", "Another manual title"),
      h.retitler.evaluate("ses_1"),
    ])
    await entered.promise
    assert.equal(attempts, 2)
    release.resolve()
    await activities
    assert.equal(storage.data.get("manual-title/ses_1"), true)
    assert.equal(h.generations.length, 0)
    await h.retitler.evaluate("ses_1")
    await h.retitler.dispose()
    assert.equal(attempts, 2, "a durable opt-out is never written again")
  })
})

test("cleanup retries dirty opt-outs without waiting for an unresolved judge", { timeout: 1000 }, async (t) => {
  await quiet(async () => {
    const storage = memoryStorage()
    const set = storage.set
    const judgeEntered = deferred()
    const judge = deferred()
    t.after(() => judge.resolve({ text: '{"needs_update":true,"title":"Other task"}' }))
    let attempts = 0, updates = 0, finished = false
    storage.set = async (key, value) => {
      if (++attempts === 1) throw new Error("storage offline")
      await set(key, value)
    }
    const retitler = createRetitler({ config: baseConfig, storage, session: {
      get: async () => ({ title: "Initial title" }),
      context: async () => [userMessage("m1", "new task")],
      update: async () => { updates++ },
    }, generate: async () => {
      judgeEntered.resolve()
      return judge.promise
    } })
    const pending = retitler.evaluate("ses_1").then(() => { finished = true })
    await judgeEntered.promise
    await retitler.renamed("ses_1", "My manual title")
    await retitler.dispose()
    assert.equal(attempts, 2)
    assert.equal(storage.data.get("manual-title/ses_1"), true)
    assert.equal(finished, false, "cleanup returns before the suspended judge")
    judge.resolve({ text: '{"needs_update":true,"title":"Other task"}' })
    await pending
    assert.equal(updates, 0)
  })
})

test("cleanup retries a write that was in flight when unloading and then failed", async () => {
  await quiet(async () => {
    const storage = memoryStorage()
    const set = storage.set
    const entered = deferred()
    const firstWrite = deferred()
    let attempts = 0
    storage.set = async (key, value) => {
      if (++attempts === 1) {
        entered.resolve()
        await firstWrite.promise
      }
      await set(key, value)
    }
    const h = harness({ storage })
    h.retitler.renamed("ses_1", "Fix login bug")
    const write = h.retitler.renamed("ses_1", "My manual title")
    await entered.promise
    const unloading = h.retitler.dispose()
    assert.equal(h.retitler.dispose(), unloading, "concurrent cleanup shares the same drain and retry")
    firstWrite.reject(new Error("storage offline"))
    await write
    await unloading
    assert.equal(attempts, 2)
    assert.equal(storage.data.get("manual-title/ses_1"), true)
  })
})
