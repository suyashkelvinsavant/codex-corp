import { describe, expect, it } from "vitest";
import {
  appendCompletionCriteriaToPrompt,
  criteriaEvalSummary,
  defaultPlatformCriteria,
  ensureCompletionCriteria,
  evaluateCompletionCriteria,
  HOST_VERIFIER_KINDS,
  isHostVerifierKind,
  makeCustomCriterion,
  verificationResultsFromOutput,
} from "./completion-criteria";

describe("completion-criteria", () => {
  it("seeds platform criteria and merges custom", () => {
    const custom = makeCustomCriterion("Ship only SPA");
    const merged = ensureCompletionCriteria([
      { ...defaultPlatformCriteria()[0], enabled: false },
      custom,
    ]);
    expect(merged.find((c) => c.id === "structured_json")?.enabled).toBe(true);
    expect(merged.find((c) => c.id === "structured_json")?.enforcement).toBe(
      "required",
    );
    expect(merged.some((c) => c.id === custom.id)).toBe(true);
    expect(merged.filter((c) => c.platform)).toHaveLength(3);
  });

  it("defaults claim criteria to advisory (never required pass bits)", () => {
    const claim = makeCustomCriterion("Include screenshots");
    expect(claim.kind).toBe("claim");
    expect(claim.enforcement).toBe("advisory");
    const merged = ensureCompletionCriteria([
      { ...claim, enforcement: "required" },
    ]);
    // Required claim is forced to advisory on merge.
    expect(merged.find((item) => item.id === claim.id)?.enforcement).toBe(
      "advisory",
    );
  });

  it("appends enabled criteria to system prompt", () => {
    const prompt = appendCompletionCriteriaToPrompt("You are Builder.", [
      ...defaultPlatformCriteria(),
      { ...makeCustomCriterion("Use teal accent"), enabled: true },
    ]);
    expect(prompt).toMatch(/You are Builder/);
    expect(prompt).toMatch(/Completion criteria/);
    expect(prompt).toMatch(/structured JSON/i);
    expect(prompt).toMatch(/Use teal accent/);
  });

  it("evaluates platform criteria against real result shapes", () => {
    const good = evaluateCompletionCriteria(undefined, {
      status: "success",
      summary: "Implemented the landing page hero and CTA.",
      data: { filesWritten: ["src/App.jsx"] },
    });
    expect(good.every((e) => e.status === "pass")).toBe(true);
    expect(criteriaEvalSummary(good).passed).toBe(3);

    const bad = evaluateCompletionCriteria(undefined, {
      status: "",
      summary: "",
    });
    expect(bad.find((e) => e.id === "structured_json")?.status).toBe("fail");
    expect(bad.find((e) => e.id === "concise_summary")?.status).toBe("fail");

    const leak = evaluateCompletionCriteria(undefined, {
      status: "success",
      summary: "chain-of-thought: step 1 then step 2 done.",
      data: {},
    });
    expect(leak.find((e) => e.id === "no_hidden_reasoning")?.status).toBe(
      "fail",
    );
  });

  it.each([
    {
      name: "allows a criterion self-report that denies exposing private reasoning",
      summary: "Completed the architecture handoff successfully.",
      data: {
        criteria: [
          {
            id: "privacy",
            evidence: "No hidden reasoning was exposed in the response.",
          },
        ],
      },
      expected: "pass",
    },
    {
      name: "rejects an explicit reasoning_content field",
      summary: "Completed the architecture handoff successfully.",
      data: {
        reasoning_content: "First I considered the private alternatives.",
      },
      expected: "fail",
    },
    {
      name: "rejects a nested scratchpad field",
      summary: "Completed the architecture handoff successfully.",
      data: { payload: { debug: { scratchpad: "private working" } } },
      expected: "fail",
    },
    {
      name: "rejects a labeled chain-of-thought section",
      summary: "Chain of Thought:\nFirst I compared all private alternatives.",
      data: {},
      expected: "fail",
    },
    {
      name: "rejects a private-reasoning field smuggled through JSON text",
      summary: "Completed the architecture handoff successfully.",
      data: { payload: '{"internal_monologue":"private working"}' },
      expected: "fail",
    },
  ])("$name", ({ summary, data, expected }) => {
    const evaluated = evaluateCompletionCriteria(undefined, {
      status: "success",
      summary,
      data,
    });
    expect(
      evaluated.find((item) => item.id === "no_hidden_reasoning")?.status,
    ).toBe(expected);
  });

  it("marks pending when no result yet", () => {
    const pending = evaluateCompletionCriteria(defaultPlatformCriteria(), null);
    expect(pending.every((e) => e.status === "pending")).toBe(true);
  });

  it("defers to runtime verification results when present", () => {
    const custom = makeCustomCriterion("Screenshots");
    const fromRuntime = evaluateCompletionCriteria(
      [custom],
      {
        status: "success",
        summary: "Local would fail without evidence",
        data: { criteria: [] },
      },
      [
        {
          id: custom.id,
          label: custom.label,
          passed: true,
          enforcement: "advisory",
          detail: "Runtime ok",
        },
      ],
    );
    expect(fromRuntime.find((e) => e.id === custom.id)?.status).toBe("pass");
    expect(fromRuntime.find((e) => e.id === custom.id)?.detail).toBe(
      "Runtime ok",
    );
  });

  it("extracts verification.results from structured output and prefers them", () => {
    const cmd = {
      id: "cmd-1",
      label: "npm test",
      kind: "command" as const,
      enabled: true,
      enforcement: "required" as const,
      templateId: "npm_test",
    };
    const structured = {
      verification: {
        results: [
          {
            id: "cmd-1",
            label: "npm test",
            passed: false,
            enforcement: "required",
            detail: "npm_test exited 1 — failing suite",
            method: "command:npm_test",
            source: "runtime",
          },
        ],
        requiredFailed: ["cmd-1"],
        passBitOwner: "runtime",
      },
    };
    const rows = verificationResultsFromOutput(structured);
    expect(rows).toHaveLength(1);
    expect(rows![0].detail).toBe("npm_test exited 1 — failing suite");
    expect(rows![0].method).toBe("command:npm_test");
    const evals = evaluateCompletionCriteria(
      [cmd],
      {
        status: "success",
        summary: "I pinky swear tests pass",
        data: structured,
      },
      rows,
    );
    expect(evals.find((e) => e.id === "cmd-1")?.status).toBe("fail");
    expect(evals.find((e) => e.id === "cmd-1")?.detail).toMatch(/exited 1/);
    expect(evals.find((e) => e.id === "cmd-1")?.detail).toMatch(
      /method=command:npm_test/,
    );
  });

  it("preserves host verifier kinds through ensureCompletionCriteria", () => {
    const command = {
      id: "cmd-1",
      label: "Build",
      kind: "command" as const,
      enabled: true,
      enforcement: "required" as const,
      templateId: "npm_run_build",
    };
    const artifact = {
      id: "art-1",
      label: "Ship bundle",
      kind: "artifact_exists" as const,
      enabled: true,
      enforcement: "required" as const,
      artifactName: "delivery-bundle.json",
    };
    const arch = {
      id: "arch-1",
      label: "Native runtime",
      kind: "architecture_policy" as const,
      enabled: true,
      enforcement: "required" as const,
      policyId: "native_runtime_ownership_v1",
    };
    const merged = ensureCompletionCriteria([command, artifact, arch]);
    expect(merged.find((c) => c.id === "cmd-1")?.kind).toBe("command");
    expect(merged.find((c) => c.id === "cmd-1")?.templateId).toBe(
      "npm_run_build",
    );
    expect(merged.find((c) => c.id === "cmd-1")?.enforcement).toBe("required");
    expect(merged.find((c) => c.id === "art-1")?.kind).toBe("artifact_exists");
    expect(merged.find((c) => c.id === "art-1")?.artifactName).toBe(
      "delivery-bundle.json",
    );
    expect(merged.find((c) => c.id === "arch-1")?.kind).toBe(
      "architecture_policy",
    );
    expect(merged.find((c) => c.id === "arch-1")?.policyId).toBe(
      "native_runtime_ownership_v1",
    );
  });

  it("never invents pass/fail for host kinds without verification.results", () => {
    for (const kind of HOST_VERIFIER_KINDS) {
      expect(isHostVerifierKind(kind)).toBe(true);
    }
    expect(isHostVerifierKind("claim")).toBe(false);
    expect(isHostVerifierKind("structured_json")).toBe(false);

    const hostCriteria = [
      {
        id: "cmd-1",
        label: "npm test",
        kind: "command" as const,
        enabled: true,
        enforcement: "required" as const,
        templateId: "npm_test",
      },
      {
        id: "art-1",
        label: "Bundle",
        kind: "artifact_exists" as const,
        enabled: true,
        enforcement: "required" as const,
        artifactName: "out.zip",
      },
      {
        id: "arch-1",
        label: "Arch",
        kind: "architecture_policy" as const,
        enabled: true,
        enforcement: "required" as const,
        policyId: "native_runtime_ownership_v1",
      },
    ];
    // Optimistic agent text must not flip host kinds to pass.
    const optimistic = evaluateCompletionCriteria(hostCriteria, {
      status: "success",
      summary: "All tests passed and artifacts are ready.",
      data: {
        criteria: [
          { id: "cmd-1", passed: true, evidence: "tests green" },
          { id: "art-1", passed: true },
          { id: "arch-1", passed: true },
        ],
      },
    });
    for (const id of ["cmd-1", "art-1", "arch-1"]) {
      const row = optimistic.find((e) => e.id === id);
      expect(row?.status).toBe("pending");
      expect(row?.detail).toMatch(/pending|Host-owned/i);
    }
    // requiredCriteriaFailed must not treat pending host rows as fail.
    expect(
      optimistic.some(
        (e) => e.enforcement === "required" && e.status === "fail",
      ),
    ).toBe(false);
  });

  it("demotes required claim to advisory at merge (TS SSOT; Rust owns runtime fail-closed)", () => {
    // Product invariant: claim never owns the required pass bit.
    // TS side enforces this by demoting required → advisory in
    // ensureCompletionCriteria. Runtime (Rust evaluate_claim_criterion)
    // additionally fail-closes if required somehow reaches evaluate
    // (see evals/golden/self-attestation-blocked.json + required_claim_always_fails).
    const claim = {
      id: "c1",
      label: "Self attest",
      kind: "claim" as const,
      enabled: true,
      enforcement: "advisory" as const,
    };
    const forced = ensureCompletionCriteria([
      { ...claim, enforcement: "required" },
    ]);
    expect(forced.find((c) => c.id === "c1")?.enforcement).toBe("advisory");
    const evidenced = evaluateCompletionCriteria(
      [{ ...claim, enforcement: "required" }],
      {
        status: "success",
        summary: "Done",
        data: {
          criteria: [{ id: "c1", passed: true, evidence: "I pinky swear" }],
        },
      },
    );
    // After merge, claim is advisory — may pass with evidence, but never
    // as a required gate (enforcement forced to advisory).
    expect(evidenced.find((e) => e.id === "c1")?.enforcement).toBe("advisory");
  });

  it("uses claim evidence text and ignores producer passed:true for required", () => {
    const custom = makeCustomCriterion("Include screenshots");
    const missing = evaluateCompletionCriteria([custom], {
      status: "success",
      summary: "Completed the requested visual verification.",
      data: { criteria: [] },
    });
    expect(missing.find((item) => item.id === custom.id)?.status).toBe("fail");
    const evidenced = evaluateCompletionCriteria([custom], {
      status: "success",
      summary: "Completed the requested visual verification.",
      data: {
        criteria: [
          {
            id: custom.id,
            passed: true,
            evidence: "Two screenshots attached",
          },
        ],
      },
    });
    expect(evidenced.find((item) => item.id === custom.id)?.status).toBe(
      "pass",
    );
    // ensureCompletionCriteria forces claim to advisory (required claim invalid).
    const forced = ensureCompletionCriteria([
      { ...custom, enforcement: "required" },
    ]);
    expect(forced.find((item) => item.id === custom.id)?.enforcement).toBe(
      "advisory",
    );
    // Producer passed:true alone (no evidence text) does not pass.
    const barePass = evaluateCompletionCriteria([custom], {
      status: "success",
      summary: "Done.",
      data: { criteria: [{ id: custom.id, passed: true }] },
    });
    expect(barePass.find((item) => item.id === custom.id)?.status).toBe("fail");
    // Explicit negative claim enum fails even with evidence text.
    const notSatisfied = evaluateCompletionCriteria([custom], {
      status: "success",
      summary: "Completed the requested visual verification.",
      data: {
        criteria: [
          {
            id: custom.id,
            claim: "not_satisfied",
            evidence: "Still missing screenshots",
          },
        ],
      },
    });
    expect(notSatisfied.find((item) => item.id === custom.id)?.status).toBe(
      "fail",
    );
    const satisfied = evaluateCompletionCriteria([custom], {
      status: "success",
      summary: "Completed the requested visual verification.",
      data: {
        criteria: [
          {
            id: custom.id,
            claim: "satisfied",
            evidence: "Two screenshots attached",
          },
        ],
      },
    });
    expect(satisfied.find((item) => item.id === custom.id)?.status).toBe(
      "pass",
    );
  });
});
