// Preservation-first local compaction.
//
// OpenCode's default local-summary compaction asks the session's model for a
// terse checkpoint (single-line bullets, at most 15 relevant files) and keeps
// only a shortened recent tail beside it (tool results truncated at ~1250
// characters). For long investigations that policy loses continuation-critical
// state: rejected approaches and why they failed, evidence pointers, exact
// identifiers, uncommitted work, and findings the user has not been told yet.
//
// This plugin hooks only the compaction summarization request:
//   - appends the preservation policy (instructions.js) to the request system
//     prompt, complementing the summary prompt OpenCode appends after hooks;
//   - removes tools from the request: a checkpoint must not call tools, and
//     dropping the schemas saves tokens;
//   - leaves the model, messages, and generation settings untouched, and never
//     supplies the summary itself.
//
// The hook is provider-neutral and applies to every provider. A summary
// already supplied by another hook (event.result) is left alone. Transform
// failures are logged and ignored, so compaction proceeds with OpenCode's
// default policy instead of failing.

import { Plugin } from "@opencode/plugin"

import { PRESERVATION_INSTRUCTIONS } from "./instructions.js"

function recordOf(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null
}

// Applies the preservation policy to one compaction request, in place.
// Returns what it did. Pathological events can still throw; the hook wrapper
// catches that so compaction proceeds with the default policy.
export function preserve(event) {
  const report = { policy: false, tools: false }
  const request = recordOf(event)
  if (!request) return report
  // Another hook already supplied the summary: leave the request alone.
  if (request.result !== undefined) return report
  if (Array.isArray(request.system)) {
    const present = request.system.some(
      (part) => recordOf(part)?.type === "text" && part.text === PRESERVATION_INSTRUCTIONS,
    )
    if (!present) {
      request.system.push({ type: "text", text: PRESERVATION_INSTRUCTIONS })
      report.policy = true
    }
  }
  if (request.tools !== undefined) {
    request.tools = {}
    report.tools = true
  }
  return report
}

const testHelpers = { preserve }

export const CompactionPreservePlugin = Plugin.define({
  id: "tomas.compaction-preserve",
  async setup(ctx) {
    await ctx.session.hook("compaction", (event) => {
      try {
        preserve(event)
      } catch (error) {
        console.error(`compaction-preserve failed (${String(error?.message ?? error).slice(0, 200)})`)
      }
    })
  },
})

CompactionPreservePlugin.__test = () => testHelpers

export default CompactionPreservePlugin
