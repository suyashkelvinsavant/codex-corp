import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (
  Object.prototype.hasOwnProperty.call(process.env, "VITE_CODEX_CORP_AUTORUN")
) {
  console.error(
    "Release build refused: VITE_CODEX_CORP_AUTORUN must be unset.",
  );
  process.exit(2);
}
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const cargoCommand = process.platform === "win32" ? "cargo.exe" : "cargo";
const frontend = spawnSync(npmCommand, ["run", "build"], {
  cwd: workspace,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (frontend.status !== 0) process.exit(frontend.status ?? 1);

const buildRoot = join(tmpdir(), "codex-corp-desktop-release");
const tauriRoot = join(buildRoot, "src-tauri");
const targetDir = join(tmpdir(), "codex-corp-desktop-release-target");
await rm(buildRoot, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });
await cp(join(workspace, "src-tauri"), tauriRoot, { recursive: true });
await cp(join(workspace, "dist"), join(buildRoot, "dist"), { recursive: true });
// Rust embeds the same strict output schema imported by TypeScript. Preserve
// that relative path in the isolated release workspace.
const sharedSchemaDir = join(buildRoot, "src", "shared");
await mkdir(sharedSchemaDir, { recursive: true });
await cp(
  join(workspace, "src", "shared", "agent-output.schema.json"),
  join(sharedSchemaDir, "agent-output.schema.json"),
);

const configPath = join(tauriRoot, "tauri.conf.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
config.build.beforeBuildCommand = "";
await writeFile(configPath, JSON.stringify(config, null, 2));

const native = spawnSync(
  cargoCommand,
  ["build", "--release", "--manifest-path", join(tauriRoot, "Cargo.toml")],
  {
    cwd: tauriRoot,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  },
);
if (native.status !== 0) process.exit(native.status ?? 1);

const executable = join(
  targetDir,
  "release",
  process.platform === "win32" ? "codex-corp.exe" : "codex-corp",
);
const outputDir = join(workspace, "release");
await mkdir(outputDir, { recursive: true });
await cp(
  executable,
  join(
    outputDir,
    process.platform === "win32" ? "Codex-Corp.exe" : "codex-corp",
  ),
);
console.log(
  `Codex Corp desktop build: ${join(outputDir, process.platform === "win32" ? "Codex-Corp.exe" : "codex-corp")}`,
);
