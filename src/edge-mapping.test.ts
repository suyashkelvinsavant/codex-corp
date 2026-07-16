import { describe, expect, it } from "vitest";
import {
  applyEdgeMapping,
  isActiveMapping,
  mapInboundUpstream,
  projectedToHandoffFields,
  resolveJsonPath,
} from "./edge-mapping";

const sample = {
  status: "success",
  summary: "Built the shell",
  data: {
    modules: ["CaptureShell", "TriageList"],
    revised: true,
  },
  artifacts: [
    { id: "a1", name: "app-shell.tsx", kind: "code" },
    { id: "a2", name: "build-manifest.json", kind: "json" },
  ],
  threadId: "019f-live-builder-thread",
};

describe("edge field mapping", () => {
  it("treats missing or empty mapping as full-payload pass-through", () => {
    expect(isActiveMapping(undefined)).toBe(false);
    expect(isActiveMapping({})).toBe(false);
    expect(applyEdgeMapping(sample, undefined)).toBe(sample);
    expect(applyEdgeMapping(sample, {})).toBe(sample);
  });

  it("resolves simple $. paths including nested keys and array indexes", () => {
    expect(resolveJsonPath(sample, "$.summary")).toBe("Built the shell");
    expect(resolveJsonPath(sample, "$.data.modules")).toEqual([
      "CaptureShell",
      "TriageList",
    ]);
    expect(resolveJsonPath(sample, "$.artifacts[0].name")).toBe("app-shell.tsx");
    expect(resolveJsonPath(sample, "$.data.missing")).toBeUndefined();
    expect(resolveJsonPath(sample, "artifacts")).toBeUndefined();
    expect(resolveJsonPath(sample, "$.artifacts[9].name")).toBeUndefined();
  });

  it("projects only mapped fields and uses null for missing paths", () => {
    const projected = applyEdgeMapping(sample, {
      summary: "$.summary",
      modules: "$.data.modules",
      firstFile: "$.artifacts[0].name",
      absent: "$.data.notThere",
    }) as Record<string, unknown>;

    expect(projected).toEqual({
      summary: "Built the shell",
      modules: ["CaptureShell", "TriageList"],
      firstFile: "app-shell.tsx",
      absent: null,
    });
    expect(projected).not.toHaveProperty("status");
    expect(projected).not.toHaveProperty("threadId");
  });

  it("maps each inbound edge independently and skips missing sources", () => {
    const sources = [
      sample,
      { status: "success", summary: "Research done", data: { signals: 3 } },
      null,
    ];
    const mapped = mapInboundUpstream(
      [
        { mapping: { headline: "$.summary" } },
        {},
        { mapping: { x: "$.summary" } },
      ],
      (index) => sources[index],
    );
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toEqual({ headline: "Built the shell" });
    expect(mapped[1]).toBe(sources[1]);
  });

  it("normalizes full and projected payloads for delivery handoffs", () => {
    expect(projectedToHandoffFields(sample)).toEqual({
      summary: "Built the shell",
      data: { modules: ["CaptureShell", "TriageList"], revised: true },
      artifacts: sample.artifacts,
    });
    expect(
      projectedToHandoffFields({
        summary: "Only headline",
        modules: ["CaptureShell"],
      }),
    ).toEqual({
      summary: "Only headline",
      data: { modules: ["CaptureShell"] },
      artifacts: [],
    });
  });
});
