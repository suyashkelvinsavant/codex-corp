import { describe, expect, it } from "vitest";
import { ok, fail, trunc, type ToolExecResult } from "./tool-helpers";

describe("tool-helpers", () => {
  it("ok wraps data as success with JSON text", () => {
    const result = ok({ foo: 1 });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ foo: 1 });
  });

  it("ok serializes with 2-space indentation", () => {
    const result = ok({ a: 1 });
    expect(result.text).toContain('\n  "a"');
  });

  it("fail wraps message as failure with error object", () => {
    const result = fail("something broke");
    expect(result.success).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ error: "something broke" });
  });

  it("trunc returns short strings unchanged", () => {
    expect(trunc("hello", 100)).toBe("hello");
  });

  it("trunc cuts at max length and adds ellipsis", () => {
    const input = "a".repeat(200);
    const result = trunc(input, 50);
    expect(result.length).toBe(51); // 50 chars + ellipsis
    expect(result.endsWith("…")).toBe(true);
    expect(result.slice(0, 50)).toBe("a".repeat(50));
  });

  it("trunc uses default max of 1200", () => {
    const input = "x".repeat(1500);
    const result = trunc(input);
    expect(result.length).toBe(1201);
    expect(result.endsWith("…")).toBe(true);
  });

  it("trunc returns string unchanged when exactly at max", () => {
    expect(trunc("hello", 5)).toBe("hello");
  });

  it("ToolExecResult type is { success: boolean; text: string }", () => {
    const r: ToolExecResult = { success: true, text: "{}" };
    expect(r.success).toBe(true);
    expect(r.text).toBe("{}");
  });
});
