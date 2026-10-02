# Shared configuration contract

`manifest.json`, `roles.json` and `instructions.md` are the portable source.
Consumer adapters retain platform permissions, paths, credentials, primary
models, CLI settings, browsers and lifecycle. Never put secrets in an adapter.

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
hook overrides; the actual executor is self-checked by child-policy at setup.
`--runtime-only` uses the root-owned installed inventory, installed server and
installed skills plus the live CLI/API, without requiring the editable source
checkout's hashes. It explicitly reports intended artifact proof as not
inspected. Readiness may use this mode; final acceptance must also prove the
source snapshot separately. It requires all three explicit installed paths.
Update: test and push central changes, bump consumer locks deliberately, render,
review permission/client diffs, test, deploy, verify and push the consumer.

Supported profiles: `mac`, `home-linux`, `coder`. Coder does not enable automatic
handoff or tmux, and retains its root-owned deployment, lazy browser and explicit
continuation policy. Child dispatch uses Space Bunny regardless of role primary
model; see `../opencode/plugins/child-policy/README.md`.

CLI profiles require `opencode/lib/` and `opencode/subagents.jsonc` as siblings
of the generated skills directory (under the same parent). The portable
model-selector's imports and routing defaults depend on this validated layout;
tests import the generated selector without making any inference request.
