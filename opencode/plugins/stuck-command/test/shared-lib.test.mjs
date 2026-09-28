import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

// OpenCode installs each plugin directory as its own package, so shared files
// are copied. auto-approve-jev/lib is canonical; this copy must match it.
for (const file of ["jev-client.js", "decision-audit.js"]) {
  test(`lib/${file} matches auto-approve-jev/lib/${file}`, async () => {
    const canonical = await readFile(new URL(`../../auto-approve-jev/lib/${file}`, import.meta.url), "utf8")
    const copy = await readFile(new URL(`../lib/${file}`, import.meta.url), "utf8")
    assert.equal(copy, canonical, `copy auto-approve-jev/lib/${file} to stuck-command/lib/${file}`)
  })
}
