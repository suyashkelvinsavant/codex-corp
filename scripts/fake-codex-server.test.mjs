import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("fails closed when the scripted output sequence is exhausted", () => {
  // Attack vector: an unexpected extra specialist attempt must not receive a
  // fabricated success that masks a retry or orchestration defect.
  const root = mkdtempSync(join(tmpdir(), "codex-corp-golden-"));
  try {
    const outputsFile = join(root, "outputs.json");
    const cursorFile = join(root, "cursor");
    writeFileSync(
      outputsFile,
      JSON.stringify([
        {
          status: "success",
          summary: "scripted success",
          data: {},
          artifacts: [],
        },
      ]),
    );
    writeFileSync(cursorFile, "0");

    const input = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "turn/start",
        params: {},
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "turn/start",
        params: {},
      }),
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      [resolve(process.cwd(), "scripts", "fake-codex-server.mjs")],
      {
        input: `${input}\n`,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_CORP_GOLDEN_OUTPUTS_FILE: outputsFile,
          CODEX_CORP_GOLDEN_OUTPUTS_CURSOR: cursorFile,
        },
      },
    );

    const messages = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const deltas = messages.filter(
      (message) => message.method === "item/agentMessage/delta",
    );
    assert.equal(deltas.length, 2);
    assert.equal(JSON.parse(deltas[0].params.delta).status, "success");
    const exhausted = JSON.parse(deltas[1].params.delta);
    assert.equal(exhausted.status, "failure");
    assert.match(exhausted.summary, /exhausted/);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(cursorFile, "utf8"), "2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serializes the shared cursor across concurrent app-server processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-corp-cursor-race-"));
  try {
    const outputsFile = join(root, "outputs.json");
    const cursorFile = join(root, "cursor");
    const outputs = Array.from({ length: 12 }, (_, index) => ({
      status: "success",
      summary: `script-${index}`,
      data: {},
      artifacts: [],
    }));
    writeFileSync(outputsFile, JSON.stringify(outputs));
    writeFileSync(cursorFile, "0");
    const env = {
      ...process.env,
      CODEX_CORP_GOLDEN_OUTPUTS_FILE: outputsFile,
      CODEX_CORP_GOLDEN_OUTPUTS_CURSOR: cursorFile,
    };
    const server = resolve(process.cwd(), "scripts", "fake-codex-server.mjs");
    const run = () =>
      new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [server], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", rejectRun);
        child.once("close", (code) => {
          if (code !== 0) {
            rejectRun(new Error(`fake server exited ${code}: ${stderr}`));
            return;
          }
          resolveRun(
            stdout
              .trim()
              .split(/\r?\n/)
              .map((line) => JSON.parse(line)),
          );
        });
        child.stdin.end(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn/start", params: {} })}\n`,
        );
      });

    const messages = await Promise.all(Array.from({ length: 12 }, run));
    const summaries = messages
      .map((rows) => {
        const delta = rows.find(
          (row) => row.method === "item/agentMessage/delta",
        );
        return JSON.parse(delta.params.delta).summary;
      })
      .sort();
    assert.deepEqual(summaries, outputs.map((output) => output.summary).sort());
    assert.equal(readFileSync(cursorFile, "utf8"), "12");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
