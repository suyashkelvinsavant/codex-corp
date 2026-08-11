import { afterEach, describe, expect, it } from "vitest";
import {
  getNativeAdapter,
  resetNativeAdapter,
  setNativeAdapter,
  type NativeAdapter,
} from "./native-adapter";

afterEach(() => {
  resetNativeAdapter();
});

describe("NativeAdapter", () => {
  it("DesktopAdapter reports isNative=true and delegates to Tauri invoke", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const fake: NativeAdapter = {
      isNative: true,
      invoke: async <T = unknown,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push({ cmd, args });
        return "ok" as unknown as T;
      },
    };
    setNativeAdapter(fake);
    const adapter = getNativeAdapter();
    expect(adapter.isNative).toBe(true);
    const result = await adapter.invoke<string>("test_cmd", { foo: 1 });
    expect(result).toBe("ok");
    expect(calls).toEqual([{ cmd: "test_cmd", args: { foo: 1 } }]);
  });

  it("BrowserAdapter reports isNative=false and rejects invoke", async () => {
    const fake: NativeAdapter = {
      isNative: false,
      invoke: async <T = unknown,>(): Promise<T> => {
        throw new Error("not available");
      },
    };
    setNativeAdapter(fake);
    const adapter = getNativeAdapter();
    expect(adapter.isNative).toBe(false);
    await expect(adapter.invoke("any")).rejects.toThrow("not available");
  });

  it("getNativeAdapter returns the same singleton on repeated calls", () => {
    const a1 = getNativeAdapter();
    const a2 = getNativeAdapter();
    expect(a1).toBe(a2);
  });

  it("resetNativeAdapter allows a fresh adapter to be created", () => {
    const a1 = getNativeAdapter();
    resetNativeAdapter();
    const a2 = getNativeAdapter();
    expect(a1).not.toBe(a2);
  });
});
