/**
 * Native runtime adapter — the seam between UI components and the Tauri desktop
 * shell (or browser-only fallback).
 *
 * This makes the hypothetical `isTauri()` seam real: two adapters satisfy the
 * same interface, so components and tests can depend on the adapter instead of
 * calling `invoke()` directly.
 *
 * Migration path: replace `import { invoke } from "@tauri-apps/api/core"` with
 * `import { native } from "./native-adapter"` and call `native.invoke(...)`
 * instead of `invoke(...)`. Replace `isTauri()` checks with `native.isNative`.
 */

import { invoke as tauriInvoke, isTauri as tauriIsTauri } from "@tauri-apps/api/core";

export type NativeAdapter = {
  /** True when running inside the Tauri desktop shell. */
  isNative: boolean;
  /**
   * Invoke a Tauri command. Throws if not in the native shell (fail-closed).
   * Callers should check `isNative` before calling if they have a browser fallback.
   */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
};

class DesktopAdapter implements NativeAdapter {
  readonly isNative = true;

  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return tauriInvoke<T>(cmd, args);
  }
}

class BrowserAdapter implements NativeAdapter {
  readonly isNative = false;

  invoke<T = unknown>(_cmd: string, _args?: Record<string, unknown>): Promise<T> {
    return Promise.reject(
      new Error(
        "Native commands require the desktop app. This browser-only session cannot invoke Tauri commands.",
      ),
    );
  }
}

function detectIsTauri(): boolean {
  if (tauriIsTauri()) return true;
  const g = globalThis as typeof globalThis & {
    isTauri?: boolean;
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return !!(g.isTauri || g.__TAURI_INTERNALS__ || g.__TAURI__);
}

let cachedAdapter: NativeAdapter | null = null;

/**
 * Get the singleton NativeAdapter for the current environment.
 * Desktop shell → DesktopAdapter; browser → BrowserAdapter.
 */
export function getNativeAdapter(): NativeAdapter {
  if (cachedAdapter) return cachedAdapter;
  cachedAdapter = detectIsTauri() ? new DesktopAdapter() : new BrowserAdapter();
  return cachedAdapter;
}

/**
 * Reset the cached adapter (for tests that need to switch environments).
 */
export function resetNativeAdapter(): void {
  cachedAdapter = null;
}

/**
 * Force a specific adapter (for tests).
 */
export function setNativeAdapter(adapter: NativeAdapter): void {
  cachedAdapter = adapter;
}

/** The singleton adapter instance. */
export const native = getNativeAdapter();

/**
 * Convenience function: true when running inside the Tauri desktop shell.
 * Equivalent to `native.isNative` — use this where a boolean check is clearer
 * than a property access, or to replace legacy `isTauri()` imports.
 */
export function isTauri(): boolean {
  return native.isNative;
}
