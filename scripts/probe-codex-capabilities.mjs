import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const codex =
  process.env.CODEX_CORP_CODEX_PATH ||
  (process.platform === "win32"
    ? `${process.env.APPDATA}\\npm\\codex.cmd`
    : "codex");
const cwd = process.cwd();
const child = spawn(
  process.platform === "win32" ? "cmd.exe" : codex,
  process.platform === "win32"
    ? ["/d", "/s", "/c", `"${codex}" app-server --stdio`]
    : ["app-server", "--stdio"],
  {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsVerbatimArguments: process.platform === "win32",
  },
);

const pending = new Map();
const stderr = [];
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});
child.stderr.on("data", (data) => stderr.push(String(data).slice(0, 500)));

function request(method, params, timeoutMs = 20_000) {
  const id = nextId++;
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
  });
}

try {
  await request("initialize", {
    clientInfo: {
      name: "codex-corp-capability-probe",
      title: "Codex Corp Capability Probe",
      version: "0.3.0",
    },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
  );

  const [
    skillsResult,
    mcpResult,
    collaborationResult,
    permissionResult,
    appsResult,
    hooksResult,
    providerResult,
    featuresResult,
  ] = await Promise.all([
    request("skills/list", { cwds: [cwd], forceReload: true }),
    request("mcpServerStatus/list", {
      limit: 100,
      detail: "toolsAndAuthOnly",
    }),
    request("collaborationMode/list", {}),
    request("permissionProfile/list", { cwd, limit: 100 }),
    request("app/list", { limit: 100, forceRefetch: false }),
    request("hooks/list", { cwds: [cwd] }),
    request("modelProvider/capabilities/read", {}),
    request("experimentalFeature/list", { limit: 100 }),
  ]);
  const skillEntries = skillsResult?.data ?? [];
  const servers = mcpResult?.data ?? [];
  const skills = skillEntries.flatMap((entry) =>
    (entry.skills ?? []).map((skill) => ({
      name: skill.name,
      description: skill.shortDescription ?? skill.description,
      enabled: skill.enabled,
      scope: skill.scope,
      path: skill.path,
    })),
  );
  const tools = servers.flatMap((server) =>
    Object.values(server.tools ?? {}).map((tool) => ({
      server: server.name,
      name: tool.name,
      title: tool.title,
      description: tool.description,
    })),
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        codex,
        skills: {
          count: skills.length,
          items: process.env.PROBE_SUMMARY
            ? skills.map(({ name }) => name)
            : skills,
        },
        tools: {
          count: tools.length,
          items: process.env.PROBE_SUMMARY
            ? tools.slice(0, 10).map(({ server, name }) => ({ server, name }))
            : tools,
        },
        skillErrors: skillEntries.flatMap((entry) => entry.errors ?? []),
        servers: servers.map((server) => ({
          name: server.name,
          authStatus: server.authStatus,
          toolCount: Object.keys(server.tools ?? {}).length,
        })),
        collaborationModes: collaborationResult?.data ?? [],
        permissionProfiles: permissionResult?.data ?? [],
        apps: (appsResult?.data ?? []).map((app) => ({
          id: app.id,
          name: app.name,
          accessible: app.isAccessible,
          enabled: app.isEnabled,
          plugins: app.pluginDisplayNames,
        })),
        hooks: (hooksResult?.data ?? []).flatMap((entry) =>
          (entry.hooks ?? []).map((hook) => ({
            key: hook.key,
            eventName: hook.eventName,
            enabled: hook.enabled,
            managed: hook.isManaged,
            trustStatus: hook.trustStatus,
          })),
        ),
        providerCapabilities: providerResult ?? {},
        experimentalFeatures: (featuresResult?.data ?? []).map((feature) => ({
          name: feature.name,
          stage: feature.stage,
          enabled: feature.enabled,
        })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({ ok: false, error: String(error), stderr }, null, 2),
  );
  process.exitCode = 1;
} finally {
  child.kill();
}
