# Automatic handoff at a context threshold

An OpenCode V2 server plugin that hands a long session off to a fresh one
before it gets expensive or unreliable. It uses the `session` model-request hook
to watch each session's real request size; no polling, no extra model call, and
no separate summarizer.

## Behavior

When a session's assembled request (system instructions + tool schemas +
messages) crosses the threshold:

1. The current agent is asked, once, to use the `handoff` skill in
   document-only mode and write the document to a temp path the plugin picks.
2. When that session goes idle, the plugin reads the finished document.
3. A new session is created in the same directory with the same agent and model,
   and the document is submitted as its first prompt. The successor continues
   the same work; an automatic handoff carries no new direction from the user,
   because the user is not there to give any.
4. The old session is told to attach the new session to a tmux pane
   (`tmux split-window -h -c <dir> -t "$TMUX_PANE" opencode --session <id>`)
   and then to stop.

The document is written in a temp directory, never in the worktree, and stays
on disk as a fallback. If any step fails, the old session keeps working and the
document is still readable. Each session hands off at most once, recorded in
plugin storage, so a server restart cannot cause a second handoff.

## Threshold

The size is an estimate of the assembled request, not a provider billing count:
prompt text at about four characters per token, with flat estimates for media.
It slightly overestimates, which is the safe direction for a guard. This is
independent of OpenCode's own compaction settings; a compaction that the
provider forces first reduces the context and the handoff will not fire.

## Load

```jsonc
{
  "plugins": [
    {
      "package": "git+ssh://git@github.com/tomasmota/agents.git#main::path:opencode/plugins/auto-handoff",
      "options": { "threshold": 250000 }
    }
  ]
}
```

Update the installed Git package after deploying changes:

```sh
opencode plugin update 'git+ssh://git@github.com/tomasmota/agents.git#main::path:opencode/plugins/auto-handoff'
```

## Options

- `threshold`: context tokens that trigger a handoff, default `250000`
  (env `OPENCODE_HANDOFF_THRESHOLD`).

## Limits

- The handoff is as good as the document the agent writes; a rushed document
  loses state. The plugin only orchestrates, it does not summarize.
- The successor starts from the document alone. Anything the current agent
  knows but did not write down is gone, so the steer asks for the skill's full
  document format rather than a summary.
- The tmux pane is opened by the old session's agent, so it needs a tmux
  session; outside tmux the agent reports the new session ID instead.
- A monitor waits up to five minutes for the document to stop growing. If the
  agent never writes it, the old session is left alone and does not re-arm.

## Test

```sh
npm ci --ignore-scripts
npm test
```

Fixtures are fictional. Unit tests cover token estimation, the threshold
decision, the steer texts, session creation, the pane instruction, and
fail-closed paths, without making model requests.
