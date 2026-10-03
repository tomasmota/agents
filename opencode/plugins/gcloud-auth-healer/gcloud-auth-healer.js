// Gcloud auth healer.
//
// The org expires gcloud sessions daily. When a gcloud (or ADC-consuming)
// command fails with an expired-session/auth error, this plugin starts the
// re-login as a background process and tells the agent what to do, so the
// agent does not stop and wait for the user.
//
// Detection runs on `tool.execute.after` for shell commands. It never fires
// for the login commands themselves, and IAM permission errors (e.g.
// "does not have permission", PERMISSION_DENIED) do not count as expiry.
// Only explicit tool errors or native nonzero shell exits qualify; a zero or
// unknown exit must not turn successful documentation output into a login.
//
// On detection the plugin spawns one of:
//   nohup gcloud auth login --update-adc >/tmp/gcloud-reauth.log 2>&1 &
//   nohup gcloud auth application-default login >/tmp/gcloud-reauth.log 2>&1 &
// at most once per cooldown window; further auth failures inside the window
// get a short "already in progress" note instead of another login process.
// The ADC-only command is used when the failure names application-default
// credentials and the failing command is not itself gcloud (e.g. tofu or a
// Python tool reading ADC); otherwise the full login (which also updates ADC)
// is used.
//
// Runtime configuration (plugin options take precedence):
//   cooldownSeconds    seconds between login spawns, 1-3600, default 300
//                      (env OPENCODE_GCLOUD_AUTH_COOLDOWN_SECONDS)
//   logPath            absolute path for re-auth output, default /tmp/gcloud-reauth.log
//                      (env OPENCODE_GCLOUD_AUTH_LOG)

import { spawn } from "node:child_process"

import { Plugin } from "@opencode/plugin"

const DEFAULT_LOG_PATH = "/tmp/gcloud-reauth.log"
const DEFAULT_COOLDOWN_SECONDS = 300
const FAILURE_TEXT_CHARS = 4000
const COMMAND_MESSAGE_CHARS = 200

const SHELL_TOOLS = new Set(["shell", "bash"])

// The login commands themselves must never trigger the healer.
function isAuthLoginCommand(command) {
  return /\bgcloud\s+auth\s+(login|application-default\s+login)\b/i.test(command || "")
}

function isGcloudRelated(command) {
  return /\bgcloud\b|\bgsutil\b|\bbq\b/i.test(command || "")
}

const ADC_MARKERS = [
  /application[\s_-]*default/i,
  /\bADC\b/,
  /quota project/i,
  /GOOGLE_APPLICATION_CREDENTIALS/i,
]

// Auth/session-expiry signals. Deliberately excludes IAM permission errors.
const AUTH_FAILURE_MARKERS = [
  /reauth/i,
  /invalid_grant/i,
  /refresh token/i,
  /(token|session|credentials?|login).{0,40}(expired|expiring)/i,
  /(expired|expiring).{0,40}(token|session|credentials?)/i,
  /could not load the default credentials/i,
  /failed to load (application default )?credentials/i,
  /unable to (load|read|find).{0,60}credentials/i,
  /no (active account|valid credentials?|credentials)/i,
  /not (authenticated|logged in)/i,
  /login required/i,
  /UNAUTHENTICATED/i,
  /run gcloud auth login/i,
  /gcloud auth (login|application-default)/i,
  /authentication (failed|error|required)/i,
]

function recordOf(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null
}

function numberOption(value, min, max, fallback) {
  const n = typeof value === "string" ? Number(value) : value
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback
}

function safeLogPath(value, fallback = DEFAULT_LOG_PATH) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 240) return fallback
  if (!/^[A-Za-z0-9_./-]+$/.test(value)) return fallback
  return value
}

function healerConfig(options = {}, env = process.env) {
  const cooldownSeconds =
    numberOption(options.cooldownSeconds, 1, 3600, undefined) ??
    numberOption(env.OPENCODE_GCLOUD_AUTH_COOLDOWN_SECONDS, 1, 3600, DEFAULT_COOLDOWN_SECONDS)
  return {
    cooldownMs: cooldownSeconds * 1000,
    logPath: safeLogPath(options.logPath ?? env.OPENCODE_GCLOUD_AUTH_LOG),
  }
}

function appendText(parts, value, budget) {
  if (budget <= 0) return budget
  let text = ""
  if (typeof value === "string") {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? ""
    } catch {
      text = ""
    }
  }
  if (!text) return budget
  parts.push(text.slice(0, budget))
  return budget - Math.min(text.length, budget)
}

// Collect failure output from either after-event shape:
//   { status: "error", error: { message, error, metadata } } or
//   { status: "completed", result: { content, output, metadata } }.
function failureTextOf(event) {
  const parts = []
  let budget = FAILURE_TEXT_CHARS
  if (event?.status === "error") {
    const err = recordOf(event.error) ?? {}
    budget = appendText(parts, err.message, budget)
    budget = appendText(parts, err.error, budget)
    budget = appendText(parts, err.metadata, budget)
  } else {
    const result = recordOf(event?.result) ?? {}
    const content = result.content
    if (typeof content === "string") {
      budget = appendText(parts, content, budget)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const rec = recordOf(part)
        if (rec?.type === "text" && typeof rec.text === "string") budget = appendText(parts, rec.text, budget)
        if (budget <= 0) break
      }
    }
    budget = appendText(parts, result.output, budget)
    budget = appendText(parts, result.metadata, budget)
  }
  return parts.join("\n").slice(0, FAILURE_TEXT_CHARS)
}

// Returns "full" | "adc" when the failure looks like expired auth, else null.
function classifyFailure(command, text) {
  if (!command || isAuthLoginCommand(command)) return null
  if (!text || !text.trim()) return null
  if (!AUTH_FAILURE_MARKERS.some((re) => re.test(text))) return null
  const adcMentioned = ADC_MARKERS.some((re) => re.test(text))
  if (!isGcloudRelated(command) && !adcMentioned) return null
  if (adcMentioned && !isGcloudRelated(command)) return "adc"
  return "full"
}

function buildHealCommand(kind, logPath) {
  const target =
    kind === "adc" ? "gcloud auth application-default login" : "gcloud auth login --update-adc"
  return `nohup ${target} >${logPath} 2>&1 &`
}

function shortCommand(command) {
  const oneLine = String(command).split("\n")[0]
  return oneLine.length > COMMAND_MESSAGE_CHARS ? `${oneLine.slice(0, COMMAND_MESSAGE_CHARS)}…` : oneLine
}

function healMessage({ command, kind, healCommand, logPath, alreadyInFlight, elapsedSeconds }) {
  const short = shortCommand(command).replaceAll("`", "'")
  if (alreadyInFlight) {
    return [
      `Gcloud auth healer: \`${short}\` failed with an auth error, but a re-login started ${elapsedSeconds}s ago is still in flight; no new login was spawned.`,
      `Complete the browser prompt (it opens by itself; if it didn't, check ${logPath} for the URL), then poll the failing command until it succeeds and continue.`,
      `Give up and ask the user after ~5 min.`,
    ].join(" ")
  }
  const scope = kind === "adc" ? "ADC-only" : "full (`--update-adc`, also refreshes ADC)"
  return [
    `Gcloud auth healer: \`${short}\` failed with an expired-session/auth error, so a background ${scope} re-login was started (\`${healCommand}\`).`,
    `Complete the browser prompt (it opens by itself; if it didn't, check ${logPath} for the URL), then poll the failing command until it succeeds and continue.`,
    `Give up and ask the user after ~5 min.`,
  ].join(" ")
}

function shellCommandOf(event) {
  if (!SHELL_TOOLS.has(String(event?.tool).toLowerCase())) return null
  const input = recordOf(event?.input)
  if (!input || typeof input.command !== "string" || !input.command.trim()) return null
  return input.command
}

// Native V2 shell results put the numeric exit in output and metadata. A
// completed tool call is not necessarily a failed command: successful diffs
// and searches can quote auth errors. Unknown exits are not failure evidence.
function failedShell(event) {
  const result = recordOf(event?.result)
  const output = recordOf(result?.output)
  const metadata = recordOf(result?.metadata)
  const exits = [output?.exit, metadata?.exit].filter(Number.isFinite)
  if (exits.includes(0)) return false
  if (event?.status === "error") return true
  if (event?.status !== "completed" || output?.status === "running" || metadata?.status === "running") return false
  return exits.some((exit) => exit !== 0)
}

function defaultSpawn(command) {
  const child = spawn("sh", ["-c", command], { stdio: "ignore", detached: true })
  child.unref?.()
}

function createHealer({ config, spawnFn = defaultSpawn, synthetic = async () => {}, clock = Date }) {
  let lastHealAt = null
  let lastKind = null

  async function after(event) {
    const command = shellCommandOf(event)
    if (!command || typeof event?.sessionID !== "string" || !failedShell(event)) return
    const kind = classifyFailure(command, failureTextOf(event))
    if (!kind) return
    const now = clock.now()
    if (lastHealAt !== null && now - lastHealAt < config.cooldownMs) {
      await synthetic({
        sessionID: event.sessionID,
        text: healMessage({
          command,
          kind,
          logPath: config.logPath,
          alreadyInFlight: true,
          elapsedSeconds: Math.round((now - lastHealAt) / 1000),
        }),
        description: "Gcloud auth re-login already in flight",
      })
      return
    }
    const healCommand = buildHealCommand(kind, config.logPath)
    try {
      await spawnFn(healCommand)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error ?? "spawn failed")
      await synthetic({
        sessionID: event.sessionID,
        text: `Gcloud auth healer: \`${shortCommand(command).replaceAll("`", "'")}\` failed with an auth error, but the background re-login could not start (${detail.slice(0, 200)}). Run \`${healCommand}\` yourself, complete the browser prompt, then poll the failing command until it succeeds. Give up and ask the user after ~5 min.`,
        description: "Gcloud auth re-login failed to start",
      })
      return
    }
    lastHealAt = now
    lastKind = kind
    await synthetic({
      sessionID: event.sessionID,
      text: healMessage({ command, kind, healCommand, logPath: config.logPath }),
      description: "Gcloud auth re-login started",
    })
  }

  return { after, get lastHealAt() { return lastHealAt }, get lastKind() { return lastKind } }
}

const testHelpers = {
  DEFAULT_LOG_PATH,
  DEFAULT_COOLDOWN_SECONDS,
  healerConfig,
  isAuthLoginCommand,
  isGcloudRelated,
  failureTextOf,
  classifyFailure,
  buildHealCommand,
  healMessage,
  failedShell,
  createHealer,
}

export const GcloudAuthHealerPlugin = Plugin.define({
  id: "tomas.gcloud-auth-healer",
  async setup(context) {
    const healer = createHealer({
      config: healerConfig(context.options),
      synthetic: (input) => context.session.synthetic(input),
    })
    const registration = await context.tool.hook("execute.after", (event) => healer.after(event))
    return async () => {
      await registration.dispose()
    }
  },
})

GcloudAuthHealerPlugin.__test = () => testHelpers

export default GcloudAuthHealerPlugin
