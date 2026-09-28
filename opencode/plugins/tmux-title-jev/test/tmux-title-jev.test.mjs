import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { tmuxTitleInternals } from "../core.js"

const { buildNameCandidates, createTmuxTitleNamer, firstUserText } = tmuxTitleInternals

test("lib/jev-client.js matches the canonical plugin copy", async () => {
  const local = await readFile(new URL("../lib/jev-client.js", import.meta.url), "utf8")
  const canonical = await readFile(new URL("../../auto-approve-jev/lib/jev-client.js", import.meta.url), "utf8")
  assert.equal(local, canonical)
})

test("builds bounded branch-like candidates", () => {
  const candidates = buildNameCandidates(
    "Auto-rename tmux tabs based on session work",
    "Have an agent in the background auto renames the tmux tab to something indicative of the work.",
  )

  assert.equal(candidates[0], "rename-tmux-tabs")
  assert.ok(candidates.includes("rename-tmux-tab"))
  assert.ok(candidates.length <= 240)
  assert.ok(candidates.every((name) => /^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/.test(name)))
  assert.ok(candidates.every((name) => name.length <= 30))
})

test("normalizes common action inflections and CI", () => {
  const candidates = buildNameCandidates("Fixing broken continuous integration checks")
  assert.equal(candidates[0], "fix-broken-ci")
})

test("lets Jev select a complete valid name and renames the owning window", async () => {
  const calls = []
  const namer = createTmuxTitleNamer({
    env: { TMUX: "/tmp/tmux", TMUX_PANE: "%7" },
    requestJev: async ({ questions }) => {
      assert.ok(questions.name.criteria["rename-tmux-tabs"] === null)
      return {
        model: "jev-test",
        answers: {
          name: { type: "choice", choice: "rename-tmux-tabs", confidence: 0.82, probabilities: {} },
        },
      }
    },
    spawnSync: (...args) => calls.push(args),
  })

  const name = await namer.rename({
    sessionID: "ses_1",
    title: "Auto-rename tmux tabs based on session work",
    request: "Rename the tab to match the work.",
  })

  assert.equal(name, "rename-tmux-tabs")
  assert.deepEqual(calls[0], ["tmux", ["rename-window", "-t", "%7", "rename-tmux-tabs"], { stdio: "ignore" }])
})

test("falls back deterministically when Jev is unavailable and deduplicates a title", async () => {
  const calls = []
  let requests = 0
  const namer = createTmuxTitleNamer({
    env: { TMUX: "/tmp/tmux", TMUX_PANE: "%3" },
    requestJev: async () => {
      requests++
      throw new Error("offline")
    },
    spawnSync: (...args) => calls.push(args),
  })

  const input = { sessionID: "ses_1", title: "Fixing broken continuous integration checks" }
  assert.equal(await namer.rename(input), "fix-broken-ci")
  assert.equal(await namer.rename(input), "fix-broken-ci")
  assert.equal(requests, 1)
  assert.equal(calls.length, 1)
})

test("does nothing outside tmux", async () => {
  let requested = false
  const namer = createTmuxTitleNamer({
    env: {},
    requestJev: async () => { requested = true },
    spawnSync: () => assert.fail("tmux should not run"),
  })
  assert.equal(await namer.rename({ sessionID: "ses_1", title: "Fix CI" }), null)
  assert.equal(requested, false)
})

test("extracts the first user text from TUI message records", () => {
  assert.equal(firstUserText([
    { info: { type: "assistant" }, parts: [{ type: "text", text: "hello" }] },
    { info: { type: "user" }, parts: [{ type: "text", text: "  fix the CI  " }] },
    { info: { type: "user", text: "later" }, parts: [] },
  ]), "fix the CI")
})
