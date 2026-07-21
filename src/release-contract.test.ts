import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargoToml = read("src-tauri/Cargo.toml");
const releaseWorkflow = read(".github/workflows/release.yml");

describe("v0.1 release contract", () => {
  it("rejects version drift across JavaScript, Rust, and Tauri metadata", () => {
    expect(packageJson.version).toBe("0.1.0");
    expect(packageLock.version).toBe("0.1.0");
    expect(packageLock.packages[""].version).toBe("0.1.0");
    expect(tauriConfig.version).toBe("0.1.0");
    expect(cargoToml).toMatch(/^version = "0\.1\.0"$/m);
  });

  it("rejects builds that compile without producing installable bundles", () => {
    expect(tauriConfig.bundle.active).toBe(true);
  });

  it("rejects a release matrix that omits a supported desktop platform", () => {
    expect(releaseWorkflow).toContain("windows-latest");
    expect(releaseWorkflow).toContain("ubuntu-22.04");
    expect(releaseWorkflow).toContain("aarch64-apple-darwin");
    expect(releaseWorkflow).toContain("x86_64-apple-darwin");
  });

  it("rejects standalone installers that can fall back to the Vite dev URL", () => {
    expect(releaseWorkflow).toMatch(/args:.*--features custom-protocol/g);
    expect(releaseWorkflow.match(/--features custom-protocol/g)).toHaveLength(4);
  });

  it("rejects accidental releases from ordinary branch pushes", () => {
    expect(releaseWorkflow).toContain("workflow_dispatch:");
    expect(releaseWorkflow).toMatch(/tags:\s*\n\s*- "v\*"/);
    expect(releaseWorkflow).toContain("releaseDraft: true");
  });
});
