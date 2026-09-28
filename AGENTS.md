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
