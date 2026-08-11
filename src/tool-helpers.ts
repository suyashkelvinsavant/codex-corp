/**
 * Shared types and helpers for mediator/architect tool modules.
 *
 * Extracted from company-mediator-tools.ts so both tool modules share one
 * source of truth for result construction and text truncation.
 */

export type DynamicToolSpecJson = {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolExecResult = { success: boolean; text: string };

export function ok(data: unknown): ToolExecResult {
  return { success: true, text: JSON.stringify(data, null, 2) };
}

export function fail(message: string): ToolExecResult {
  return { success: false, text: JSON.stringify({ error: message }) };
}

export function trunc(s: string, max = 1200): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
