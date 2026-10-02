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

function userMessage(id, text) {
  return { id, type: "user", text, time: { created: 1 } }
}

function assistantMessage(id) {
  return { id, type: "assistant", parts: [{ type: "text", text: "done" }], time: { created: 2 } }
}

function harness({ title = "Fix login bug", messages = [userMessage("m1", "fix the login bug")], verdict = null, generateError = null } = {}) {
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
  const retitler = createRetitler({ config: baseConfig, generate, session })
  return { retitler, calls, generations }
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
  const slow = createRetitler({ config: baseConfig, session: {
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
  const retitler = createRetitler({ config: baseConfig, session: {
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
