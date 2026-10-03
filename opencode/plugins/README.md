# OpenCode plugins

Each directory is a standalone OpenCode v2 plugin package. OpenCode installs
one plugin per package, so every directory has its own `package.json` and ships
everything it imports. Packages may also export `./tui` for terminal behavior.

| Directory | Plugin ID | What it does |
|---|---|---|
| `auto-retitle/` | `tomas.auto-retitle` | Re-evaluates the session title after each idle turn with `openai/gpt-6-luna#low` and renames the session when focus clearly changed. Never overwrites manual renames. |
| `auto-approve-jev/` | `tomas.auto-approve-jev` | Reviews permission evaluations with TypeSafe Jev, auto-allowing read-only actions and denying clearly catastrophic ones. |
| `stuck-command/` | `tomas.stuck-command-jev` | Asks Jev whether a foreground shell command that is still running is hung (after 60 s, then every 60 s) and interrupts the session with an explanation when it is. |
| `tmux-title-jev/` | `tomas.tmux-title-jev` | After each completed turn, Jev compares the tmux title with the latest user message and final agent output; replaces misleading titles with `<repo>:<task>` while keeping titles that still fit. |
| `gcloud-auth-healer/` | `tomas.gcloud-auth-healer` | Detects expired gcloud/ADC auth failures after shell commands, starts the re-login in the background (at most once per cooldown), and tells the agent to complete the browser prompt and poll. |
| `agent-routes/` | `tomas.agent-routes` | Generates subagent roles from `subagents.jsonc`, swaps a role's model when its provider is low on quota or not configured (quota readings from the consumer's adapter, with a backup that reacts to quota failures), and applies `when`-scoped permission rules. See its [README](agent-routes/README.md). |
| `auto-handoff/` | `tomas.auto-handoff` | When a session's request crosses a context threshold (default 250k tokens), asks the agent to do a handoff with the `handoff` skill — document, successor session, and pane attach all handled by that skill. The plugin itself only measures and steers, once per session. See its [README](auto-handoff/README.md). |

Configuration is documented in the header comment of each plugin's entry file.
The Jev integrations read `TYPESAFE_API_KEY` from the environment, falling back to
`~/.config/home-manager/secrets.env`.

## Loading

Reference a directory as a Git package in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    "git+ssh://git@github.com/tomasmota/agents.git#<ref>::path:opencode/plugins/auto-retitle",
    "git+ssh://git@github.com/tomasmota/agents.git#<ref>::path:opencode/plugins/auto-approve-jev",
    "git+ssh://git@github.com/tomasmota/agents.git#<ref>::path:opencode/plugins/stuck-command",
    "git+ssh://git@github.com/tomasmota/agents.git#<ref>::path:opencode/plugins/tmux-title-jev",
    "git+ssh://git@github.com/tomasmota/agents.git#<ref>::path:opencode/plugins/gcloud-auth-healer",
    "git+ssh://git@github.com/tomasmota/agents.git#<ref>::path:opencode/plugins/auto-handoff"
  ]
}
```

`<ref>` can be a branch such as `main` or a full commit SHA. OpenCode keeps a
full SHA pinned. With a branch it notices new commits but installs them only
after `opencode plugin update`. The Coder guest (`homelab/coder`) pins full
SHAs; the personal machines (`home-manager`) track `main`.

## Shared code

`auto-approve-jev/lib/` holds the canonical `jev-client.js` and
`decision-audit.js`. Other packages carry the shared files they use because
each Git package is installed independently. Change the canonical file, copy it
to the consumers, and keep the shared-copy tests current.

## Tests

```sh
for dir in auto-retitle auto-approve-jev stuck-command tmux-title-jev gcloud-auth-healer auto-handoff; do (cd "$dir" && npm ci && npm test); done
```
