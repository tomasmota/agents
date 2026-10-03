# Shared configuration contract

`manifest.json`, `roles.json` and `instructions.md` are the portable source.
Consumer adapters retain platform permissions, paths, credentials, primary
models, CLI settings, browsers and lifecycle. Never put secrets in an adapter.

## Instructions and skills: choosing the owner

Every profile renders its global `AGENTS.md` as the consumer's `platform.md`
followed by the same `config/instructions.md`. The shared base owns investigation,
context handling, delegation/review, model/tool-name guidance, client detection,
secret hygiene and the ownership heuristics themselves. Adapters contain only
actual environment differences, not a second copy of the shared workflow. These
layers are combined instructions, not an override mechanism; resolve contradictions
in the sources rather than relying on their order.

| Guidance | Canonical source | Trigger location |
| --- | --- | --- |
| Portable, public-safe always-loaded behavior | `config/instructions.md` | Shared base |
| Machine/client boundaries, commands or lifecycle | Consumer platform adapter | That platform's instructions |
| Repository conventions | That repository's `AGENTS.md` | Repository scope |
| Portable, public reusable procedure | `skills/<name>/SKILL.md` plus manifest metadata | Skill description; shared explicit trigger only when all affected profiles support it, otherwise guard availability or keep it in the adapter |
| Platform-specific public procedure | Consumer-owned non-generated skill source | Skill description or platform instruction trigger |
| Project-only or private/local/team procedure | Owning project/private location | Its own scope; never publish private contents for parity |

Keep detailed procedures in on-demand skills. Prefer their discoverable descriptions
over extra always-loaded boilerplate; explicit safety-critical triggers can be
short. Split a mixed skill into portable behavior and a small platform reference
only when the core truly works without importing local authority. For example,
HEY task guidance is portable; Coder guest administration and restart policy are
not. A public-safe skill can still require credentials at runtime; those credentials
and their provisioning stay local. Ask when publication or installation scope is
ambiguous.

Register central skills with honest provenance/license metadata and choose their
installation profiles in `manifest.json`. Central ownership does **not** mean all
profiles must install them (`model-selector`/`use-uvx` are workstation-only today).
Do not add unconditional base triggers for absent skills. Consumer inventories
identify generated skills; other owned skill sources follow that consumer's
README. Never edit a generated skill or global instruction as the policy source.

After changing shared guidance/skills: test and review central changes, commit/push,
advance each intended consumer's full-SHA lock, render/check, inspect the platform
and skill-availability diffs, then deploy and verify each target by its runbook.
Record source-only validation separately from installed/active proof and leave
blocked target acceptance explicit. A local-only change follows only its owner's
workflow and does not require copying a rule back into the shared base.

## Rendering and acceptance

Consumer `lock.json` selects a full immutable Git revision and tested OpenCode
version. The manifest deliberately does not hash its own commit. Rendering is
offline, validates package entrypoints, and rejects unrecognized adapter fields.
It uses the runtime routing validator, rejects credential fields and path/input
collisions, and never follows destination symlinks. Obsolete outputs are removed
only if the previous inventory owns them and their bytes are unchanged; changed
files require reconciliation. Local consumer skills/adapters are not swept.

```sh
node config/render.mjs --lock /consumer/lock.json --adapter /consumer/adapter.json --root /consumer
node config/render.mjs --lock /consumer/lock.json --adapter /consumer/adapter.json --root /consumer --check
node --test config/test/*.test.mjs
```

Run the renderer from a clean checkout of the **locked** central revision.
Consumers archive generated recovery snapshots, not mutable checkout symlinks.
The generated inventory hashes every generated artifact; it is not a backup or
runtime proof. `inventory.mjs` separates intended, installed and active evidence.
It checks runtime versions, selected loaded-config settings, active pins and
optional installed server/skill paths. Config documents are not per-request
hook overrides.
OpenCode 2.0.16 and 2.0.22 are supported exact runtime pins; consumers choose
their version independently. The workstation retains 2.0.22 rather than
downgrading existing session state; Coder remains on 2.0.16.
Use `--server <http(s)-url>` to inspect an explicit server and `--directory <path>`
for its intended location. The report identifies the selected connection; a
default-service pass does not prove OpenChamber uses that server. Server URLs
must not contain credentials. If authentication is required, supply it through
the CLI's own environment, never command arguments or report output.
`--runtime-only` uses the root-owned installed inventory, installed server and
installed skills plus the live CLI/API, without requiring the editable source
checkout's hashes. It explicitly reports intended artifact proof as not
inspected. Readiness may use this mode; final acceptance must also prove the
source snapshot separately. It requires all three explicit installed paths.
Update: test and push central changes, bump consumer locks deliberately, render,
review permission/client diffs, test, deploy, verify and push the consumer.

Supported profiles: `mac`, `home-linux`, `coder`. Coder does not enable automatic
handoff or tmux, and retains its root-owned deployment, lazy browser and explicit
continuation policy. Role models are chosen per platform adapter; the central source
renders them as given and does not impose a child model policy.

CLI profiles require `opencode/lib/` and `opencode/subagents.jsonc` as siblings
of the generated skills directory (under the same parent). The portable
model-selector's imports and routing defaults depend on this validated layout;
tests import the generated selector without making any inference request.
