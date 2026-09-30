import assert from "node:assert/strict"
import test from "node:test"

import { buildCompletedTurn, buildTurnNameCandidates, createTmuxTitleNamer } from "../core.js"
import { createTmuxTitleController } from "../controller.js"

const user = (id, text, created) => ({ id, type: "user", text, time: { created } })
const assistant = (id, text, created) => ({
  id, type: "assistant", finish: "stop", time: { created, completed: created + 1 },
  content: [{ type: "text", text }],
})

test("selects the latest user message and final assistant output, not the opener", () => {
  const turn = buildCompletedTurn([
    assistant("a2", "Fixed broken CI by repairing the pipeline cache.", 4),
    user("u1", "Pull main", 1),
    assistant("a1", "Pulled main.", 2),
    user("u2", "Fix broken CI", 3),
  ])
  assert.equal(turn.request, "Fix broken CI")
  assert.equal(turn.response, "Fixed broken CI by repairing the pipeline cache.")
  assert.equal(buildCompletedTurn([user("u1", "Pull main", 1), assistant("a1", "Done", 2), user("u2", "Fix CI", 3)]), null)
})

test("ignores reasoning and tools, and requires a final text response", () => {
  const response = assistant("a1", "Fixed CI", 2)
  response.content.push({ type: "reasoning", text: "private reasoning" }, { type: "tool", text: "tool output" })
  assert.equal(buildCompletedTurn([user("u1", "Fix CI", 1), response]).response, "Fixed CI")
  response.finish = "tool-calls"
  assert.equal(buildCompletedTurn([user("u1", "Fix CI", 1), response]), null)
})

test("bounds both excerpts while preserving their beginnings and endings", () => {
  const turn = buildCompletedTurn([
    user("u1", `START${"x".repeat(5000)}END`, 1),
    assistant("a1", `RESULT${"y".repeat(6000)}CONCLUSION`, 2),
  ])
  assert.equal(turn.request.length, 2400)
  assert.equal(turn.response.length, 3200)
  assert.ok(turn.request.startsWith("START") && turn.request.endsWith("END"))
  assert.ok(turn.response.startsWith("RESULT") && turn.response.endsWith("CONCLUSION"))
})

test("replacement candidates cover the recent request and response, including terse follow-ups", () => {
  const candidates = buildTurnNameCandidates("Fix broken CI", "Fixed the pipeline cache")
  assert.ok(candidates.includes("fix-broken-ci"))
  assert.ok(candidates.includes("fix-pipeline-cache"))
  assert.ok(buildTurnNameCandidates("yes", "Implemented OAuth login").includes("build-oauth-login"))
  assert.ok(candidates.every((name) => name.length <= 30 && /^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/.test(name)))
})

function harness({ probability = 0.95, choice = "fix-broken-ci", fail = false, shouldApply } = {}) {
  const requests = []
  const renames = []
  let windowName = "demo:pull-main"
  const namer = createTmuxTitleNamer({
    env: { TMUX: "fake", TMUX_PANE: "%7" },
    requestJev: async (input) => {
      requests.push(input)
      if (fail) throw new Error("offline")
      if (shouldApply) await shouldApply()
      return { answers: {
        needs_update: { type: "noul", noul: probability },
        name: { type: "choice", choice, confidence: 0.6 },
      } }
    },
    spawnSync: (command, args) => {
      if (command === "git") return { status: 0, stdout: "/home/me/demo/.git\n" }
      if (args[0] === "display-message") return { status: 0, stdout: `${windowName}\n` }
      renames.push(args)
      windowName = args.at(-1)
      return { status: 0 }
    },
  })
  const input = { sessionID: "ses_demo", directory: "/home/me/demo", request: "Fix broken CI", response: "Fixed broken CI" }
  return { namer, input, requests, renames, setTitle: (title) => { windowName = title } }
}

test("asks Jev whether to update and what to call the work in one request", async () => {
  const { namer, input, requests, renames } = harness()
  assert.equal(await namer.review(input), "demo:fix-broken-ci")
  assert.equal(requests.length, 1)
  assert.deepEqual(Object.keys(requests[0].questions), ["needs_update", "name"])
  assert.equal(requests[0].state.current_title, "demo:pull-main")
  assert.equal(requests[0].state.latest_user_request, input.request)
  assert.equal(requests[0].state.final_assistant_message, input.response)
  assert.deepEqual(renames, [["rename-window", "-t", "%7", "demo:fix-broken-ci"]])
})

for (const [label, options] of [
  ["an adequate title", { probability: 0.1 }],
  ["an uncertain judgment", { probability: 0.6 }],
  ["an invalid replacement", { choice: "evil; command" }],
  ["an out-of-range probability", { probability: 2 }],
  ["a failed Jev request", { fail: true }],
]) {
  test(`keeps the current title for ${label}`, async () => {
    const { namer, input, renames } = harness(options)
    assert.equal(await namer.review(input), "demo:pull-main")
    assert.equal(renames.length, 0)
  })
}

test("does not apply a judgment after navigation or a newer turn", async () => {
  let current = true
  const { namer, input, renames } = harness({ shouldApply: () => { current = false } })
  assert.equal(await namer.review({ ...input, shouldApply: () => current }), null)
  assert.equal(renames.length, 0)
})

test("does not overwrite a tmux title changed while Jev was running", async () => {
  let changeTitle
  const h = harness({ shouldApply: () => changeTitle() })
  changeTitle = () => h.setTitle("demo:manual-name")
  assert.equal(await h.namer.review(h.input), null)
  assert.equal(h.renames.length, 0)
})

function controllerHarness({ review } = {}) {
  let route = { type: "session", sessionID: "ses_demo" }
  let status = "idle"
  let listener
  let poll
  const reviews = []
  const initial = []
  const messages = [user("u1", "Pull main", 1), assistant("a1", "Pulled main", 2)]
  const context = {
    ui: { router: { current: () => route } },
    data: {
      listen: (fn) => { listener = fn; return () => { listener = undefined } },
      session: {
        get: (id) => ({ title: "Pull main", parentID: id === "ses_child" ? "ses_demo" : undefined, location: { directory: "/home/me/demo" } }),
        status: () => status,
        message: { sync: async () => {}, invalidate: () => {}, list: () => messages },
      },
    },
  }
  const controller = createTmuxTitleController(context, {
    env: { TMUX: "fake", TMUX_PANE: "%7" },
    namer: {
      review: async (input) => { reviews.push(input); return review ? review(input) : "demo:current-task" },
      rename: async (input) => { initial.push(input); return "demo:pull-main" },
    },
    setInterval: (fn) => { poll = fn; return { unref() {} } },
    clearInterval: () => { poll = undefined },
    onError: (error) => assert.fail(String(error)),
  })
  const emit = (type, sessionID = "ses_demo", data = {}) => listener({ details: { type, data: { sessionID, ...data } } })
  return {
    controller, reviews, initial, messages, emit,
    setStatus: (value) => { status = value },
    navigate: (sessionID) => { route = { type: "session", sessionID }; poll() },
  }
}

test("reviews each completed turn despite an unchanged session title, but deduplicates completion events", async () => {
  const h = controllerHarness()
  await h.controller.settled()
  assert.equal(h.reviews.length, 1)
  h.setStatus("running")
  h.emit("session.execution.started")
  h.messages.push(user("u2", "Fix broken CI", 3), assistant("a2", "Fixed broken CI", 4))
  h.emit("session.step.ended")
  await h.controller.settled()
  assert.equal(h.reviews.length, 1)
  h.setStatus("idle")
  h.emit("session.execution.succeeded")
  h.emit("session.idle")
  h.emit("session.status", "ses_demo", { status: { type: "idle" } })
  await h.controller.settled()
  assert.equal(h.reviews.length, 2)
  assert.equal(h.reviews[1].request, "Fix broken CI")
  assert.equal(h.reviews[1].response, "Fixed broken CI")
  assert.equal(h.initial.length, 0)
  await h.controller.dispose()
})

test("ignores other sessions and subagents, and reviews resumed sessions on navigation", async () => {
  const h = controllerHarness()
  await h.controller.settled()
  h.emit("session.execution.succeeded", "ses_other")
  h.emit("session.execution.succeeded", "ses_child")
  await h.controller.settled()
  assert.equal(h.reviews.length, 1)
  h.navigate("ses_other")
  await h.controller.settled()
  h.navigate("ses_demo")
  await h.controller.settled()
  assert.equal(h.reviews.length, 3)
  await h.controller.dispose()
})

test("rejects an in-flight judgment when a newer turn starts, then reviews the new completion", async () => {
  let release
  let started
  const waiting = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const applied = []
  let first = true
  const h = controllerHarness({ review: async (input) => {
    if (first) {
      first = false
      started()
      await gate
    }
    if (!input.shouldApply()) return null
    applied.push(input.request)
    return "demo:current-task"
  } })
  await waiting
  h.setStatus("running")
  h.emit("session.execution.started")
  h.messages.push(user("u2", "Fix broken CI", 3), assistant("a2", "Fixed broken CI", 4))
  h.setStatus("idle")
  h.emit("session.execution.succeeded")
  release()
  await h.controller.settled()
  assert.deepEqual(applied, ["Fix broken CI"])
  assert.equal(h.reviews.length, 2)
  await h.controller.dispose()
})

test("rejects an in-flight judgment when the user navigates to another session", async () => {
  let release
  let started
  const waiting = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const applied = []
  let first = true
  const h = controllerHarness({ review: async (input) => {
    if (first) {
      first = false
      started()
      await gate
    }
    if (!input.shouldApply()) return null
    applied.push(input.sessionID)
    return "demo:current-task"
  } })
  await waiting
  h.navigate("ses_other")
  release()
  await h.controller.settled()
  assert.deepEqual(applied, ["ses_other"])
  await h.controller.dispose()
})

test("retains initial naming for a new session with no agent output yet", async () => {
  const h = controllerHarness()
  h.messages.splice(0, h.messages.length, user("u1", "Pull main", 1))
  h.setStatus("running")
  await h.controller.settled()
  assert.equal(h.reviews.length, 0)
  assert.equal(h.initial.length, 1)
  assert.equal(h.initial[0].request, "Pull main")
  await h.controller.dispose()
})
