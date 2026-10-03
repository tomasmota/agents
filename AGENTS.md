# AGENTS.md

This repository is **public**: https://github.com/tomasmota/agents. Everything
you commit is world-readable, including git history.

- Never commit secrets, API keys, tokens, or credentials. Authenticate via
  environment variables (e.g. `TYPESAFE_API_KEY`) or the gitignored secrets
  file — never hardcoded values.
- Never reference employer-internal systems, hostnames, URLs, project names,
  or infrastructure details. Personal setup details are acceptable only when
  harmless (e.g. documented config paths).
- Keep test fixtures and sample data fake (`test-key`, `evil.example`).
- If a secret lands in a commit: rotate the credential immediately — assume
  it is compromised once pushed. Deleting or rewriting the commit afterwards
  is not enough.

## Deploying plugin changes

Machines load independently installable `opencode/plugins/*` packages at the
immutable central revision in their consumer lock. Shared roles, portable skills
and instructions live here; read `config/README.md` for generation contracts.
For new guidance or skills, use its ownership table and the heuristics in
`config/instructions.md`: shared base vs platform vs repository scope, then public
vs private and intended installation profiles. Do not turn local policy into a
portable default or add an unconditional trigger for a skill absent on a profile.

After changing a plugin, always:

1. Run its tests (`npm test` in the plugin directory).
2. Commit and push to `main`.
3. Bump each consumer lock, render/check, deploy its intended configuration and
   refresh missing packages on the target. `plugin update` skips full-SHA pins;
   a config reload reconciles the new exact target, not a moving `main` branch.
4. Verify the new code landed in the install cache, e.g.
   `grep -rl <new-symbol> ~/.cache/opencode/npm/git-agents-*/`.
5. Require the secret-safe consumer inventory to prove the expected versions,
   configured settings, portable skills and active exact-SHA packages. Refresh
   each target separately; restarting a TUI is not proof of server plugin identity.

Tests: `node --test --test-timeout=30000 config/test/*.test.mjs
opencode/plugins/*/test/*.test.mjs` after each affected package's `npm ci
--ignore-scripts`. Never edit generated consumer outputs as the policy source.
