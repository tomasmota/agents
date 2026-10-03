import assert from "node:assert/strict"
import test from "node:test"

import { GcloudAuthHealerPlugin } from "../gcloud-auth-healer.js"

const {
  healerConfig,
  isAuthLoginCommand,
  failureTextOf,
  classifyFailure,
  buildHealCommand,
  healMessage,
  createHealer,
} = GcloudAuthHealerPlugin.__test()

const EXPIRED = "ERROR: (gcloud.compute.instances.list) Your session has expired. invalid_grant: Token has been expired or revoked. Run gcloud auth login to re-authenticate."
const ADC_BROKEN = "failed to load application default credentials: Get https://oauth2.googleapis.com/token: oauth2: cannot fetch token: 400 Bad Request. Unable to read quota project."
const IAM_DENIED = "ERROR: (gcloud.compute.instances.get) PERMISSION_DENIED: The user does not have permission to access the instance."

function shellAfter(command, text, extra = {}) {
  return {
    tool: "shell",
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input: { command },
    status: "error",
    error: { message: text },
    ...extra,
  }
}

test("config defaults and overrides", () => {
  assert.deepEqual(healerConfig({}, {}), { cooldownMs: 300_000, logPath: "/tmp/gcloud-reauth.log" })
  assert.equal(healerConfig({}, { OPENCODE_GCLOUD_AUTH_COOLDOWN_SECONDS: "60" }).cooldownMs, 60_000)
  assert.equal(healerConfig({ cooldownSeconds: 10 }, { OPENCODE_GCLOUD_AUTH_COOLDOWN_SECONDS: "60" }).cooldownMs, 10_000)
  assert.equal(healerConfig({}, { OPENCODE_GCLOUD_AUTH_LOG: "/tmp/x.log" }).logPath, "/tmp/x.log")
  assert.equal(healerConfig({}, { OPENCODE_GCLOUD_AUTH_LOG: "relative.log" }).logPath, "/tmp/gcloud-reauth.log")
})

test("never fires for the login commands themselves", () => {
  assert.equal(isAuthLoginCommand("gcloud auth login --update-adc"), true)
  assert.equal(isAuthLoginCommand("gcloud auth application-default login"), true)
  assert.equal(classifyFailure("gcloud auth login --update-adc", EXPIRED), null)
})

test("classifies gcloud expiry as full and non-gcloud ADC breakage as adc", () => {
  assert.equal(classifyFailure("gcloud compute instances list", EXPIRED), "full")
  assert.equal(classifyFailure("tofu plan", ADC_BROKEN), "adc")
  assert.equal(classifyFailure("gcloud compute instances list", ADC_BROKEN), "full")
})

test("ignores IAM permission errors and unrelated tools", () => {
  assert.equal(classifyFailure("gcloud compute instances list", IAM_DENIED), null)
  assert.equal(classifyFailure("kubectl get pods", "error: You must be logged in"), null)
  assert.equal(classifyFailure("gcloud compute instances list", ""), null)
})

test("reads failure text from error and completed shapes", () => {
  assert.match(failureTextOf(shellAfter("gcloud x", EXPIRED)), /invalid_grant/)
  const completed = {
    tool: "shell",
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input: { command: "gcloud x" },
    status: "completed",
    result: { content: [{ type: "text", text: EXPIRED }], metadata: { exit: 1 } },
  }
  assert.match(failureTextOf(completed), /invalid_grant/)
})

test("builds full and adc heal commands", () => {
  assert.equal(
    buildHealCommand("full", "/tmp/gcloud-reauth.log"),
    "nohup gcloud auth login --update-adc >/tmp/gcloud-reauth.log 2>&1 &",
  )
  assert.equal(
    buildHealCommand("adc", "/tmp/gcloud-reauth.log"),
    "nohup gcloud auth application-default login >/tmp/gcloud-reauth.log 2>&1 &",
  )
})

test("message tells the agent to finish auth and poll", () => {
  const text = healMessage({
    command: "gcloud compute instances list",
    kind: "full",
    healCommand: buildHealCommand("full", "/tmp/gcloud-reauth.log"),
    logPath: "/tmp/gcloud-reauth.log",
  })
  assert.match(text, /background.*re-login was started/)
  assert.match(text, /Complete the browser prompt/)
  assert.match(text, /poll the failing command/)
  assert.match(text, /~5 min/)
})

test("spawns once per cooldown, then notes in-flight instead", async () => {
  const spawns = []
  const sent = []
  let now = 0
  const healer = createHealer({
    config: { cooldownMs: 300_000, logPath: "/tmp/gcloud-reauth.log" },
    spawnFn: async (cmd) => void spawns.push(cmd),
    synthetic: async (input) => void sent.push(input),
    clock: { now: () => now },
  })
  await healer.after(shellAfter("gcloud compute instances list", EXPIRED))
  assert.equal(spawns.length, 1)
  assert.match(sent[0].text, /re-login was started/)
  now += 60_000
  await healer.after({ ...shellAfter("gcloud compute instances list", EXPIRED), id: "call_2" })
  assert.equal(spawns.length, 1)
  assert.match(sent[1].text, /still in flight/)
  now += 300_000
  await healer.after({ ...shellAfter("gcloud compute instances list", EXPIRED), id: "call_3" })
  assert.equal(spawns.length, 2)
})

test("ignores non-shell tools and empty commands", async () => {
  let spawns = 0
  const healer = createHealer({
    config: { cooldownMs: 300_000, logPath: "/tmp/gcloud-reauth.log" },
    spawnFn: async () => void (spawns += 1),
    synthetic: async () => {},
    clock: { now: () => 0 },
  })
  await healer.after({ ...shellAfter("gcloud x", EXPIRED), tool: "read" })
  await healer.after(shellAfter("   ", EXPIRED))
  assert.equal(spawns, 0)
})

test("successful documentation diffs, searches and shell output never start a login", async () => {
  const doc = "A gcloud/ADC command fails with an expired-session error; the plugin starts re-auth."
  const commands = [
    "git diff HEAD..origin/main -- agents/global/AGENTS.md",
    "grep gcloud agents/global/AGENTS.md",
    "gcloud compute instances list",
  ]
  let spawns = 0
  let notices = 0
  const healer = createHealer({
    config: { cooldownMs: 300_000, logPath: "/tmp/fictional-test.log" },
    spawnFn: async () => { spawns++ },
    synthetic: async () => { notices++ },
  })
  for (const command of commands) {
    for (const result of [
      { content: [{ type: "text", text: doc }], metadata: { exit: 0 } },
      { output: { output: doc, exit: 0, status: "completed" } },
      { output: { output: doc, exit: 1 }, metadata: { exit: 0 } },
      { output: { output: doc, exit: 0 }, metadata: { exit: 1 } },
    ]) {
      await healer.after(shellAfter(command, doc, { status: "completed", result }))
    }
  }
  assert.equal(spawns, 0)
  assert.equal(notices, 0)
})

test("unknown, nonnumeric and running exits are not affirmative failures", async () => {
  let spawns = 0
  const healer = createHealer({
    config: { cooldownMs: 300_000, logPath: "/tmp/fictional-test.log" },
    spawnFn: async () => { spawns++ },
    synthetic: async () => { throw new Error("unexpected notice") },
  })
  for (const result of [
    { content: EXPIRED },
    { content: EXPIRED, metadata: { exit: "1" } },
    { content: EXPIRED, metadata: { exit: null } },
    { content: EXPIRED, metadata: { exit: NaN } },
    { content: EXPIRED, metadata: { exit: Infinity } },
    { content: EXPIRED, metadata: { exit: 1, status: "running" } },
  ]) await healer.after(shellAfter("gcloud compute instances list", EXPIRED, { status: "completed", result }))
  assert.equal(spawns, 0)
})

test("nonzero native output or metadata exits still heal real completed failures", async () => {
  for (const result of [
    { output: { output: EXPIRED, exit: 1, status: "completed" } },
    { content: [{ type: "text", text: EXPIRED }], metadata: { exit: 1 } },
  ]) {
    const spawns = []
    const healer = createHealer({
      config: { cooldownMs: 300_000, logPath: "/tmp/fictional-test.log" },
      spawnFn: async (command) => { spawns.push(command) },
      synthetic: async () => {},
    })
    await healer.after(shellAfter("gcloud compute instances list", EXPIRED, { status: "completed", result }))
    assert.equal(spawns.length, 1)
    assert.match(spawns[0], /login --update-adc/)
  }
})
