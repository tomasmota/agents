import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { render, apply } from "../render.mjs"

const lock = { schemaVersion: 1, revision: "a".repeat(40), pluginApi: "2.0", opencode: "2.0.16" }
async function fixture(t, profile = "coder") {
  const root = await mkdtemp(join(tmpdir(), "agents-render-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "platform.json"), JSON.stringify({ permissions: [{ action: "shell", resource: "danger*", effect: "deny" }], experimental: { subagent_depth: 2 }, agents: { build: { model: "example/primary#high" } } }))
  await writeFile(join(root, "platform.md"), "Platform identity and boundaries.\n")
  if (profile !== "coder") await writeFile(join(root, "cli.json"), JSON.stringify({ tabs: { mode: "off" } }))
  const adapter = { profile, server: "platform.json", instructions: "platform.md", models: {
    general: { mode: profile === "coder" ? "subagent" : "all", model: profile === "coder" ? "opencode/space-bunny-free" : "example/primary#high" },
    explore: { mode: "subagent", model: "opencode/space-bunny-free" },
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
    if (profile === "coder") {
      assert.ok(!server.plugins.some((entry) => (entry.package ?? entry).includes("auto-handoff")))
      assert.ok(!a.has("out/cli.json"))
    }
    await apply(a, root)
    await apply(a, root, true)
    await writeFile(join(root, "out/server.json"), "{}")
    await assert.rejects(apply(a, root, true), /stale generated/)
  }
})
test("unknown inputs, moving refs, paid child profiles, version drift and unsafe paths fail closed", async (t) => {
  const { root, adapter } = await fixture(t)
  await assert.rejects(render({ ...lock, revision: "main" }, adapter, root), /immutable/)
  await assert.rejects(render({ ...lock, opencode: "99.0.0" }, adapter, root), /unsupported/)
  await assert.rejects(render(lock, { ...adapter, unexpected: true }, root), /unknown field/)
  await assert.rejects(render(lock, { ...adapter, profile: "unknown" }, root), /unknown profile/)
  await assert.rejects(render(lock, { ...adapter, models: { explore: { mode: "subagent", model: "example/paid" } } }, root), /Space Bunny/)
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
  const outside = await mkdtemp(join(tmpdir(), "agents-outside-"))
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
  const parent = await mkdtemp(join(tmpdir(), "agents-root-link-"))
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
