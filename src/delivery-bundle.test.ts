import { describe, expect, it } from "vitest";
import { buildDeliveryBundle } from "./delivery-bundle";

describe("delivery-bundle", () => {
  it("assembles live delivery-bundle.json with mission and safety metadata", () => {
    const delivery = buildDeliveryBundle({
      mission:
        "Build a landing page\n\n## Constraints\n- Single page only",
      generatedAt: "2026-01-01T00:00:00.000Z",
      upstreamOutputs: [
        {
          nodeId: "builder",
          role: "Frontend Engineer",
          label: "Build Agent",
          summary: "Implemented landing page",
          data: { filesWritten: ["src/App.jsx"] },
          artifacts: [
            {
              id: "1",
              name: "App.jsx",
              kind: "code",
              content: "export default function App() {}",
            },
          ],
        },
        {
          nodeId: "reviewer",
          role: "QA + Reviewer",
          label: "Quality Gate",
          summary: "Pass",
          data: { verdict: "pass", revision: 0 },
          artifacts: [],
        },
      ],
    });
    expect(delivery.data.schemaVersion).toBe("codex-corp.delivery.v1");
    expect(delivery.data.mode).toBe("live");
    expect(delivery.data.mission).toContain("Single page only");
    expect(delivery.data.safety.chainOfThought).toBe("not-exposed");
    expect(delivery.artifacts[0]?.name).toBe("delivery-bundle.json");
    expect(delivery.artifacts[0]?.content).toContain("codex-corp.delivery.v1");
  });
});
