// Jev-first permission reviewer for OpenCode. Policy and runtime configuration
// live in lib/permission-review.js, shared with non-OpenCode hosts.

import { createPermissionEvaluator } from "./lib/permission-review.js"

import { Plugin } from "@opencode/plugin"

export const JevAutoApprovePlugin = Plugin.define({
  id: "tomas.auto-approve-jev",
  async setup(context) {
    const evaluate = createPermissionEvaluator({ generate: context.generate, directory: context.location.directory })
    await context.permission.hook("evaluate", evaluate)
  },
})

export default JevAutoApprovePlugin
