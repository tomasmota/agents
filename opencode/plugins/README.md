# OpenCode plugins

Each directory is a standalone OpenCode v2 server plugin package. OpenCode
installs one plugin per package, so every directory has its own `package.json`
and ships everything it imports.

| Directory | Plugin ID | What it does |
|---|---|---|
| `auto-approve-jev/` | `tomas.auto-approve-jev` | Reviews permission evaluations with TypeSafe Jev, auto-allowing read-only actions and denying clearly catastrophic ones. |
| `stuck-command/` | `tomas.stuck-command-jev` | Asks Jev whether a foreground shell command that is still running is hung (after 60 s, then every 60 s) and interrupts the session with an explanation when it is. |

Configuration is documented in the header comment of each plugin's entry file.
Both read `TYPESAFE_API_KEY` from the environment, falling back to
`~/.config/home-manager/secrets.env`.

## Loading

Reference a directory as a Git package in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    "git+ssh://git@github.com/tomasmota/agents.git#<ref>::path:opencode/plugins/auto-approve-jev",
    "git+ssh://git@github.com/tomasmota/agents.git#<ref>::path:opencode/plugins/stuck-command"
  ]
}
```

`<ref>` can be a branch such as `main` or a full commit SHA. OpenCode keeps a
full SHA pinned. With a branch it notices new commits but installs them only
after `opencode plugin update`. The Coder guest (`homelab/coder`) pins full
SHAs; the personal machines (`home-manager`) track `main`.

## Shared code

`auto-approve-jev/lib/` holds the canonical `jev-client.js` and
`decision-audit.js`. `stuck-command/lib/` carries identical copies, which
`stuck-command/test/shared-lib.test.mjs` enforces. Change the canonical file,
then copy it over.

## Tests

```sh
for dir in auto-approve-jev stuck-command; do (cd "$dir" && npm ci && npm test); done
```
