#!/usr/bin/env node
/**
 * Mission-level golden runner (P4).
 *
 * Loads every `evals/golden/*.json`, and for fixtures with `runMode: "mission"`
 * drives `start_run_headless` end-to-end via the headless binary's `golden`
 * subcommand, against a scripted fake Codex app-server, asserting the run's
 * terminal status and the delivery node `data.verification` / `bundleHash`.
 * Classification-only fixtures are reported as skipped (they execute in the
 * Rust `golden_evals` unit test).
 *
 * Needs no GTK / real Codex install. CI usage:
 *   cargo build --manifest-path src-tauri/Cargo.toml --bin codex-corp-headless
 *   CODEX_CORP_HEADLESS_BIN=src-tauri/target/debug/codex-corp-headless node evals/runner.mjs
 * or, locally:
 *   npm run headless:build && npm run golden
 *
 * Exit code 0 only when every mission fixture passes.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goldenDir = join(root, "evals", "golden");
const fakeServer = join(root, "scripts", "fake-codex-server.mjs");
const platformBin =
  process.platform === "win32" ? "codex-corp-headless.exe" : "codex-corp-headless";
const defaultBin = join(root, "src-tauri", "target", "debug", platformBin);

const bin = process.env.CODEX_CORP_HEADLESS_BIN?.trim() || defaultBin;
const fakeServerEnv =
  process.env.CODEX_CORP_GOLDEN_FAKE_SERVER?.trim() || fakeServer;

function jsonRead(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

async function main() {
  // Make the fake server executable on POSIX (shebang dispatch).
  chmodSync(fakeServerEnv, 0o755);

  const fixtures = readdirSync(goldenDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (fixtures.length === 0) {
    console.error(`No golden fixtures found in ${goldenDir}`);
    process.exit(1);
  }

  const rows = [];
  let missions = 0;
  let passed = 0;
  let skipped = 0;
  let failed = 0;

  for (const name of fixtures) {
    const fixturePath = join(goldenDir, name);
    let fixture;
    try {
      fixture = jsonRead(fixturePath);
    } catch (error) {
      rows.push({ id: name, runMode: "error", error: String(error), passed: false });
      failed += 1;
      continue;
    }
    const id = fixture.id || name;
    if (fixture.runMode !== "mission") {
      rows.push({
        id,
        runMode: "skipped",
        reason: "classification-only fixture; covered by Rust golden_evals unit test",
        passed: true,
      });
      skipped += 1;
      continue;
    }
    missions += 1;
    const result = spawnSync(bin, ["golden", fixturePath, fakeServerEnv], {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
    });
    let row;
    if (result.status !== 0) {
      row = {
        id,
        runMode: "mission",
        passed: false,
        error: (result.stderr || result.stdout || "").trim().slice(0, 400) || `exit ${result.status}`,
      };
      failed += 1;
    } else {
      try {
        row = JSON.parse(result.stdout);
        row.passed = row.passed === true;
        if (row.passed) passed += 1;
        else failed += 1;
      } catch (error) {
        row = {
          id,
          runMode: "mission",
          passed: false,
          error: `unparseable result: ${error}: ${result.stdout.slice(0, 200)}`,
        };
        failed += 1;
      }
    }
    rows.push(row);
  }

  printTable(rows);
  const summary = {
    fixtures: fixtures.length,
    missions,
    passed,
    skipped,
    failed,
  };
  console.log("\n## Summary");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    `\n${missions} mission fixture(s): ${passed} passed, ${failed} failed, ${skipped} skipped (classification-only).`,
  );
  if (failed > 0) process.exit(1);
}

function checksCell(row) {
  if (!row.checks) return "—";
  const parts = [
    ["runStatus", row.checks.runStatus],
    ["bundleHash", row.checks.deliveryBundleHash],
    ["verification", row.checks.deliveryVerification],
    ["terminalReason", row.checks.terminalReason],
    ["verificationLoops", row.checks.persistedVerificationAttempts],
  ];
  return parts
    .map(([key, ok]) => `${key}=${ok === true ? "ok" : ok === false ? "bad" : "—"}`)
    .join(" ");
}

function printTable(rows) {
  console.log("| Fixture | Mode | Status | Run status | bundleHash | Verification | Checks |");
  console.log("|---|---|---|---|---|---|---|");
  if (rows.length === 0) {
    console.log("| _none_ | | | | | | |");
    return;
  }
  for (const row of rows) {
    if (row.runMode === "skipped") {
      console.log(`| ${row.id} | skipped | skipped | — | — | — | classification-only |`);
      continue;
    }
    if (row.error) {
      console.log(
        `| ${row.id} | ${row.runMode} | FAIL | — | — | — | ${String(row.error).replaceAll("|", "\\|")} |`,
      );
      continue;
    }
    const bundle = row.delivery?.bundleHash
      ? String(row.delivery.bundleHash).slice(0, 12)
      : "—";
    console.log(
      `| ${row.id} | mission | ${row.passed ? "pass" : "FAIL"} | ${row.runStatus ?? "—"} | ${bundle} | ${row.delivery?.builderPassBitOwner ?? "—"} | ${checksCell(row)} |`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
