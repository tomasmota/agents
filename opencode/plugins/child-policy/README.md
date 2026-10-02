# Actual-child policy

All delegated `subagent` executor calls use `opencode/space-bunny-free`, including
explicit overrides, nested dispatches and resumed child sessions. The V2 tool
transform wraps the real executor before it creates a child; unavailable models
raise a tool error rather than invoking a paid fallback. It never transforms
primary agent models or calls a model itself. Stateless helper inference is not
delegation. Already-running children must finish or be restarted after deployment.

Native configured denies remain final. A final permission hook restricts child
questions/nesting and makes explore strictly read-only (no shell). Reviewer can
run shell checks and is not a sandbox. Coder forces foreground dispatch and caps
concurrent executor calls across locations at two; Mac caps dispatch calls at
four but background work outlives dispatch, so this is not a background-session
limit. Both profiles retain native depth two. This is personal configuration,
not a security boundary against an agent changing its own platform policy.

The Effect executor preserves native typed errors, authorization ordering and
interruption, including releasing a concurrency slot on cancellation. Setup
materializes the tool registry and checks its wrapper identity; consumers must
also require this exact package to be active at the tested runtime version.
A missing/failed plugin is not an external enforcement boundary: native tools
can remain available, so deployment acceptance must fail if readiness proof fails.

An arbitrary client creating a parent-linked session outside the subagent tool
is not a delegated tool invocation. This plugin does not reclassify continuation
or primary sessions by title, and cannot police another server. Test real child
selection on each target after activating the locked package.

`npm test` uses fictional models/contexts and exercises overrides, unavailable
models, continuations, nested permissions, unload and concurrency.
