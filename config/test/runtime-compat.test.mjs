import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, rm, readFile, realpath, mkdir, copyFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { render as renderWith, render, apply, COMPATIBLE_OPENCODE, SOURCE } from "../render.mjs"
import { reportInventory, COMPATIBLE_OPENCODE as INVENTORY_COMPATIBLE, serverOrigin, locationDirectory } from "../inventory.mjs"

const revision = "a".repeat(40)
async function fixture(t, profile = "coder") {
  const root = await mkdtemp(join(await realpath(tmpdir()), "runtime-compat-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "platform.json"), JSON.stringify({ permissions: [], experimental: { subagent_depth: 2 } }))
  await writeFile(join(root, "platform.md"), "Fictional platform")
  const adapter = { profile, server: "platform.json", instructions: "platform.md", models: { general: { mode: "subagent", model: "example/fast" } },
    outputs: { server: "out/server.json", routes: "out/routes.json", instructions: "out/AGENTS.md", inventory: "out/inventory.json", skills: "out/skills" } }
  return { root, adapter }
}
// Central source copy whose manifest lists exactly `tested`; code/skills are linked from the real checkout.
async function sourceTesting(t, tested) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "runtime-compat-source-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, "config"))
  for (const file of ["roles.json", "instructions.md", "inventory.mjs"]) await copyFile(join(SOURCE, "config", file), join(dir, "config", file))
  const manifest = JSON.parse(await readFile(join(SOURCE, "config/manifest.json"), "utf8"))
  await writeFile(join(dir, "config/manifest.json"), JSON.stringify({ ...manifest, testedOpenCode: tested }))
  for (const link of ["opencode", "skills"]) await symlink(join(SOURCE, link), join(dir, link))
  return dir
}
const lockFor = (opencode) => ({ schemaVersion: 1, revision, pluginApi: "2.0", opencode })

test("exact 2.0.16 and 2.0.22 locks render; everything else is rejected", async (t) => {
  const { root, adapter } = await fixture(t)
  const both = await sourceTesting(t, ["2.0.16", "2.0.22"])
  assert.deepEqual([...COMPATIBLE_OPENCODE], ["2.0.16", "2.0.22"])
  const real = JSON.parse(await readFile(join(SOURCE, "config/manifest.json"), "utf8")).testedOpenCode
  assert.ok(real.includes("2.0.16") && real.every((version) => COMPATIBLE_OPENCODE.includes(version)), "manifest never lists a version the renderer/inventory do not support")
  assert.deepEqual([...INVENTORY_COMPATIBLE], [...COMPATIBLE_OPENCODE])
  const old = await render(lockFor("2.0.16"), adapter, root, both)
  const next = await render(lockFor("2.0.22"), adapter, root, both)
  assert.deepEqual([...old.keys()], [...next.keys()])
  for (const [path, bytes] of old) {
    if (path === "out/inventory.json") continue
    // Server config, routes, instructions and skills (the security surface) are identical.
    assert.ok(bytes.equals(next.get(path)), `${path} must not depend on the runtime version`)
  }
  assert.equal(JSON.parse(old.get("out/inventory.json")).central.opencode, "2.0.16")
  assert.equal(JSON.parse(next.get("out/inventory.json")).central.opencode, "2.0.22")
  for (const bad of ["2.0.17", "2.0.15", "2.0.2", "2.0.220", "v2.0.22", "2.0.22 ", "2.0.22-beta.1", "2.0", "latest", "", undefined, null, ["2.0.22"], 2.022]) {
    await assert.rejects(render(lockFor(bad), adapter, root, both), /unsupported OpenCode\/plugin API version/, `lock ${JSON.stringify(bad)}`)
  }
  await assert.rejects(render({ ...lockFor("2.0.22"), pluginApi: "3.0" }, adapter, root, both), /unsupported/)
})

test("a version must be in both the manifest and the compatibility set", async (t) => {
  const { root, adapter } = await fixture(t)
  const manifestOnly = await sourceTesting(t, ["2.0.16", "2.0.22", "2.0.99"])
  await assert.rejects(render(lockFor("2.0.99"), adapter, root, manifestOnly), /unsupported OpenCode/, "manifest cannot admit an inventory-unsupported version")
  await render(lockFor("2.0.22"), adapter, root, manifestOnly)
  const oldOnly = await sourceTesting(t, ["2.0.16"])
  await assert.rejects(render(lockFor("2.0.22"), adapter, root, oldOnly), /unsupported OpenCode/, "compat set cannot admit a version the manifest has not tested")
  await render(lockFor("2.0.16"), adapter, root, oldOnly)
  await assert.rejects(render(lockFor("2.0.16"), adapter, root, await sourceTesting(t, [])), /unsupported OpenCode/)
})

test("renderer security checks are unchanged under 2.0.22", async (t) => {
  const { root, adapter } = await fixture(t)
  const lock = lockFor("2.0.22")
  const source = await sourceTesting(t, ["2.0.16", "2.0.22"])
  const render = (...args) => renderWith(args[0], args[1], args[2], source)
  await writeFile(join(root, "platform.json"), JSON.stringify({ permissions: [], experimental: { subagent_depth: 2 }, providers: { fake: { apiKey: "literal-fake-value" } } }))
  await assert.rejects(render(lock, adapter, root), /environment references/)
  await writeFile(join(root, "platform.json"), JSON.stringify({ permissions: [] }))
  await assert.rejects(render(lock, adapter, root), /depth 2/)
  await writeFile(join(root, "platform.json"), JSON.stringify({ permissions: [], experimental: { subagent_depth: 2 }, unknown: true }))
  await assert.rejects(render(lock, adapter, root), /unknown field unknown/)
  await writeFile(join(root, "platform.json"), JSON.stringify({ permissions: [], experimental: { subagent_depth: 2 } }))
  await assert.rejects(render({ ...lock, extra: 1 }, adapter, root), /unknown field extra/)
  await assert.rejects(render({ ...lock, revision: "main" }, adapter, root), /immutable/)
  await assert.rejects(render(lock, { ...adapter, profile: "coder", models: { general: { mode: "all", model: "example/fast" } } }, root), /subagent-only/)
  await assert.rejects(render(lock, { ...adapter, outputs: { ...adapter.outputs, server: "../escape.json" } }, root), /unsafe path/)
})

async function rendered(t, opencode) {
  const { root, adapter } = await fixture(t)
  const lock = lockFor(opencode)
  const outputs = await render(lock, adapter, root, await sourceTesting(t, ["2.0.16", "2.0.22"])); await apply(outputs, root)
  const inventory = JSON.parse(outputs.get("out/inventory.json"))
  const config = JSON.parse(outputs.get("out/server.json"))
  const plugins = inventory.packages.map((pkg) => ({ source: { type: "package", target: `git+ssh://git@github.com/tomasmota/agents.git#${revision}::path:${pkg.path}`, version: revision }, state: { status: "active" } }))
  return { root, inventory, config, plugins }
}

for (const opencode of ["2.0.16", "2.0.22"]) {
  test(`inventory proves ${opencode} through the default service and an explicit unauthenticated server`, async (t) => {
    const { root, inventory, config, plugins } = await rendered(t, opencode)
    // Observed 2.0.22 shapes: info is bare; plugin/skill lists are {location,data}; config is an
    // entry array whose directory entries carry no `info`.
    const responses = { "/api/info": { version: opencode, pid: 1, urls: ["http://127.0.0.1:1"], paths: { tmp: "/fictional" } },
      "/api/plugin": { location: { directory: "/fictional" }, data: plugins },
      "/api/config": [{ type: "document", path: "/fictional/server.json", info: { ...config, providers: { fake: { apiKey: "fictional-do-not-print" } } } }, { type: "directory", path: "/fictional" }] }
    const calls = []
    const command = (_, args) => {
      calls.push(args)
      if (args[0] === "--version") return `opencode v${opencode}\n`
      assert.equal(args[0], "api")
      assert.equal(args.at(-2), "get")
      return JSON.stringify(responses[args.at(-1)])
    }
    let result = await reportInventory(inventory, root, { cli: "fake", command })
    assert.equal(result.valid, true)
    assert.equal(result.report.active.connection, "default-service")
    assert.ok(!("serverOrigin" in result.report.active))
    assert.ok(calls.filter((args) => args[0] === "api").every((args) => !args.includes("--server")))
    assert.equal(result.report.active.runtimeMatches, true)
    assert.equal(result.report.active.lockSupported, true)
    assert.equal(result.report.active.serverPID, 1, "actual /api/info pid")
    assert.deepEqual(result.report.active.location, { selection: "server-default", directory: "/fictional", matchesRequested: true, consistent: true })
    assert.ok(calls.filter((args) => args[0] === "api").every((args) => !args.at(-1).includes("location")), "no location query without --directory")
    assert.deepEqual(calls.filter((args) => args[0] === "api").map((args) => args.at(-1)).sort(), ["/api/config", "/api/info", "/api/plugin"])

    calls.length = 0
    const url = "http://127.0.0.1:4096/base"
    result = await reportInventory(inventory, root, { cli: "fake", command, server: url })
    assert.equal(result.valid, true)
    assert.equal(result.report.active.connection, "explicit-server")
    assert.equal(result.report.active.serverOrigin, "http://127.0.0.1:4096")
    const apiCalls = calls.filter((args) => args[0] === "api")
    assert.ok(apiCalls.length >= 3)
    for (const args of apiCalls) assert.deepEqual(args.slice(0, 3), ["api", "--server", url], "documented api --server form")
    assert.ok(!JSON.stringify(result.report).includes("fictional-do-not-print"))
    assert.ok(!JSON.stringify(result.report).includes("/base"))

    // Mismatched server (e.g. a stale background process) fails even when the CLI matches.
    responses["/api/info"].version = opencode === "2.0.22" ? "2.0.16" : "2.0.22"
    assert.equal((await reportInventory(inventory, root, { cli: "fake", command, server: url })).valid, false)
    responses["/api/info"].version = opencode
    // Settings merging is unchanged: later documents replace whole settings, compaction merges scalars.
    responses["/api/config"].push({ type: "document", path: "/later", info: { tool_output: { max_lines: 500 } } })
    assert.equal((await reportInventory(inventory, root, { cli: "fake", command })).valid, false)
    responses["/api/config"].pop()
    responses["/api/config"].push({ type: "document", path: "/later", info: { compaction: { buffer: 1 } } })
    assert.equal((await reportInventory(inventory, root, { cli: "fake", command })).valid, true, "unrelated compaction scalars keep configured values")
    responses["/api/config"].pop()
    plugins[0].state.status = "failed"
    assert.equal((await reportInventory(inventory, root, { cli: "fake", command, server: url })).valid, false)
  })
}

test("inventory rejects unsupported lock versions even when runtime matches", async (t) => {
  const { root, inventory } = await rendered(t, "2.0.22")
  const changed = { ...inventory, central: { ...inventory.central, opencode: "2.0.99" } }
  const command = (_, args) => args[0] === "--version" ? "opencode v2.0.99\n" : JSON.stringify(args.at(-1) === "/api/info" ? { version: "2.0.99" } : args.at(-1) === "/api/config" ? [] : { data: [] })
  const { report, valid } = await reportInventory(changed, root, { cli: "fake", command })
  assert.equal(valid, false)
  assert.equal(report.active.lockSupported, false)
})

test("explicit server URLs cannot carry credentials and require a CLI", async () => {
  assert.equal(serverOrigin("https://opencode.example:8443/"), "https://opencode.example:8443")
  for (const bad of ["ftp://evil.example", "http://user:pw@evil.example", "http://:pw@evil.example", "http://evil.example/?token=x", "http://evil.example/#frag", "not a url", ""]) {
    assert.throws(() => serverOrigin(bad), undefined, bad)
    await assert.rejects(reportInventory({ central: {}, artifacts: {}, packages: [], skills: {} }, "/nonexistent-fictional", { cli: "fake", server: bad, command: () => { throw new Error("must not invoke") } }))
  }
  await assert.rejects(reportInventory({ central: {}, artifacts: {} }, "/nonexistent-fictional", { server: "http://127.0.0.1:1" }), /requires an explicit CLI/)
})

test("inventory CLI refuses a dangling --server rather than using the default service", async (t) => {
  const { root, inventory } = await rendered(t, "2.0.22")
  await writeFile(join(root, "inv.json"), JSON.stringify(inventory))
  const script = fileURLToPath(new URL("../inventory.mjs", import.meta.url))
  const fake = join(root, "fake-opencode"); await writeFile(fake, "#!/bin/sh\necho invoked >> \"$0.log\"\nexit 1\n", { mode: 0o755 })
  for (const extra of [["--server"], ["--server", "--runtime-only"], ["--server", "http://u:p@evil.example"]]) {
    let status = 0
    try { execFileSync(process.execPath, [script, "--inventory", join(root, "inv.json"), "--root", root, "--opencode", fake, ...extra], { stdio: "pipe" }) } catch (error) { status = error.status }
    assert.equal(status, 1, extra.join(" "))
  }
  assert.equal(await readFile(`${fake}.log`, "utf8").catch(() => null), null, "fake CLI never invoked")
})

test("--directory selects the location for plugin, config and skill lists only and reports the actual directory", async (t) => {
  const { root, inventory, config, plugins } = await rendered(t, "2.0.22")
  const skillsRoot = join(root, "out/skills")
  const skills = await Promise.all(Object.keys(inventory.skills).map(async (id) => ({ id, path: await realpath(join(skillsRoot, id, "SKILL.md")) })))
  const wanted = "/fictional/work tree/é&=#?"
  let location = wanted
  const paths = []
  const command = (_, args) => {
    if (args[0] === "--version") return "opencode v2.0.22\n"
    const path = args.at(-1)
    paths.push(path)
    if (path === "/api/info") return JSON.stringify({ version: "2.0.22", pid: 4242, urls: [], paths: { tmp: "/x" } })
    const base = path.split("?")[0]
    if (base === "/api/config") return JSON.stringify([{ type: "document", path: "/x", info: config }])
    return JSON.stringify({ location: { directory: location }, data: base === "/api/plugin" ? plugins : skills })
  }
  const options = { cli: "fake", command, installedSkills: skillsRoot, directory: wanted }
  let result = await reportInventory(inventory, root, options)
  assert.equal(result.valid, true)
  const query = `?location[directory]=${encodeURIComponent(wanted)}`
  assert.deepEqual([...paths].sort(), ["/api/config" + query, "/api/info", "/api/plugin" + query, "/api/skill" + query].sort())
  assert.ok(!paths.filter((path) => path.includes("?")).some((path) => /[&=#?\s]/.test(path.split("?")[1].replace("location[directory]=", ""))), "directory value is percent-encoded")
  assert.deepEqual(result.report.active.location, { selection: "explicit", directory: wanted, skillsDirectory: wanted, matchesRequested: true, consistent: true })
  assert.equal(result.report.active.serverPID, 4242)
  // With an explicit server both are forwarded in the documented form.
  paths.length = 0
  const calls = []
  const spy = (cli, args) => { calls.push(args); return command(cli, args) }
  result = await reportInventory(inventory, root, { ...options, command: spy, server: "http://127.0.0.1:4096" })
  assert.equal(result.valid, true)
  for (const args of calls.filter((args) => args[0] === "api")) assert.deepEqual(args.slice(0, 4), ["api", "--server", "http://127.0.0.1:4096", "get"])
  // The server answering for a different directory (its default) is not the requested location.
  location = "/fictional/server-default"
  result = await reportInventory(inventory, root, options)
  assert.equal(result.valid, false)
  assert.equal(result.report.active.location.matchesRequested, false)
  assert.equal(result.report.active.location.directory, "/fictional/server-default")
  // Without --directory the same server default is simply reported.
  result = await reportInventory(inventory, root, { ...options, directory: undefined })
  assert.equal(result.valid, true)
  assert.equal(result.report.active.location.selection, "server-default")
  assert.equal(result.report.active.location.directory, "/fictional/server-default")
  // Missing envelope location or plugin/skill disagreement fails closed.
  location = undefined
  result = await reportInventory(inventory, root, options)
  assert.equal(result.valid, false)
  assert.equal(result.report.active.location.directory, "unreported")
  location = wanted
  const skewed = (cli, args) => args.at(-1).startsWith("/api/skill") ? JSON.stringify({ location: { directory: "/fictional/other" }, data: skills }) : command(cli, args)
  result = await reportInventory(inventory, root, { ...options, command: skewed })
  assert.equal(result.valid, false)
  assert.equal(result.report.active.location.consistent, false)
  // A locally symlinked requested path is accepted when the server reports its real path.
  const real = await realpath(root)
  await symlink(real, join(root, "link"))
  location = real
  result = await reportInventory(inventory, root, { ...options, directory: join(root, "link") })
  assert.equal(result.valid, true)
  // Secret-safety: only selected scalars are printed, never response bodies or the request path.
  assert.ok(!JSON.stringify(result.report).includes("/fictional/work"))
  assert.deepEqual(Object.keys(result.report.active.location).sort(), ["consistent", "directory", "matchesRequested", "selection", "skillsDirectory"])
})

test("--directory input is validated and a dangling CLI --directory never queries the default location", async (t) => {
  for (const bad of ["", "relative/path", "./x", "a\0b", "/a\nb", undefined === 1, 7, null]) assert.throws(() => locationDirectory(bad), /invalid directory/)
  assert.equal(locationDirectory("/ok/dir"), "/ok/dir")
  await assert.rejects(reportInventory({ central: {}, artifacts: {} }, "/nonexistent-fictional", { directory: "/ok" }), /requires an explicit CLI/)
  await assert.rejects(reportInventory({ central: {}, artifacts: {} }, "/nonexistent-fictional", { cli: "fake", directory: "relative", command: () => { throw new Error("must not invoke") } }))
  const { root, inventory } = await rendered(t, "2.0.22")
  await writeFile(join(root, "inv.json"), JSON.stringify(inventory))
  const script = fileURLToPath(new URL("../inventory.mjs", import.meta.url))
  const fake = join(root, "fake-opencode"); await writeFile(fake, "#!/bin/sh\necho invoked >> \"$0.log\"\nexit 1\n", { mode: 0o755 })
  for (const extra of [["--directory"], ["--directory", "--runtime-only"], ["--directory", "relative"], ["--server", "http://127.0.0.1:1", "--directory"]]) {
    let status = 0
    try { execFileSync(process.execPath, [script, "--inventory", join(root, "inv.json"), "--root", root, "--opencode", fake, ...extra], { stdio: "pipe" }) } catch (error) { status = error.status }
    assert.equal(status, 1, extra.join(" "))
  }
  assert.equal(await readFile(`${fake}.log`, "utf8").catch(() => null), null, "fake CLI never invoked")
})
