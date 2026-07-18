import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function findManifestTool() {
  const programFiles = process.env["ProgramFiles(x86)"] ?? process.env.ProgramFiles;
  if (!programFiles) return null;
  const kits = join(programFiles, "Windows Kits", "10", "bin");
  const entries = await readdir(kits, { withFileTypes: true }).catch(() => []);
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const version of versions) {
    for (const arch of ["x64", "x86"]) {
      const candidate = join(kits, version, arch, "mt.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function embedAndVerifyWindowsManifest(executable, manifest) {
  if (process.platform !== "win32") return;
  const mt = await findManifestTool();
  if (!mt) throw new Error("mt.exe not found in the Windows 10 SDK");
  const embed = spawnSync(
    mt,
    ["-nologo", "-manifest", manifest, `-outputresource:${executable};#1`],
    { stdio: "inherit", windowsHide: true },
  );
  if (embed.status !== 0) {
    throw new Error(`mt.exe failed to embed the Windows manifest (${embed.status})`);
  }

  const verifyDir = await mkdtemp(join(tmpdir(), "codex-corp-manifest-"));
  const extracted = join(verifyDir, "embedded.manifest");
  try {
    const verify = spawnSync(
      mt,
      ["-nologo", `-inputresource:${executable};#1`, `-out:${extracted}`],
      { stdio: "inherit", windowsHide: true },
    );
    if (verify.status !== 0) {
      throw new Error(`mt.exe could not extract the embedded manifest (${verify.status})`);
    }
    const content = await readFile(extracted, "utf8");
    if (!content.includes("Microsoft.Windows.Common-Controls")) {
      throw new Error("embedded executable manifest lacks Common Controls v6");
    }
  } finally {
    await rm(verifyDir, { recursive: true, force: true });
  }
}
