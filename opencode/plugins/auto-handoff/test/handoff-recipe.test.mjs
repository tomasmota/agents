import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("the handoff skill's jq session recipe preserves optional agent, model and variant", async (t) => {
  const jq = process.env.JQ ?? "jq"
  try {
    execFileSync(jq, ["--version"], { encoding: "utf8", timeout: 5000 })
  } catch (error) {
    if (error.code !== "ENOENT" || process.env.JQ) throw error
    t.skip("jq is not installed; the plugin itself only requires Node")
    return
  }
  const skill = await readFile(new URL("../../../../skills/handoff/SKILL.md", import.meta.url), "utf8")
  const filter = /'(\{title:\$title,location:[^\n]+)'/.exec(skill)?.[1]
  assert.ok(filter, "the documented jq filter must be exercised, not a test copy")
  const payload = (agent, provider, id, variant) => JSON.parse(execFileSync(jq, [
    "-n", "--arg", "title", "Handoff: fictional task", "--arg", "dir", "/fictional/repo",
    "--arg", "agent", agent, "--arg", "provider", provider, "--arg", "id", id,
    "--arg", "variant", variant, filter,
  ], { encoding: "utf8", timeout: 5000 }))
  const base = { title: "Handoff: fictional task", location: { directory: "/fictional/repo" } }
  assert.deepEqual(payload("", "", "", ""), base)
  assert.deepEqual(payload("general", "", "", ""), { ...base, agent: "general" })
  assert.deepEqual(payload("", "example", "model:literal", ""), {
    ...base, model: { providerID: "example", id: "model:literal" },
  })
  assert.deepEqual(payload("general", "example", "model", "high"), {
    ...base, agent: "general", model: { providerID: "example", id: "model", variant: "high" },
  })
})
