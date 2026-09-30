import { spawnSync } from "node:child_process"

import { buildCompletedTurn, createTmuxTitleNamer, tmuxTitleInternals } from "./core.js"

const { firstUserText } = tmuxTitleInternals
const COMPLETION_EVENTS = new Set([
  "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle",
])

export function createTmuxTitleController(context, overrides = {}) {
  const runtime = {
    env: process.env, spawnSync, setInterval, clearInterval,
    onError: (error) => console.error("tmux-title-jev failed", error?.message ?? "unknown error"),
    ...overrides,
  }
  if (!runtime.env.TMUX) return
  const pane = runtime.env.TMUX_PANE || runtime.spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], {
    encoding: "utf8",
  }).stdout?.trim()
  if (!/^%\d+$/.test(pane ?? "")) return
  const namer = runtime.namer ?? createTmuxTitleNamer({ ...runtime, env: { ...runtime.env, TMUX_PANE: pane } })
  let work = Promise.resolve()
  let disposed = false
  let generation = 0
  let observedRoute
  let observedState
  let lastCompleted
  let lastInitial
  const pending = new Map()

  const current = () => {
    const route = context.ui.router.current()
    if (route.type !== "session" || !route.sessionID) return
    const session = context.data.session.get(route.sessionID)
    if (!session || session.parentID) return
    const directory = session.location?.directory || context.location?.directory || process.cwd()
    return { sessionID: route.sessionID, session, directory }
  }

  const evaluate = async (sessionID, directory) => {
    const epoch = generation
    const isCurrent = () => {
      const active = current()
      return !disposed && epoch === generation && active?.sessionID === sessionID && active.directory === directory
    }
    if (!isCurrent()) return
    // The data store applies message events before notifying plugin listeners.
    // Sync if needed, but do not invalidate a loaded transcript (which would
    // discard older pages the user has scrolled into).
    await context.data.session.message.sync(sessionID)
    if (!isCurrent()) return
    const messages = context.data.session.message.list(sessionID)
    const turn = buildCompletedTurn(messages)
    if (context.data.session.status(sessionID) !== "running" && turn) {
      const key = `${sessionID}\0${directory}\0${turn.key}`
      if (key === lastCompleted) return
      const shouldApply = () => isCurrent()
        && context.data.session.status(sessionID) !== "running"
        && buildCompletedTurn(context.data.session.message.list(sessionID))?.key === turn.key
      const name = await namer.review({ sessionID, directory, request: turn.request, response: turn.response, shouldApply })
      if (name !== null && shouldApply()) lastCompleted = key
      return
    }

    // Initial naming is only for genuinely new sessions. Do not revert a
    // resumed session to its opening request while another turn is streaming.
    if (messages?.some((message) => (message.info ?? message).type === "assistant")) return
    const title = current()?.session.title
    if (!title) return
    const request = firstUserText(messages)
    const key = `${sessionID}\0${directory}\0${title}\0${request}`
    if (key === lastInitial) return
    const name = await namer.rename({ sessionID, title, request, directory, shouldApply: isCurrent })
    if (name !== null && isCurrent()) lastInitial = key
  }

  const enqueue = (active) => {
    if (!active || disposed) return
    const { sessionID, directory } = active
    const key = `${sessionID}\0${directory}`
    const existing = pending.get(key)
    if (existing) {
      existing.dirty = true
      return
    }
    const job = { dirty: false }
    pending.set(key, job)
    work = work.then(async () => {
      do {
        job.dirty = false
        await evaluate(sessionID, directory)
      } while (job.dirty && !disposed)
    }).catch(runtime.onError).finally(() => pending.delete(key))
  }

  const inspectCurrent = () => {
    const active = current()
    const routeKey = active ? `${active.sessionID}\0${active.directory}` : ""
    if (routeKey !== observedRoute) {
      generation++
      observedRoute = routeKey
      lastCompleted = undefined
      lastInitial = undefined
    }
    const stateKey = `${routeKey}\0${active?.session.title ?? ""}\0${active ? context.data.session.status(active.sessionID) : ""}`
    if (stateKey === observedState) return
    observedState = stateKey
    enqueue(active)
  }

  const stop = context.data.listen(({ details }) => {
    const active = current()
    if (!active || details.data?.sessionID !== active.sessionID) return
    if (details.type === "session.execution.started") generation++
    if (COMPLETION_EVENTS.has(details.type)
      || (details.type === "session.status" && details.data?.status?.type === "idle")) enqueue(active)
    else if (details.type === "session.renamed" || details.type === "session.moved") inspectCurrent()
  })

  // Only observe route/title/status changes; never call Jev on a timer tick.
  const timer = runtime.setInterval(inspectCurrent, 500)
  timer.unref?.()
  inspectCurrent()

  return {
    settled: () => work,
    async dispose() {
      disposed = true
      stop()
      runtime.clearInterval(timer)
      await work
    },
  }
}
