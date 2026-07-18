#!/usr/bin/env node
/**
 * Forward args to the Codex Corp headless binary.
 *
 * Always rebuilds the debug binary by default so local Rust edits are not
 * served from a stale target/. Escape hatches:
 *   CODEX_CORP_HEADLESS_BIN       use this path; skip build
 *   CODEX_CORP_HEADLESS_SKIP_BUILD=1  re-use existing debug/release bin
 *   CODEX_CORP_HEADLESS_RELEASE=1 or --release (anywhere in argv) build/use release bin
 *
 * Note: --release is recognized anywhere in the argument list (not only as a
 * leading flag) and is stripped before forwarding to the binary so the Rust
 * CLI does not see an unknown flag.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embedAndVerifyWindowsManifest } from "./windows-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cargoToml = path.join(root, "src-tauri", "Cargo.toml");
const binName =
  process.platform === "win32" ? "codex-corp-headless.exe" : "codex-corp-headless";
const debugBin = path.join(root, "src-tauri", "target", "debug", binName);
const releaseBin = path.join(root, "src-tauri", "target", "release", binName);

function envTruthy(name) {
  const v = process.env[name];
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function wantsRelease(argv) {
  // Accept --release anywhere in argv (broader than “leading only”).
  if (envTruthy("CODEX_CORP_HEADLESS_RELEASE")) return true;
  return argv.includes("--release");
}

function stripReleaseFlag(argv) {
  return argv.filter((arg) => arg !== "--release");
}

async function ensureBinary(argv) {
  const pinned = process.env.CODEX_CORP_HEADLESS_BIN?.trim();
  if (pinned) {
    if (!existsSync(pinned)) {
      console.error("[headless] CODEX_CORP_HEADLESS_BIN not found:", pinned);
      process.exit(1);
    }
    return { bin: pinned, forwardArgs: stripReleaseFlag(argv) };
  }

  const release = wantsRelease(argv);
  const forwardArgs = stripReleaseFlag(argv);
  const outBin = release ? releaseBin : debugBin;

  if (envTruthy("CODEX_CORP_HEADLESS_SKIP_BUILD")) {
    if (existsSync(outBin)) {
      await embedAndVerifyWindowsManifest(
        outBin,
        path.join(root, "src-tauri", "windows-comctl.manifest"),
      );
      return { bin: outBin, forwardArgs };
    }
    // Fall through to build when skip was requested but bin is missing.
    console.error(
      `[headless] SKIP_BUILD set but binary missing; building ${release ? "release" : "debug"}…`,
    );
  }

  const cargoArgs = [
    "build",
    "--manifest-path",
    cargoToml,
    "--bin",
    "codex-corp-headless",
  ];
  if (release) {
    cargoArgs.push("--release");
  }
  console.error(
    `[headless] Building codex-corp-headless (${release ? "release" : "debug"})…`,
  );
  const build = spawnSync("cargo", cargoArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
  if (!existsSync(outBin)) {
    console.error("[headless] binary missing after build:", outBin);
    process.exit(1);
  }
  await embedAndVerifyWindowsManifest(
    outBin,
    path.join(root, "src-tauri", "windows-comctl.manifest"),
  );
  return { bin: outBin, forwardArgs };
}

const argv = process.argv.slice(2);
const { bin, forwardArgs } = await ensureBinary(argv);
const result = spawnSync(bin, forwardArgs, {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
