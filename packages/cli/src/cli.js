#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dataBase = process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache")

const configDir = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode")
const configPath = path.join(configDir, "opencode.json")
const manifestPath = path.join(dataBase, "IronLaw", "opencode", "install-manifest.json")
const installBase = path.join(dataBase, "IronLaw", "opencode", "versions")
const sourcePluginPath = path.join(root, "src", "plugin.js")
const sourceSidecarPath = path.join(root, "sidecar.js")

const log = text => process.stdout.write(`${text}\n`)
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

// ---- framework detection: `install` with no args covers whatever is installed ----
const FRAMEWORK_COMMANDS = {
  opencode: process.platform === "win32" ? ["opencode.cmd", "opencode"] : ["opencode"],
  claude: process.platform === "win32" ? ["claude.cmd", "claude"] : ["claude"],
  grok: ["grok"],
  codex: ["codex"],
  qoder: process.platform === "win32" ? ["qodercli.cmd", "qodercli"] : ["qodercli"],
  zcode: ["zcode"],
}

function probeFramework(candidates) {
  for (const cmd of candidates) {
    const r = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/c", cmd, "--version"], { encoding: "utf8" })
      : spawnSync(cmd, ["--version"], { encoding: "utf8" })
    if (r.status === 0) return { command: cmd, version: r.stdout.trim().split(/\r?\n/)[0] }
  }
  return null
}

function detectFrameworks() {
  const found = {}
  for (const [name, cmds] of Object.entries(FRAMEWORK_COMMANDS)) {
    const hit = probeFramework(cmds)
    if (hit) found[name] = hit
  }
  return found
}

// adapters that are actually implemented; detected-but-missing ones are reported, not faked
const READY_ADAPTERS = new Set(["opencode"])

function frameworkArg() {
  const i = process.argv.indexOf("--framework")
  return i >= 0 ? process.argv[i + 1] : null
}

// ---- opencode adapter ----
const installedManifest = () => fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null
const pluginPath = () => installedManifest()?.pluginPath || sourcePluginPath
const sidecarPath = () => installedManifest()?.sidecarPath || sourceSidecarPath
const loadConfig = () => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {}
const saveConfig = value => { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`) }

function findNodePath() {
  const candidates = process.platform === "win32"
    ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"), process.execPath]
    : ["/usr/local/bin/node", "/usr/bin/node", process.execPath]
  return candidates.find(candidate => fs.existsSync(candidate)) || process.execPath
}

function installOpencode(version) {
  if (!/^1\.18\./.test(version)) throw new Error(`unsupported opencode version: ${version}`)
  const versionDir = path.join(installBase, "0.1.0")
  fs.mkdirSync(versionDir, { recursive: true })
  fs.cpSync(path.join(root, "src"), path.join(versionDir, "src"), { recursive: true })
  fs.copyFileSync(sourceSidecarPath, path.join(versionDir, "sidecar.js"))
  const stablePluginPath = path.join(versionDir, "src", "plugin.js")
  const stableSidecarPath = path.join(versionDir, "sidecar.js")
  const config = loadConfig()
  const existing = Array.isArray(config.plugin) ? config.plugin : []
  const withoutOld = existing.filter(item => item !== sourcePluginPath && item !== stablePluginPath)
  if (!existing.includes(stablePluginPath) || existing.includes(sourcePluginPath)) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    const backup = `${configPath}.ironlaw-backup-${Date.now()}.json`
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backup)
    config.plugin = [...withoutOld, stablePluginPath]
    saveConfig(config)
    fs.writeFileSync(manifestPath, JSON.stringify({ version: "0.1.0", configPath, pluginPath: stablePluginPath, sidecarPath: stableSidecarPath, nodePath: findNodePath(), previousPlugins: existing, backup, configHash: sha(configPath) }, null, 2))
  }
  log(`opencode ${version} — installed`)
  log("restart opencode to load the plugin")
}

function install() {
  const fw = frameworkArg()
  const found = detectFrameworks()

  if (fw) {
    if (!READY_ADAPTERS.has(fw)) throw new Error(`adapter for "${fw}" is not available yet`)
    if (!found[fw]) throw new Error(`"${fw}" was not detected on this machine`)
    if (fw === "opencode") return installOpencode(found[fw].version)
    return
  }

  if (found.opencode) {
    installOpencode(found.opencode.version)
  } else {
    const seen = Object.keys(found)
    if (seen.length) log(`detected: ${seen.join(", ")} — no adapter ready for these yet`)
    else log("no supported coding framework detected")
  }
}

function uninstall() {
  if (!fs.existsSync(manifestPath)) { log("ironlaw is not installed"); return }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  if (fs.existsSync(manifest.configPath)) {
    const config = JSON.parse(fs.readFileSync(manifest.configPath, "utf8"))
    config.plugin = (Array.isArray(config.plugin) ? config.plugin : []).filter(item => item !== manifest.pluginPath)
    if (config.plugin.length === 0) delete config.plugin
    saveConfig(config)
  }
  fs.unlinkSync(manifestPath)
  log("ironlaw removed; unrelated opencode configuration preserved")
}

function doctor() {
  const info = detectFrameworks().opencode
  const checks = [
    ["opencode detected", Boolean(info)],
    ["opencode 1.18.x", /^1\.18\./.test(info?.version || "")],
    ["plugin file", fs.existsSync(pluginPath())],
    ["sidecar file", fs.existsSync(sidecarPath())],
    ["config registration", loadConfig().plugin?.includes(pluginPath()) === true],
  ]
  for (const [name, pass] of checks) log(`${pass ? "PASS" : "FAIL"} ${name}`)
  if (checks.some(([, pass]) => !pass)) process.exitCode = 1
}

async function probePlugin() {
  process.env.IRONLAW_REQUIRE_SIDECAR = "1"
  const { default: plugin } = await import(`${pathToFileURL(pluginPath()).href}?doctor=${Date.now()}`)
  try {
    const hooks = await plugin({ directory: process.cwd(), client: { session: { promptAsync: async () => {} } } })
    const loaded = Boolean(hooks.event && hooks["chat.message"] && hooks["tool.execute.after"])
    await hooks.dispose?.()
    return loaded
  } finally { delete process.env.IRONLAW_REQUIRE_SIDECAR }
}

function status() {
  const config = loadConfig()
  log(JSON.stringify({ installed: config.plugin?.includes(pluginPath()) === true, pluginPath: pluginPath(), manifestPath }, null, 2))
}

const command = process.argv[2] || "status"
try {
  if (command === "install") install()
  else if (command === "uninstall") uninstall()
  else if (command === "doctor") { doctor(); const probed = await probePlugin(); log(`${probed ? "PASS" : "FAIL"} plugin load and sidecar probe`); if (!probed) process.exitCode = 1 }
  else if (command === "status") status()
  else if (command === "report") log("reports are stored under the IronLaw cache projects directory")
  else throw new Error(`unknown command: ${command}`)
} catch (error) {
  process.stderr.write(`ironlaw: ${error.message}\n`)
  process.exitCode = 1
}
