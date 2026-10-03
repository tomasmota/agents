#!/usr/bin/env node
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile, readdir, mkdir, writeFile, lstat, rm } from "node:fs/promises"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { validateRoutes } from "../opencode/plugins/agent-routes/lib/agent-routes.js"

export const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// Exact consumer-lock versions whose V2 server/CLI/plugin API behavior is verified
// (2.0.22 added no config-merge, plugin, skill or info envelope changes relative
// to 2.0.16). Exact strings only; no ranges or prefixes. A lock must be in BOTH this
// set and manifest.testedOpenCode, so the manifest cannot admit a version the
// installed inventory tool does not support. Rendered output differs between
// versions only by the recorded lock version.
export const COMPATIBLE_OPENCODE = Object.freeze(["2.0.16", "2.0.22"])
const json = (value) => JSON.stringify(value, null, 2) + "\n"
const hash = (value) => createHash("sha256").update(value).digest("hex")
const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"))
function keys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`)
}
function safePath(root, path) {
  if (typeof path !== "string" || !path || /[\\\0]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe path: ${path}`)
  return join(root, path)
}
async function noSymlinks(root, path) {
  safePath(root, path)
  // lstat every component from the filesystem root, including the consumer
  // root itself. Starting at root would already follow a symlinked ancestor.
  let current = resolve(root, path)
  const chain = []
  while (dirname(current) !== current) {
    chain.unshift(current)
    current = dirname(current)
  }
  for (current of [current, ...chain]) {
    const stat = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (stat?.isSymbolicLink()) throw new Error(`symlink rejected: ${path}`)
  }
}
function credentials(value, headers = false) {
  if (!value || typeof value !== "object") return
  for (const [key, item] of Object.entries(value)) {
    // Remote MCP/provider headers have arbitrary names, including x-api-key,
    // x-goog-api-key, x-auth-token and CF-Access-Client-Secret. Default unknown
    // headers to references rather than attempting an exhaustive secret list.
    const publicHeader = /^(accept|content-type|user-agent|anthropic-version|anthropic-beta)$/i.test(key)
    if ((headers && !publicHeader) || /^(api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|client[-_]?secret|authorization|proxy-authorization|cookie)$|_(API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) {
      if (typeof item !== "string" || !/^(?:(?:Bearer|Basic) )?\{env:[A-Z_][A-Z0-9_]*\}$/.test(item)) throw new Error("credentials must be environment references, never rendered values")
    }
    if (/^(url|baseURL)$/i.test(key) && typeof item === "string" && /^https?:/.test(item)) {
      const url = new URL(item)
      if (url.username || url.password || [...url.searchParams.keys()].some((name) => /key|token|secret|password/i.test(name))) throw new Error("credential-bearing URL rejected")
    }
    credentials(item, /^(headers|httpHeaders)$/i.test(key))
  }
}
async function filesUnder(root, path) {
  const result = []
  for (const entry of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isSymbolicLink()) throw new Error(`source symlink rejected: ${path}/${entry.name}`)
    if (entry.isDirectory()) result.push(...await filesUnder(root, `${path}/${entry.name}`))
    else result.push(`${path}/${entry.name}`)
  }
  return result
}

export async function render(lock, adapter, root, source = SOURCE) {
  keys(lock, ["schemaVersion", "revision", "pluginApi", "opencode"], "lock")
  keys(adapter, ["profile", "server", "instructions", "cli", "models", "fallbacks", "pluginOptions", "outputs"], "adapter")
  await noSymlinks(root, adapter.server)
  const manifest = await readJSON(join(source, "config/manifest.json"))
  if (lock.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(lock.revision)) throw new Error("immutable 40-hex central revision required")
  if (lock.pluginApi !== manifest.pluginApi || !(Array.isArray(manifest.testedOpenCode) && manifest.testedOpenCode.includes(lock.opencode) && COMPATIBLE_OPENCODE.includes(lock.opencode))) throw new Error("unsupported OpenCode/plugin API version")
  const profile = manifest.profiles[adapter.profile]
  if (!profile) throw new Error(`unknown profile: ${adapter.profile}`)
  keys(adapter.outputs, ["server", "instructions", "routes", "inventory", "inventoryTool", "skills", "helpers", "cli"], "outputs")
  for (const required of ["server", "instructions", "routes", "inventory", "skills"]) safePath(root, adapter.outputs[required])
  if (profile.cli !== Boolean(adapter.cli)) throw new Error("CLI adapter/profile mismatch")
  // Portable selector imports and the helper's default routes path are a
  // deliberate layout contract, not arbitrary independent output locations.
  if (profile.cli) {
    const parent = dirname(adapter.outputs.skills)
    if (adapter.outputs.helpers !== join(parent, "opencode/lib") || adapter.outputs.routes !== join(parent, "opencode/subagents.jsonc")) {
      throw new Error("CLI helper layout requires sibling opencode/lib and opencode/subagents.jsonc beside the skills directory")
    }
  }
  const inputFiles = [adapter.server, adapter.instructions, ...(adapter.cli ? [adapter.cli] : [])]
  for (const path of inputFiles) await noSymlinks(root, path)
  const base = await readJSON(safePath(root, adapter.server))
  keys(base, ["$schema", "update", "share", "shell", "permissions", "experimental", "providers", "agents", "mcp", "skills", "model", "default_agent"], "server adapter")
  if (!Array.isArray(base.permissions)) throw new Error("explicit platform permission rules required")
  if (base.experimental?.subagent_depth !== 2) throw new Error("explicit depth 2 required")
  credentials(base)
  const roles = await readJSON(join(source, "config/roles.json"))
  const childRules = [
    { action: "question", resource: "*", effect: "deny", when: "child" },
    { action: "subagent", resource: "*", effect: "deny", when: "child" },
    { action: "subagent", resource: "explore", effect: "allow", when: "child" },
  ]
  const agents = {}
  for (const [id, selection] of Object.entries(adapter.models)) {
    if (!Object.hasOwn(roles, id)) throw new Error(`unknown role: ${id}`)
    keys(selection, ["model", "mode"], `models.${id}`)
    if (!/^[^/]+\/.+/.test(selection.model) || !["all", "subagent"].includes(selection.mode)) throw new Error(`invalid selection for ${id}`)
    agents[id] = { ...roles[id], ...selection }
  }
  if (adapter.profile === "coder" && Object.values(adapter.models).some((selection) => selection.mode !== "subagent")) throw new Error("Coder shared roles must remain subagent-only")
  const pluginOptions = adapter.pluginOptions ?? {}
  for (const id of Object.keys(pluginOptions)) if (!profile.plugins.includes(id)) throw new Error(`unsupported plugin option: ${id}`)
  const optionKeys = { "agent-routes": ["routesFile", "stateFile", "quotaAdapter"], "auto-retitle": ["model", "maxMessages", "userChars"],
    "auto-handoff": ["threshold"] }
  for (const [id, options] of Object.entries(pluginOptions)) keys(options, optionKeys[id] ?? [], `pluginOptions.${id}`)
  const plugins = []
  for (const id of profile.plugins) {
    const pkg = manifest.packages[id]
    const info = await readJSON(join(source, pkg.path, "package.json"))
    await readFile(join(source, pkg.path, info.main))
    const spec = `git+ssh://git@github.com/tomasmota/agents.git#${lock.revision}::path:${pkg.path}`
    const options = pluginOptions[id] ?? (id === "auto-handoff" ? { threshold: 250000 } : id === "auto-retitle" ? { model: "openai/gpt-6-luna#low" } : undefined)
    plugins.push(options ? { package: spec, options } : spec)
  }
  const server = { ...base, websearch: { provider: "exa" }, tool_output: { max_lines: 500, max_bytes: 16000 },
    compaction: { auto: true, keep: { tokens: 12000 } }, plugins, agents: { ...base.agents, ...agents } }
  const routes = { fallbacks: adapter.fallbacks ?? {}, quotaLow: { fiveHour: 20, weekly: 10 }, permissions: childRules, agents }
  const { errors } = validateRoutes(routes)
  if (errors.length) throw new Error(`invalid routes: ${errors.join("; ")}`)
  const outputs = new Map()
  const add = (path, content) => {
    safePath(root, path)
    if (inputFiles.some((input) => input === path || path.startsWith(`${input}/`) || input.startsWith(`${path}/`))) throw new Error(`output/input collision: ${path}`)
    if ([...outputs.keys()].some((other) => path.startsWith(`${other}/`) || other.startsWith(`${path}/`))) throw new Error(`output path collision: ${path}`)
    if (outputs.has(path)) throw new Error(`duplicate output: ${path}`)
    outputs.set(path, Buffer.from(content))
  }
  add(adapter.outputs.server, json(server))
  add(adapter.outputs.routes, json(routes))
  add(adapter.outputs.instructions, `<!-- Generated from agents ${lock.revision}; edit the platform adapter or shared source. -->\n\n` +
    (await readFile(safePath(root, adapter.instructions), "utf8")).trimEnd() + "\n\n" + await readFile(join(source, "config/instructions.md"), "utf8"))
  if (profile.cli) add(adapter.outputs.cli, await readFile(safePath(root, adapter.cli)))
  const skills = {}
  for (const id of profile.skills) {
    const skill = manifest.skills[id]
    const skillFiles = await filesUnder(source, skill.path)
    skills[id] = { ...skill, files: {} }
    for (const file of skillFiles) {
      const content = await readFile(join(source, file))
      skills[id].files[relative(skill.path, file)] = hash(content)
      add(`${adapter.outputs.skills}/${id}/${relative(skill.path, file)}`, content)
    }
  }
  if (profile.cli) {
    for (const file of ["jev-client.js", "agent-routes.js", "quota-cache.js"]) {
      const path = file === "jev-client.js" ? "opencode/lib/jev-client.js" : `opencode/plugins/agent-routes/lib/${file}`
      add(`${adapter.outputs.helpers}/${file}`, await readFile(join(source, path)))
    }
  }
  if (adapter.outputs.inventoryTool) add(adapter.outputs.inventoryTool, await readFile(join(source, "config/inventory.mjs")))
  const inputs = { adapter: hash(json(adapter)), files: {} }
  for (const path of inputFiles) inputs.files[path] = hash(await readFile(safePath(root, path)))
  add(adapter.outputs.inventory, json({ schemaVersion: 1, central: lock, profile: adapter.profile, inputs,
    server: adapter.outputs.server,
    packages: profile.plugins.map((id) => ({ id, ...manifest.packages[id] })), skills,
    artifacts: Object.fromEntries([...outputs].map(([path, content]) => [path, hash(content)])) }))
  return outputs
}

export async function apply(outputs, root, check = false) {
  await noSymlinks(root, "root-validation")
  const stale = []
  const obsolete = new Set()
  for (const [path, content] of outputs) {
    await noSymlinks(root, path)
    if (!path.endsWith(".json")) continue
    let next
    try { next = JSON.parse(content) } catch { continue }
    if (!next.artifacts || !next.central) continue
    const previous = await readJSON(safePath(root, path)).catch((error) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    for (const [old, expected] of Object.entries(previous?.artifacts ?? {})) {
      if (outputs.has(old)) continue
      if (Object.hasOwn(next.inputs.files, old)) throw new Error(`obsolete output/input collision: ${old}`)
      await noSymlinks(root, old)
      const bytes = await readFile(safePath(root, old)).catch((error) => {
        if (error.code === "ENOENT") return null
        throw error
      })
      if (!bytes) continue
      if (hash(bytes) !== expected) throw new Error(`changed obsolete generated artifact; preserve and reconcile: ${old}`)
      obsolete.add(old)
    }
  }
  if (check && obsolete.size) throw new Error(`obsolete generated artifacts: ${[...obsolete].join(", ")}`)
  if (!check) for (const path of obsolete) await rm(safePath(root, path))
  for (const [path, content] of outputs) {
    const target = safePath(root, path)
    if (check) {
      const actual = await readFile(target).catch(() => null)
      if (!actual?.equals(content)) stale.push(path)
    } else {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
  }
  if (stale.length) throw new Error(`stale generated artifacts: ${stale.join(", ")}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const allowed = new Set(["--lock", "--adapter", "--root", "--check"])
    const seen = new Set()
    for (let i = 0; i < args.length; i++) {
      if (!allowed.has(args[i]) || seen.has(args[i])) throw new Error("unknown or repeated CLI option")
      seen.add(args[i])
      if (args[i] !== "--check" && (!args[++i] || args[i].startsWith("--"))) throw new Error("missing CLI option value")
    }
    for (const name of ["--lock", "--adapter", "--root"]) if (!seen.has(name)) throw new Error(`missing ${name}`)
    const option = (name) => args[args.indexOf(name) + 1]
    const lock = await readJSON(resolve(option("--lock")))
    const root = resolve(option("--root"))
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: SOURCE, encoding: "utf8" }).trim()
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: SOURCE, encoding: "utf8" }).trim()
    if (revision !== lock.revision || dirty) throw new Error("renderer checkout must be clean and match the locked central revision")
    const outputs = await render(lock, await readJSON(resolve(option("--adapter"))), root)
    if ([...outputs.keys()].some((path) => [option("--adapter"), option("--lock")].some((input) => resolve(root, path) === resolve(input)))) throw new Error("output collides with adapter/lock")
    await apply(outputs, root, args.includes("--check"))
    console.log(`agents render: ${args.includes("--check") ? "verified" : "generated"} ${outputs.size} artifacts at ${revision}`)
  } catch (error) {
    console.error(`agents render: ${error.message}`)
    process.exitCode = 1
  }
}
