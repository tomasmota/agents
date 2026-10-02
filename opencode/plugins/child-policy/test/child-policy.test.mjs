import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Scope, Exit, Fiber } from "effect"
import { Tool } from "@opencode/schema/tool"
import plugin, { CHILD_MODEL } from "../index.js"

async function harness(t, { available = true, options = {}, execute = (input) => Effect.succeed(input), models, session } = {}) {
  const scope = await Effect.runPromise(Scope.make())
  const transforms = []
  let permission
  const rebuild = () => {
    const tool = { id: "subagent", execute, description: "Native fixture", options: { codemode: true } }
    for (const transform of transforms) transform({ get: (id) => id === "subagent" ? tool : undefined, update: (_, edit) => edit(tool) })
    return tool
  }
  const ctx = { options,
    model: { list: () => models ?? Effect.succeed({ data: available ? [{ providerID: "opencode", id: "space-bunny-free" }] : [] }) },
    tool: { transform: (callback) => Effect.sync(() => { transforms.push(callback); return { dispose: Effect.void } }), list: () => Effect.sync(() => [rebuild()]) },
    permission: { hook: (_, callback) => Effect.sync(() => { permission = callback; return { dispose: Effect.void } }) },
    session: { get: ({ sessionID }) => session ?? Effect.succeed({ parentID: sessionID === "primary" ? undefined : "parent" }) },
  }
  await Effect.runPromise(plugin.effect(ctx).pipe(Effect.provideService(Scope.Scope, scope)))
  const cleanup = () => Effect.runPromise(Scope.close(scope, Exit.void))
  t.after(cleanup)
  return { get tool() { return rebuild() }, permission, cleanup }
}
const run = Effect.runPromise
const typedFailure = async (effect, pattern) => {
  const exit = await Effect.runPromiseExit(effect)
  assert.equal(exit._tag, "Failure")
  assert.equal(exit.cause.reasons.length, 1)
  assert.equal(exit.cause.reasons[0]._tag, "Fail", "must be a handled failure, not a defect")
  assert.equal(exit.cause.reasons[0].error._tag, "Tool.Error")
  if (pattern) assert.match(exit.cause.reasons[0].error.message, pattern)
  return exit.cause.reasons[0].error
}

test("default, explicit overrides and nested dispatch preserve native result/context and free model", async (t) => {
  const context = { sessionID: "parent", progress: () => Effect.void }
  const h = await harness(t, { execute: (input, ctx) => Effect.sync(() => { assert.equal(ctx, context); return { content: "fixture", output: input, metadata: { fixture: true } } }) })
  for (const input of [{ agent: "general" }, { agent: "reviewer", model: "example/paid#max" }, { agent: "explore", model: "example/other" }]) {
    const original = structuredClone(input)
    const result = await run(h.tool.execute(input, context))
    assert.equal(result.output.model, CHILD_MODEL)
    assert.equal(result.content, "fixture")
    assert.deepEqual(input, original)
  }
  assert.equal(h.tool.description, "Native fixture")
  assert.deepEqual(h.tool.options, { codemode: true })
})
test("native permission, depth and child errors retain the typed error channel", async (t) => {
  const error = new Tool.Error({ message: "Native denied fixture" })
  const h = await harness(t, { execute: () => Effect.fail(error) })
  assert.equal(await typedFailure(h.tool.execute({}, {})), error)
  assert.equal(await run(h.tool.execute({}, {}).pipe(Effect.catchTag("Tool.Error", () => Effect.succeed("handled")))), "handled")
})
test("regression control: the installed Promise-adapter pattern turns rejection into a defect", async () => {
  const native = Effect.fail(new Tool.Error({ message: "fictional native denial" }))
  const exit = await Effect.runPromiseExit(Effect.promise(() => run(native)))
  assert.equal(exit.cause.reasons[0]._tag, "Die")
})
test("unavailable model and failed preparation refuse with typed errors without dispatch", async (t) => {
  let called = false
  for (const config of [{ available: false }, { models: Effect.fail(new Error("fictional model lookup outage")) }]) {
    const h = await harness(t, { ...config, execute: () => Effect.sync(() => { called = true }) })
    await typedFailure(h.tool.execute({}, {}), /availability|unavailable/)
  }
  assert.equal(called, false)
})
test("continuation authorization stays native; policy never switches primary, foreign, sibling or denied child", async (t) => {
  const h = await harness(t, { execute: (input) => input.sessionID === "direct-child" ? Effect.succeed(input) : Effect.fail(new Tool.Error({ message: "Native authorization failed" })) })
  for (const sessionID of ["primary", "foreign-child", "sibling", "denied-agent", "unknown-agent", "too-deep"]) {
    await typedFailure(h.tool.execute({ sessionID }, { sessionID: "parent" }), /Native authorization/)
  }
  assert.equal((await run(h.tool.execute({ sessionID: "direct-child" }, {}))).model, CHILD_MODEL)
  // No switchModel API exists in this harness: a premature mutation would fail.
})
test("Coder bounds foreground dispatch, releases capacity on failure, and replay never double-wraps", async (t) => {
  let release
  let entered
  const ready = new Promise((resolve) => { entered = resolve })
  const h = await harness(t, { options: { maxConcurrent: 1, forceForeground: true }, execute: (input) => Effect.promise(() => { entered(); return new Promise((resolve) => { release = () => resolve(input) }) }) })
  const pending = run(h.tool.execute({ background: true }, {}))
  await ready
  await typedFailure(h.tool.execute({}, {}), /limit/)
  release()
  assert.equal((await pending).background, false)
  const next = run(h.tool.execute({}, {}))
  release()
  await next
})
test("interruption stops native execution and releases its dispatch slot", async (t) => {
  let entered
  const ready = new Promise((resolve) => { entered = resolve })
  let finalized = false
  let calls = 0
  const h = await harness(t, { options: { maxConcurrent: 1 }, execute: () => ++calls === 1
    ? Effect.sync(entered).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { finalized = true })))
    : Effect.succeed("capacity restored") })
  const fiber = await run(h.tool.execute({}, {}).pipe(Effect.forkDetach))
  await ready
  await run(Fiber.interrupt(fiber))
  assert.equal(finalized, true)
  assert.equal(await run(h.tool.execute({}, {})), "capacity restored")
})
test("interruption during preparation never reaches native execution", async (t) => {
  let entered
  const ready = new Promise((resolve) => { entered = resolve })
  let native = 0
  const h = await harness(t, { models: Effect.sync(entered).pipe(Effect.andThen(Effect.never)), execute: () => Effect.sync(() => { native++ }) })
  const fiber = await run(h.tool.execute({}, {}).pipe(Effect.forkDetach))
  await ready
  await run(Fiber.interrupt(fiber))
  assert.equal(native, 0)
})
test("permission policy leaves primaries and configured denies alone; failed lookup denies", async (t) => {
  const h = await harness(t)
  for (const sessionID of ["primary", "child"]) {
    const event = { sessionID, agent: "explore", action: "shell", resources: ["touch fictional"], effect: "allow" }
    await run(h.permission(event))
    assert.equal(event.effect, sessionID === "primary" ? "allow" : "deny")
  }
  for (const role of ["general", "explore"]) {
    const event = { sessionID: "child", agent: "general", action: "subagent", resources: [role], effect: "ask" }
    await run(h.permission(event))
    assert.equal(event.effect, role === "explore" ? "ask" : "deny")
  }
  const denied = { sessionID: "child", agent: "explore", action: "read", resources: ["fixture"], effect: "deny" }
  await run(h.permission(denied)); assert.equal(denied.effect, "deny")
  const broken = await harness(t, { session: Effect.fail(new Error("fictional session lookup failed")) })
  const event = { sessionID: "missing", action: "read", resources: ["fixture"], effect: "allow" }
  await run(broken.permission(event)); assert.equal(event.effect, "deny")
})
test("unloaded captured tool snapshots refuse a typed dispatch", async (t) => {
  const h = await harness(t)
  const captured = h.tool.execute
  await h.cleanup()
  await typedFailure(captured({}, {}), /unloaded/)
})
