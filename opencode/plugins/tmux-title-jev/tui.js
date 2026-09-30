// Jev-powered tmux window naming.
//
// After each completed turn, Jev sees the current tmux title, latest user
// message, and final agent output. It decides whether the title badly describes
// the actual work and selects a short branch-like replacement in the same call.
// Adequate titles survive follow-ups and incidental git/test operations. A
// stale opening title such as pull-main is replaced once real work emerges.
// Names use `<repo>:<task>`. On judge failure, an existing title is kept.
//
// Runtime configuration:
//   TYPESAFE_API_KEY                         required; falls back to ~/.config/home-manager/secrets.env
//   OPENCODE_TMUX_TITLE_JEV_MODEL=jev-latest TypeSafe model alias or version
//   OPENCODE_TMUX_TITLE_TIMEOUT_MS=5000      total Jev request/retry budget
//   OPENCODE_TMUX_TITLE_UPDATE_MIN=0.8      minimum probability that the title needs updating

import { Plugin } from "@opencode/plugin/tui"
import { createTmuxTitleController } from "./controller.js"

export const TmuxTitleJevTuiPlugin = Plugin.define({
  id: "tomas.tmux-title-jev.tui",
  setup(context) {
    const controller = createTmuxTitleController(context)
    return controller ? () => controller.dispose() : undefined
  },
})

export default TmuxTitleJevTuiPlugin
