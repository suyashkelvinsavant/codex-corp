import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { embedAndVerifyWindowsManifest } from './windows-manifest.mjs'

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)))
const buildRoot = join(tmpdir(), 'codex-corp-desktop-dev')
const tauriRoot = join(buildRoot, 'src-tauri')
const isWin = process.platform === 'win32'
// Never use shell:true on Windows — each .cmd shim flashes a blue console.
const hide = isWin ? { windowsHide: true } : {}

await mkdir(buildRoot, { recursive: true })
await rm(tauriRoot, { recursive: true, force: true })
await cp(join(workspace, 'src-tauri'), tauriRoot, { recursive: true })
// Keep Rust's embedded shared-schema path valid in the isolated dev workspace.
const sharedSchemaDir = join(buildRoot, 'src', 'shared')
await mkdir(sharedSchemaDir, { recursive: true })
await cp(
  join(workspace, 'src', 'shared', 'agent-output.schema.json'),
  join(sharedSchemaDir, 'agent-output.schema.json'),
)

// Temporary native build reuses the workspace Vite server — do not start a second one.
const configPath = join(tauriRoot, 'tauri.conf.json')
const config = JSON.parse(await readFile(configPath, 'utf8'))
config.build.beforeDevCommand = ''
await writeFile(configPath, JSON.stringify(config, null, 2))

const node = process.execPath
const viteCli = join(workspace, 'node_modules', 'vite', 'bin', 'vite.js')
const cargoCommand = isWin ? 'cargo.exe' : 'cargo'
const targetDir = join(buildRoot, 'target')
const exeName = isWin ? 'codex-corp.exe' : 'codex-corp'
const exePath = join(targetDir, 'debug', exeName)

// The isolated source tree is replaced on each run. Its Cargo target must be
// replaced too, or build-script outputs can point at generated files removed
// with the previous source snapshot (for example libsqlite3-sys bindgen.rs).
await rm(targetDir, { recursive: true, force: true })

try {
  await access(viteCli)
} catch {
  console.error('Vite is not installed. Run npm install first.')
  process.exit(1)
}

// Drive Vite through node.exe directly (no npm.cmd console flash).
const vite = spawn(
  node,
  [viteCli, '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
  { cwd: workspace, stdio: 'inherit', shell: false, ...hide },
)

const stop = () => {
  if (!vite.killed) vite.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

await new Promise((resolveReady) => setTimeout(resolveReady, 1200))

// Build only — never `cargo run` (console host stays glued to the GUI lifetime).
const build = spawn(
  cargoCommand,
  ['build', '--manifest-path', join(tauriRoot, 'Cargo.toml')],
  {
    cwd: tauriRoot,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
    ...hide,
  },
)

build.on('exit', async (code) => {
  if (code !== 0) {
    stop()
    process.exitCode = code ?? 1
    return
  }

  try {
    await embedAndVerifyWindowsManifest(
      exePath,
      join(tauriRoot, 'windows-comctl.manifest'),
    )
  } catch (error) {
    stop()
    console.error(error)
    process.exitCode = 1
    return
  }

  const native = spawn(exePath, [], {
    cwd: tauriRoot,
    stdio: 'ignore',
    shell: false,
    detached: false,
    windowsHide: true,
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  })

  native.on('exit', (nativeCode) => {
    stop()
    process.exitCode = nativeCode ?? 1
  })
  native.on('error', (error) => {
    stop()
    console.error(error)
    process.exitCode = 1
  })
})

build.on('error', (error) => {
  stop()
  console.error(error)
  process.exitCode = 1
})
