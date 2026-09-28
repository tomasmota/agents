// Jev-powered tmux window naming.
//
// After OpenCode generates a session title, this plugin builds short, valid
// branch-like candidates and asks Jev which one best describes the work. It
// then renames the tmux window containing this TUI. Jev failure falls back to
// the first deterministic candidate.
//
// Runtime configuration:
//   TYPESAFE_API_KEY                         required; falls back to ~/.config/home-manager/secrets.env
//   OPENCODE_TMUX_TITLE_JEV_MODEL=jev-latest TypeSafe model alias or version
//   OPENCODE_TMUX_TITLE_TIMEOUT_MS=5000      total Jev request/retry budget

import { Plugin } from "@opencode/plugin/tui"
import { spawnSync } from "node:child_process"

import { createTmuxTitleNamer, tmuxTitleInternals } from "./core.js"

const { firstUserText } = tmuxTitleInternals

export const TmuxTitleJevTuiPlugin = Plugin.define({
  id: "tomas.tmux-title-jev.tui",
  setup(context) {
    if (!process.env.TMUX) return
    const pane = process.env.TMUX_PANE || spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], {
      encoding: "utf8",
    }).stdout?.trim()
    if (!/^%\d+$/.test(pane ?? "")) return

    const namer = createTmuxTitleNamer({ env: { ...process.env, TMUX_PANE: pane } })
    let work = Promise.resolve()
    let lastCompleted
    const pending = new Set()

    const enqueue = (sessionID, title) => {
      if (!sessionID || !title) return
      const key = `${sessionID}\0${title}`
      if (key === lastCompleted || pending.has(key)) return
      pending.add(key)
      work = work.then(async () => {
        await context.data.session.message.sync(sessionID)
        const request = firstUserText(context.data.session.message.list(sessionID))
        await namer.rename({ sessionID, title, request })
        lastCompleted = key
      }).catch((error) => console.error("tmux-title-jev failed", error))
        .finally(() => pending.delete(key))
    }

    const inspectCurrent = () => {
      const route = context.ui.router.current()
      if (route.type !== "session" || !route.sessionID) return
      const session = context.data.session.get(route.sessionID)
      if (!session?.parentID && session?.title) enqueue(route.sessionID, session.title)
    }

    const stop = context.data.listen(({ details }) => {
      const route = context.ui.router.current()
      const sessionID = details.data?.sessionID
      if (route.type !== "session" || route.sessionID !== sessionID) return
      if (details.type === "session.renamed") enqueue(sessionID, details.data?.title)
      else inspectCurrent()
    })

    // Route changes are local UI state rather than server events. Polling the
    // cheap in-memory route/cache handles resumed sessions and tab navigation.
    const timer = setInterval(inspectCurrent, 500)
    timer.unref?.()
    inspectCurrent()

    return async () => {
      stop()
      clearInterval(timer)
      await work
    }
  },
})

export default TmuxTitleJevTuiPlugin
