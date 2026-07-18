import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_OUTPUT_SCHEMA } from "./agent-output-schema";

/**
 * Live Codex rejects outputSchema objects that omit additionalProperties:false
 * (invalid_json_schema on nested `data`). Guard the shipped default schema.
 */
function assertStrictObjectSchema(node: unknown, path: string): void {
  expect(node, path).toBeTypeOf("object");
  expect(node).not.toBeNull();
  const obj = node as Record<string, unknown>;
  if (obj.type === "object") {
    expect(obj.additionalProperties, `${path}.additionalProperties`).toBe(
      false,
    );
    const props = obj.properties as Record<string, unknown> | undefined;
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        assertStrictObjectSchema(value, `${path}.properties.${key}`);
      }
    }
  }
  if (obj.type === "array") {
    expect(obj.items, `${path}.items`).toBeDefined();
    assertStrictObjectSchema(obj.items, `${path}.items`);
  }
}

describe("DEFAULT_AGENT_OUTPUT_SCHEMA", () => {
  it("is strict enough for Live Codex response_format (nested objects + array items)", () => {
    assertStrictObjectSchema(DEFAULT_AGENT_OUTPUT_SCHEMA, "root");
    const data = (DEFAULT_AGENT_OUTPUT_SCHEMA as { properties: { data: unknown } })
      .properties.data as { additionalProperties: boolean; properties: { payload: unknown } };
    expect(data.additionalProperties).toBe(false);
    expect(data.properties.payload).toEqual({ type: "string" });
  });

  it("requires status, summary, data, artifacts at the root", () => {
    expect(DEFAULT_AGENT_OUTPUT_SCHEMA.required).toEqual([
      "status",
      "summary",
      "data",
      "artifacts",
    ]);
  });

  it("allows claim/evidencePaths on criteria while keeping legacy passed optional", () => {
    const data = (
      DEFAULT_AGENT_OUTPUT_SCHEMA as {
        properties: {
          data: {
            properties: {
              criteria: {
                items: {
                  properties: Record<string, unknown>;
                  required: string[];
                };
              };
            };
          };
        };
      }
    ).properties.data.properties.criteria.items;
    expect(data.properties.claim).toBeDefined();
    expect(data.properties.evidencePaths).toBeDefined();
    expect(data.properties.passed).toBeDefined();
    expect(data.required).toEqual(["id", "evidence"]);
    expect(data.required).not.toContain("passed");
  });
});
