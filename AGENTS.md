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

Machines load `opencode/plugins/*` from GitHub, not from this checkout. The
home-manager OpenCode configs reference each plugin as a Git package tracking
`main`, e.g.
`git+ssh://git@github.com/tomasmota/agents.git#main::path:opencode/plugins/tmux-title-jev`.
OpenCode notices new commits on `main` but does not install them by itself.

After changing a plugin, always:

1. Run its tests (`npm test` in the plugin directory).
2. Commit and push to `main`.
3. Run `opencode plugin update "<configured target>"` for each changed plugin,
   or `opencode plugin update` with no target to update every outdated plugin.
4. Verify the new code landed in the install cache, e.g.
   `grep -rl <new-symbol> ~/.cache/opencode/npm/git-agents-*/`.
5. Tell the user that running OpenCode TUIs must be restarted to load it, and
   that other machines need their own `opencode plugin update`. The Coder guest
   pins full SHAs, so it only changes when its pinned SHA is bumped.
