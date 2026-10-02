import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render, apply } from "../render.mjs"
import { reportInventory } from "../inventory.mjs"

test("real 2.0.16 API shapes, active version/settings/pins and secret-safe allowlists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "inventory-fixture-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "platform.json"), JSON.stringify({ permissions: [], experimental: { subagent_depth: 2 } }))
  await writeFile(join(root, "platform.md"), "Fictional platform")
  const lock = { schemaVersion: 1, revision: "a".repeat(40), pluginApi: "2.0", opencode: "2.0.16" }
  const adapter = { profile: "coder", server: "platform.json", instructions: "platform.md", models: { general: { mode: "subagent", model: "example/fast" } }, outputs: { server: "out/server.json", routes: "out/routes.json", instructions: "out/AGENTS.md", inventory: "out/inventory.json", skills: "out/skills" } }
  const outputs = await render(lock, adapter, root); await apply(outputs, root)
  const inventory = JSON.parse(outputs.get("out/inventory.json"))
  const config = JSON.parse(outputs.get("out/server.json"))
  const plugins = inventory.packages.map((pkg) => ({ source: { type: "package", target: `git+ssh://git@github.com/tomasmota/agents.git#${lock.revision}::path:${pkg.path}`, version: lock.revision }, state: { status: "active" } }))
  const responses = { "/api/info": { version: "2.0.16", sensitive: "fictional-do-not-print" }, "/api/plugin": { data: plugins }, "/api/config": [{ type: "document", info: { ...config, providers: { fake: { apiKey: "fictional-do-not-print" } } } }] }
  const command = (_, args) => args[0] === "--version" ? "opencode v2.0.16\n" : JSON.stringify(responses[args[2]])
  const inspect = () => reportInventory(inventory, root, { cli: "fake", command })
  let result = await inspect()
  assert.equal(result.valid, true)
  assert.equal(result.report.active.runtimeMatches, true)
  assert.ok(!JSON.stringify(result.report).includes("fictional-do-not-print"))
  responses["/api/info"].version = "2.0.99"
  assert.equal((await inspect()).valid, false)
  responses["/api/info"].version = "2.0.16"
  responses["/api/config"][0].info.tool_output.max_bytes = 999
  assert.equal((await inspect()).valid, false)
  responses["/api/config"][0].info.tool_output.max_bytes = 16000
  responses["/api/config"].push({ type: "document", info: { tool_output: { max_lines: 500 } } })
  result = await inspect()
  assert.equal(result.valid, false)
  assert.equal(result.report.active.configurationMatches, false)
  assert.equal(result.report.active.configuration.maxBytes, 51200)
  responses["/api/config"].pop()
  responses["/api/config"].push({ type: "directory", info: { tool_output: { max_bytes: 999 } } })
  assert.equal((await inspect()).valid, true, "non-document entries never override settings")
  responses["/api/config"].push({ type: "document", info: { compaction: { auto: false }, experimental: {} } })
  result = await inspect()
  assert.equal(result.valid, false)
  assert.equal(result.report.active.configuration.keepTokens, 12000, "compaction retains explicitly configured scalars")
  assert.equal(result.report.active.configuration.depth, 1)
  responses["/api/config"].pop()
  responses["/api/config"].push({ type: "document", info: { websearch: false } })
  assert.equal((await inspect()).valid, false)
  responses["/api/config"].pop()
  responses["/api/skill"] = await Promise.all(Object.keys(inventory.skills).map(async (id) => ({ id, path: await realpath(join(root, "out/skills", id, "SKILL.md")) })))
  const runtime = () => reportInventory(inventory, "/nonexistent-fictional-source", { cli: "fake", command, runtimeOnly: true, installedServer: join(root, "out/server.json"), installedSkills: join(root, "out/skills") })
  result = await runtime()
  assert.equal(result.valid, true)
  assert.equal(result.report.intended.artifactsMatch, "not-inspected")
  await assert.rejects(reportInventory(inventory, root, { runtimeOnly: true }), /requires/)
  plugins[0].state.status = "failed"
  assert.equal((await inspect()).valid, false)
  assert.equal((await runtime()).valid, false)
})
