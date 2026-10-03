import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { render, apply } from "../render.mjs"

const lock = { schemaVersion: 1, revision: "a".repeat(40), pluginApi: "2.0", opencode: "2.0.16" }
// macOS exposes its temp directory through /var -> /private/var. Fixtures
// should use the canonical directory, not weaken the renderer's symlink guard.
const temp = await realpath(tmpdir())
async function fixture(t, profile = "coder") {
  const root = await mkdtemp(join(temp, "agents-render-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "platform.json"), JSON.stringify({ permissions: [{ action: "shell", resource: "danger*", effect: "deny" }], experimental: { subagent_depth: 2 }, agents: { build: { model: "example/primary#high" } } }))
  await writeFile(join(root, "platform.md"), "Platform identity and boundaries.\n")
  if (profile !== "coder") await writeFile(join(root, "cli.json"), JSON.stringify({ tabs: { mode: "off" } }))
  const adapter = { profile, server: "platform.json", instructions: "platform.md", models: {
    general: { mode: profile === "coder" ? "subagent" : "all", model: "example/primary#high" },
    explore: { mode: "subagent", model: "example/fast" },
  }, outputs: { server: "out/server.json", routes: "out/opencode/subagents.jsonc", instructions: "out/AGENTS.md", inventory: "out/inventory.json", skills: "out/skills", helpers: "out/opencode/lib", cli: "out/cli.json" },
    ...(profile !== "coder" ? { cli: "cli.json" } : {}) }
  return { root, adapter }
}

test("all profiles render deterministically, pin every package and preserve explicit platform denies and primary models", async (t) => {
  for (const profile of ["coder", "mac", "home-linux"]) {
    const { root, adapter } = await fixture(t, profile)
    const a = await render(lock, adapter, root)
    const b = await render(lock, adapter, root)
    assert.deepEqual(a, b)
    const server = JSON.parse(a.get("out/server.json"))
    assert.equal(server.agents.build.model, "example/primary#high")
    assert.equal(server.permissions[0].effect, "deny")
    assert.equal(server.agents.general.mode, profile === "coder" ? "subagent" : "all")
    assert.deepEqual(server.tool_output, { max_lines: 500, max_bytes: 16000 })
    for (const entry of server.plugins) assert.ok((entry.package ?? entry).includes(`#${lock.revision}::path:`))
    assert.ok(a.has("out/skills/handoff/SKILL.md"))
    if (profile === "coder") {
      assert.ok(!server.plugins.some((entry) => (entry.package ?? entry).includes("auto-handoff")))
      assert.ok(!a.has("out/cli.json"))
      assert.deepEqual(Object.keys(JSON.parse(a.get("out/inventory.json")).skills).sort(), ["handoff", "hey", "typesafe-ai"])
    }
    await apply(a, root)
    await apply(a, root, true)
    await writeFile(join(root, "out/server.json"), "{}")
    await assert.rejects(apply(a, root, true), /stale generated/)
  }
})
test("free role wording describes only its adapter-selected model in every profile", async (t) => {
  for (const profile of ["coder", "mac", "home-linux"]) {
    const { root, adapter } = await fixture(t, profile)
    const models = { ...adapter.models, free: { mode: "subagent", model: "example/free-lite" } }
    const outputs = await render(lock, { ...adapter, models }, root)
    const agents = JSON.parse(outputs.get("out/server.json")).agents
    assert.equal(agents.free.model, "example/free-lite")
    assert.equal(agents.general.model, "example/primary#high")
    assert.equal(agents.explore.model, "example/fast")
    assert.match(agents.free.description, /General-purpose free delegated work\./)
    assert.match(agents.free.description, /platform adapter selects/)
    assert.doesNotMatch(agents.free.description, /all (actual )?children|same (free )?model|regardless of role/i)
  }
})
test("every profile composes its local instructions with exactly one unchanged shared base", async (t) => {
  const shared = await readFile(new URL("../instructions.md", import.meta.url), "utf8")
  assert.match(shared, /## Delegation and review/)
  assert.match(shared, /## Instruction and skill ownership/)
  for (const profile of ["coder", "mac", "home-linux"]) {
    const { root, adapter } = await fixture(t, profile)
    const local = `# ${profile} boundaries\n\nOnly this profile's approved authority applies.\n`
    await writeFile(join(root, "platform.md"), local)
    const outputs = await render(lock, adapter, root)
    const instructions = outputs.get("out/AGENTS.md").toString()
    assert.equal(instructions, `<!-- Generated from agents ${lock.revision}; edit the platform adapter or shared source. -->\n\n${local.trimEnd()}\n\n${shared}`)
    assert.equal(instructions.split("# Shared agent base").length - 1, 1)
  }
})
test("unknown inputs, moving refs, paid child profiles, version drift and unsafe paths fail closed", async (t) => {
  const { root, adapter } = await fixture(t)
  await assert.rejects(render({ ...lock, revision: "main" }, adapter, root), /immutable/)
  await assert.rejects(render({ ...lock, opencode: "99.0.0" }, adapter, root), /unsupported/)
  await assert.rejects(render(lock, { ...adapter, unexpected: true }, root), /unknown field/)
  await assert.rejects(render(lock, { ...adapter, profile: "unknown" }, root), /unknown profile/)
  await assert.rejects(render(lock, { ...adapter, models: { explore: { mode: "subagent", model: "no-provider" } } }, root), /invalid selection/)
  await assert.rejects(render(lock, { ...adapter, outputs: { ...adapter.outputs, server: "../escape" } }, root), /unsafe path/)
  const platform = JSON.parse(await readFile(join(root, "platform.json")))
  await writeFile(join(root, "platform.json"), JSON.stringify({ ...platform, theme: "wrong-domain" }))
  await assert.rejects(render(lock, adapter, root), /unknown field theme/)
})
test("manifest has no self-referential release hash and every declared package has an entrypoint", async (t) => {
  const { root, adapter } = await fixture(t, "mac")
  const files = await render(lock, adapter, root)
  const inventory = JSON.parse(files.get("out/inventory.json"))
  assert.equal(inventory.central.revision, lock.revision)
  assert.equal(Object.keys(inventory.skills).length, 5)
  assert.ok(!inventory.packages.some((entry) => entry.path.includes("compaction-preserve")))
  assert.ok(!Object.hasOwn(inventory.artifacts, "out/inventory.json"))
})
test("generated selector loads without inference and incompatible helper layouts fail closed", async (t) => {
  const { root, adapter } = await fixture(t, "mac")
  await assert.rejects(render(lock, { ...adapter, outputs: { ...adapter.outputs, helpers: "out/lib" } }, root), /helper layout/)
  await assert.rejects(render(lock, { ...adapter, outputs: { ...adapter.outputs, routes: "out/routes.json" } }, root), /helper layout/)
  await apply(await render(lock, adapter, root), root)
  // Import only: the CLI guard must not run the selector or make a Jev call.
  execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(join(root, "out/skills/model-selector/scripts/select.mjs"))})`], { timeout: 5000 })
})

test("normalized collisions, input overwrites and output symlinks are rejected", async (t) => {
  const { root, adapter } = await fixture(t)
  await assert.rejects(render(lock, { ...adapter, outputs: { ...adapter.outputs, routes: "out/./server.json" } }, root), /unsafe path/)
  await assert.rejects(render(lock, { ...adapter, outputs: { ...adapter.outputs, server: "platform.json" } }, root), /collision/)
  const outputs = await render(lock, adapter, root)
  const outside = await mkdtemp(join(temp, "agents-outside-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await symlink(outside, join(root, "out"))
  await assert.rejects(apply(outputs, root), /symlink/)
  await rm(join(root, "out"))
  await mkdir(join(root, "out"))
  await writeFile(join(outside, "fixture"), "preserve")
  await symlink(join(outside, "fixture"), join(root, "out/server.json"))
  await assert.rejects(apply(outputs, root), /symlink/)
  assert.equal(await readFile(join(outside, "fixture"), "utf8"), "preserve")
})
test("runtime route validation rejects empty roles and invalid fallbacks", async (t) => {
  const { root, adapter } = await fixture(t)
  await assert.rejects(render(lock, { ...adapter, models: {} }, root), /non-empty/)
  await assert.rejects(render(lock, { ...adapter, fallbacks: { openai: "malformed" } }, root), /fallbacks/)
})
test("consumer root and symlinked ancestor are rejected before reading or applying artifacts", async (t) => {
  const { root, adapter } = await fixture(t)
  const outputs = await render(lock, adapter, root)
  const parent = await mkdtemp(join(temp, "agents-root-link-"))
  t.after(() => rm(parent, { recursive: true, force: true }))
  await symlink(root, join(parent, "linked"))
  for (const destination of [join(parent, "linked"), join(parent, "linked", "nested")]) {
    await assert.rejects(render(lock, adapter, destination), /symlink/)
    await assert.rejects(apply(outputs, destination), /symlink/)
    await assert.rejects(apply(outputs, destination, true), /symlink/)
  }
  await assert.rejects(readFile(join(root, "out/server.json")), /ENOENT/)
})
test("credentials in provider models, headers, MCP and URLs never enter artifacts", async (t) => {
  const { root, adapter } = await fixture(t)
  const base = JSON.parse(await readFile(join(root, "platform.json")))
  for (const extra of [
    { providers: { example: { headers: { Authorization: "Bearer fictional-credential" } } } },
    { providers: { example: { models: { fake: { settings: { apiKey: "fictional-key" } } } } } },
    { mcp: { servers: { fake: { headers: { "api-key": "fictional-key" } } } } },
    { mcp: { servers: { fake: { environment: { FAKE_TOKEN: "fictional-token" } } } } },
    { mcp: { servers: { fake: { url: "https://fake:fictional@evil.example" } } } },
  ]) {
    await writeFile(join(root, "platform.json"), JSON.stringify({ ...base, ...extra }))
    await assert.rejects(render(lock, adapter, root), /credential/)
  }
  for (const name of ["x-api-key", "X-Goog-Api-Key", "x-auth-token", "X-Amz-Security-Token", "CF-Access-Client-Secret", "apiKey", "Authorization", "Cookie", "X-Custom-Credential"]) {
    const remote = (value) => ({ ...base, mcp: { servers: { fake: { type: "remote", url: "https://evil.example/mcp", headers: { [name]: value, Accept: "application/json" } } } } })
    await writeFile(join(root, "platform.json"), JSON.stringify(remote("fictional-test-key")))
    await assert.rejects(render(lock, adapter, root), /credential/)
    await writeFile(join(root, "platform.json"), JSON.stringify(remote("{env:FICTIONAL_MCP_KEY}")))
    const outputs = await render(lock, adapter, root)
    assert.equal(JSON.parse(outputs.get("out/server.json")).mcp.servers.fake.headers[name], "{env:FICTIONAL_MCP_KEY}")
  }
})
test("obsolete owned artifacts fail check and are removed only if unchanged", async (t) => {
  const { root, adapter } = await fixture(t)
  const previous = await render(lock, adapter, root)
  await apply(previous, root)
  const next = new Map(previous)
  next.delete("out/skills/hey/SKILL.md")
  const inventory = JSON.parse(next.get("out/inventory.json"))
  delete inventory.artifacts["out/skills/hey/SKILL.md"]
  next.set("out/inventory.json", Buffer.from(JSON.stringify(inventory)))
  await assert.rejects(apply(next, root, true), /obsolete/)
  await writeFile(join(root, "out/skills/hey/SKILL.md"), "user edit")
  await assert.rejects(apply(next, root), /preserve and reconcile/)
  await writeFile(join(root, "out/skills/hey/SKILL.md"), previous.get("out/skills/hey/SKILL.md"))
  await apply(next, root)
  await assert.rejects(readFile(join(root, "out/skills/hey/SKILL.md")), /ENOENT/)
})
test("an artifact obsolete in two owning inventories is reported and removed once", async (t) => {
  const { root, adapter } = await fixture(t)
  const previous = await render(lock, adapter, root)
  await apply(previous, root)
  const old = previous.get("out/inventory.json")
  await writeFile(join(root, "out/inventory2.json"), old)
  const inventory = JSON.parse(old)
  delete inventory.artifacts["out/skills/hey/SKILL.md"]
  const updated = Buffer.from(JSON.stringify(inventory))
  const next = new Map(previous)
  next.delete("out/skills/hey/SKILL.md")
  next.set("out/inventory.json", updated)
  next.set("out/inventory2.json", updated)
  await assert.rejects(apply(next, root, true), (error) => /obsolete/.test(error.message) && error.message.match(/out\/skills\/hey\/SKILL\.md/g).length === 1)
  await apply(next, root)
  await assert.rejects(readFile(join(root, "out/skills/hey/SKILL.md")), /ENOENT/)
})
