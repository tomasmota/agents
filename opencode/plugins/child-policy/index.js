// Effect-native wrapping preserves the native Tool.Error channel and fiber
// interruption. The Promise adapter turns executor rejections into defects.
import { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"

export const CHILD_MODEL = "opencode/space-bunny-free"
const counts = (globalThis[Symbol.for("tomas.child-policy.dispatch")] ??= { active: 0 })
const marker = Symbol.for("tomas.child-policy.executor")
const fail = (message) => Effect.fail(new Tool.Error({ message }))

export default Plugin.define({
  id: "tomas.child-policy",
  effect: (ctx) => Effect.gen(function* () {
    let disposed = false
    const identity = {}
    const limit = ctx.options?.maxConcurrent ?? 4
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error("child-policy maxConcurrent must be 1..4")
    yield* Effect.addFinalizer(() => Effect.sync(() => { disposed = true }))
    yield* ctx.tool.transform((editor) => {
      const tool = editor.get("subagent")
      if (!tool) throw new Error("child-policy requires the V2 subagent tool")
      const native = tool.execute
      editor.update("subagent", (draft) => {
        const execute = (input, context) => Effect.gen(function* () {
          if (disposed) return yield* fail("child-policy unloaded; retry after configuration reload")
          const models = yield* ctx.model.list().pipe(Effect.mapError(() => new Tool.Error({ message: "Cannot verify free child availability; continue directly." })))
          if (disposed) return yield* fail("child-policy unloaded; retry after configuration reload")
          if (!Array.isArray(models?.data) || !models.data.some((model) => model.providerID === "opencode" && model.id === "space-bunny-free" && model.enabled !== false)) {
            return yield* fail(`${CHILD_MODEL} unavailable; no paid fallback. Continue directly in the primary session.`)
          }
          const next = { ...input, model: CHILD_MODEL }
          if (ctx.options?.forceForeground === true) next.background = false
          // Native continuation validates direct parent, agent, permissions and
          // depth before applying this explicit model. Never switch it early.
          return yield* Effect.acquireUseRelease(
            Effect.gen(function* () {
              if (disposed) return yield* fail("child-policy unloaded before dispatch")
              if (counts.active >= limit) return yield* fail("Child dispatch limit reached; continue directly or wait for a running child.")
              counts.active++
            }),
            () => native(next, context),
            () => Effect.sync(() => { counts.active-- }),
          )
        })
        execute[marker] = identity
        draft.execute = execute
      })
    })
    yield* ctx.permission.hook("evaluate", (event) => Effect.gen(function* () {
      if (disposed || !event.sessionID) return
      const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.catch(() => Effect.succeed(null)))
      // Failed lookup is an operation denial, never an implicit primary grant.
      const restricted = !session || (session.parentID && (
        event.action === "question" ||
        (event.action === "subagent" && (!event.resources?.length || event.resources.some((role) => role !== "explore"))) ||
        (event.agent === "reviewer" && ["edit", "write", "patch"].includes(event.action)) ||
        (event.agent === "explore" && !["read", "grep", "glob", "webfetch", "websearch"].includes(event.action))
      ))
      if (restricted) {
        event.effect = "deny"
        event.message = "Shared child policy: unverified session or forbidden child action; explore has no shell or mutation tools."
      }
    }))
    // Force registry materialization during setup, not after readiness. A failed
    // transform group can otherwise leave the native tool without this wrapper.
    const tools = yield* ctx.tool.list()
    if (tools.find((tool) => tool.id === "subagent")?.execute?.[marker] !== identity) throw new Error("child-policy executor self-check failed")
  }),
})
