# Automatic handoff at a context threshold

An OpenCode V2 server plugin that steers a long session into a handoff before
it gets expensive or unreliable. It uses the `session` model-request hook to
watch each session's real request size; no polling, no extra model call, and
no separate summarizer.

## Behavior

When a session's assembled request (system instructions + tool schemas +
messages) crosses the threshold, the current agent is asked, once, to do a
handoff with the `handoff` skill: write the document, spawn the next session
with it as the first prompt, and attach the user to it, all as that skill
describes. An automatic handoff carries no new direction from the user, because
the user is not there to give any.

The plugin deliberately does no more than that. It never creates a session,
submits a prompt, or touches tmux: the `handoff` skill is the single source of
truth for spawn mechanics, including model resolution through `model-selector`.
Every request is checked until the session is reserved for steering. Each attempt
gets its own durable `handoff/<sessionID>` record **before** the steer, so later sessions do not
overwrite its restart guard. Old entries in the legacy `handoffs` list are
also honored; records that older versions already lost cannot be recovered.

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
  loses state. The plugin only measures and steers, it does not summarize.
- The successor starts from the document alone. Anything the current agent
  knows but did not write down is gone, so the steer asks for the skill's full
  document flow rather than a summary.
- The plugin steers once per session and cannot verify that the handoff
  happened. If the agent ignores the steer, the session continues unguarded;
  the next handoff has to be asked for manually.
- The once-only guard is best effort when durable storage fails. A successful
  steer is still suppressed in memory, but a restart cannot recover an entry
  that could not be written. Storage records are local plugin state, not backup.
- Reserving before steering prefers a missed handoff to a duplicate: a crash,
  unload or failed synthetic submission after reservation leaves the guard in
  place even if no steer arrived. Ask for a handoff manually in that case.
- Monitors and cleanup are isolated per plugin/location instance. Unload prevents
  new steers after pending storage reads/writes finish; a synthetic submission
  already in flight cannot be retracted. Storage has no compare-and-set, so this
  is not an exactly-once guarantee across overlapping instances or processes.

## Test

```sh
npm ci --ignore-scripts
npm test
```

Fixtures are fictional. Unit tests cover token estimation, the threshold
decision, growing-session hooks, the steer text, concurrent once-only guards,
restart persistence across multiple sessions, cleanup, and storage-failure paths,
without making model requests.
