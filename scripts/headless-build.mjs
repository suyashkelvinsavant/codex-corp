import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { embedAndVerifyWindowsManifest } from "./windows-manifest.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = join(root, "src-tauri", "Cargo.toml");
const executable = join(
  root,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "codex-corp-headless.exe" : "codex-corp-headless",
);
const build = spawnSync(
  process.platform === "win32" ? "cargo.exe" : "cargo",
  ["build", "--manifest-path", manifest, "--bin", "codex-corp-headless"],
  { cwd: root, stdio: "inherit", shell: false },
);
if (build.status !== 0) process.exit(build.status ?? 1);
await embedAndVerifyWindowsManifest(
  executable,
  join(root, "src-tauri", "windows-comctl.manifest"),
);
console.log(`Codex Corp headless build: ${executable}`);
