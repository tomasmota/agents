# Shared agent workflow

- Investigate hypothesis-first. Search before broad reading, gather evidence that
  resolves a specific uncertainty, and revise the hypothesis after a failure.
  Keep conclusions rather than raw exploration; stop when evidence supports a
  low-regret decision. Retrieve bounded output first; full saved output remains
  available when needed. Preserve unrelated work and serialize dependent edits/tests.
- Give delegated discovery a bounded question, expected evidence and stopping
  condition. Keep trivial work inline. The parent owns synthesis and correctness;
  use independent adversarial review when the risk warrants it.
- Every actual subagent, including nested children, must explicitly use
  `opencode/space-bunny-free`. If unavailable, report it and work directly; never
  substitute a paid child model. This does not change owner-selected primary
  sessions, continuation sessions or stateless Jev/helper calls. Subagents do not
  create continuation sessions. Read-only explore has no shell or mutation tools.
- Tool availability and names are model-specific. Use each tool's exact advertised
  name and schema. Claude may expose `write`/`edit` or full `mcp__...` gateway aliases;
  GPT may expose `patch`. Never shorten aliases or invent tool names. In Code Mode,
  use only exact catalog paths returned by `search`, including bracket notation.
- File opening is client-aware: use OpenChamber file-open/preview in the app. Only
  open a tmux pane when the **current client** is confirmed to be a tmux TUI;
  a shared server's inherited `TMUX`/`TMUX_PANE` is not that proof. If presentation
  fails after a successor starts, report its ID; never spawn a duplicate.
- Never print, copy or commit credentials, pairing material, private keys or raw
  authentication/environment/audit transcripts. Public configuration sources must
  not contain work-team contents or confidential infrastructure details.
