#!/usr/bin/env node
/**
 * Scripted Codex app-server for the mission-level golden runner (P4).
 *
 * Speaks enough of the live Codex app-server protocol (JSON-RPC over stdio)
 * for `execute_agent_internal` to complete a specialist turn deterministically:
 *
 *   initialize (id)     → respond with capabilities
 *   initialized (notif) → ignored
 *   thread/start|resume → respond with { thread: { id } }
 *   turn/start (id)     → respond with { turn: { id } }, then emit the next
 *                         scripted structured output as item/agentMessage/delta
 *                         and close the turn with turn/completed
 *   unknown id request  → respond with an empty result (never stall the host)
 *
 * Scripted outputs come from CODEX_CORP_GOLDEN_OUTPUTS_FILE (a JSON array).
 * Because each specialist turn spawns a fresh app-server process, per-attempt
 * outputs are served through a shared on-disk cursor
 * (CODEX_CORP_GOLDEN_OUTPUTS_CURSOR): the process advances the cursor under an
 * exclusive lock on every turn/start so a mission with N attempts consumes
 * outputs[0..N] deterministically regardless of process lifetime. When no
 * cursor is set the server keeps the legacy in-process cursor (single-process
 * runs only). When the array is exhausted the server returns an explicit
 * failure and exits non-zero; it never fabricates a success.
 *
 * Usage: fake-codex-server.mjs app-server --stdio
 * (arguments are accepted and ignored so it can stand in for the real CLI.)
 */

import {
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";

const outputsFile = process.env.CODEX_CORP_GOLDEN_OUTPUTS_FILE;
let scripted = [];
if (outputsFile) {
  try {
    const parsed = JSON.parse(readFileSync(outputsFile, "utf8"));
    if (Array.isArray(parsed)) scripted = parsed;
  } catch {
    scripted = [];
  }
}

const cursorFile = process.env.CODEX_CORP_GOLDEN_OUTPUTS_CURSOR;
let turnIndex = 0;
if (cursorFile) {
  try {
    turnIndex = Number(readFileSync(cursorFile, "utf8")) || 0;
  } catch {
    turnIndex = 0;
  }
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireCursorLock() {
  const lockPath = `${cursorFile}.lock`;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return { fd: openSync(lockPath, "wx"), lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      sleepMs(2);
    }
  }
  throw new Error(`timed out acquiring golden output cursor lock ${lockPath}`);
}

function consumeNextIndex() {
  if (!cursorFile) {
    const current = turnIndex;
    turnIndex += 1;
    return current;
  }

  const { fd, lockPath } = acquireCursorLock();
  try {
    let current = 0;
    try {
      const parsed = Number.parseInt(
        readFileSync(cursorFile, "utf8").trim(),
        10,
      );
      if (Number.isSafeInteger(parsed) && parsed >= 0) current = parsed;
    } catch {
      // A missing cursor starts the sequence at zero while holding the lock.
    }
    writeFileSync(cursorFile, String(current + 1));
    turnIndex = current + 1;
    return current;
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

function respond(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function failureOutput(summary, code, turnIndexValue) {
  return {
    status: "failure",
    summary,
    data: { error: code, turnIndex: turnIndexValue },
    artifacts: [],
  };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const method = message.method || "";
  const id = message.id;

  if (method === "initialize") {
    if (id !== undefined) {
      respond({ jsonrpc: "2.0", id, result: { capabilities: {} } });
    }
    return;
  }
  if (method === "initialized") {
    // Notification — no response expected.
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    if (id !== undefined) {
      respond({
        jsonrpc: "2.0",
        id,
        result: { thread: { id: "golden-thread" } },
      });
    }
    return;
  }
  if (method === "turn/start") {
    if (id !== undefined) {
      respond({
        jsonrpc: "2.0",
        id,
        result: { turn: { id: "golden-turn" } },
      });
    }
    let index;
    try {
      index = consumeNextIndex();
    } catch (error) {
      const output = failureOutput(
        `golden output cursor failed: ${error instanceof Error ? error.message : String(error)}`,
        "golden_output_cursor_failed",
        null,
      );
      respond({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { delta: JSON.stringify(output) },
      });
      respond({ jsonrpc: "2.0", method: "turn/completed", params: {} });
      process.exitCode = 2;
      return;
    }
    const output = scripted[index];
    if (output === undefined) {
      const exhausted = failureOutput(
        `golden scripted output exhausted at turn ${index}`,
        "golden_script_exhausted",
        index,
      );
      respond({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { delta: JSON.stringify(exhausted) },
      });
      respond({ jsonrpc: "2.0", method: "turn/completed", params: {} });
      process.exitCode = 2;
      return;
    }
    // Full structured output as the single delta; the host parses `message`.
    respond({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: JSON.stringify(output) },
    });
    respond({ jsonrpc: "2.0", method: "turn/completed", params: {} });
    return;
  }
  if (id !== undefined) {
    // Unknown request — never let the host stall.
    respond({ jsonrpc: "2.0", id, result: {} });
  }
});
