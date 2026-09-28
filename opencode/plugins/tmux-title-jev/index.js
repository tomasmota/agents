import { Plugin } from "@opencode/plugin"

// The server entry makes the package available to OpenCode. The actual tmux
// integration is exported from ./tui and runs in the local terminal process.
export default Plugin.define({
  id: "tomas.tmux-title-jev",
  setup() {},
})
