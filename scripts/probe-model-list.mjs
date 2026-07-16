import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const codex = process.env.CODEX_CORP_CODEX_PATH
  || (process.platform === "win32"
    ? `${process.env.APPDATA}\\npm\\codex.cmd`
    : "codex");

const child = spawn(
  process.platform === "win32" ? "cmd.exe" : codex,
  process.platform === "win32"
    ? ["/d", "/s", "/c", `"${codex}" app-server --stdio`]
    : ["app-server", "--stdio"],
  {
    stdio: ["pipe", "pipe", "pipe"],
    windowsVerbatimArguments: process.platform === "win32",
  },
);

const rl = createInterface({ input: child.stdout });
const pending = new Map();
const extras = [];

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function waitFor(id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for id=${id}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
  });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    extras.push({ bad: line.slice(0, 200) });
    return;
  }
  const id = msg.id;
  if (id != null && pending.has(Number(id))) {
    pending.get(Number(id))(msg);
    pending.delete(Number(id));
    return;
  }
  if (msg.method) extras.push({ method: msg.method });
});

child.stderr.on("data", (d) => {
  extras.push({ stderr: String(d).slice(0, 300) });
});

try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "codex-corp-probe",
        title: "Codex Corp Probe",
        version: "0.3.0",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    },
  });
  const init = await waitFor(1);
  if (init.error) throw new Error(JSON.stringify(init.error));
  send({ jsonrpc: "2.0", method: "initialized", params: {} });

  const all = [];
  let cursor = null;
  let reqId = 2;
  for (let page = 0; page < 10; page++) {
    const params = { limit: 100, includeHidden: true };
    if (cursor) params.cursor = cursor;
    send({
      jsonrpc: "2.0",
      id: reqId,
      method: "model/list",
      params,
    });
    const res = await waitFor(reqId);
    if (res.error) throw new Error(JSON.stringify(res.error));
    const result = res.result ?? {};
    const data = result.data ?? result.models ?? [];
    all.push(...data);
    cursor = result.nextCursor ?? result.next_cursor ?? null;
    if (!cursor) break;
    reqId += 1;
  }

  const summary = all.map((m) => ({
    id: m.id ?? m.model,
    model: m.model,
    displayName: m.displayName ?? m.display_name,
    hidden: m.hidden,
    isDefault: m.isDefault ?? m.is_default,
  }));

  console.log(
    JSON.stringify(
      {
        codex,
        count: summary.length,
        models: summary,
        sampleRaw: all[0] ?? null,
        extras: extras.slice(0, 10),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(error),
        extras,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}
