import type { ConditionRule } from "./model";

export function readJsonPath(value: unknown, path: string): unknown {
  if (!path.startsWith("$.")) return undefined;
  return path
    .slice(2)
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, value);
}

export function evaluateConditionRule(
  rule: ConditionRule,
  source: unknown,
): boolean {
  const actual = readJsonPath(source, rule.path);
  switch (rule.operator) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "==":
      return actual === rule.value;
    case "!=":
      return actual !== rule.value;
    case ">":
    case ">=":
    case "<":
    case "<=": {
      if (typeof actual !== "number" || typeof rule.value !== "number") {
        return false;
      }
      if (rule.operator === ">") return actual > rule.value;
      if (rule.operator === ">=") return actual >= rule.value;
      if (rule.operator === "<") return actual < rule.value;
      return actual <= rule.value;
    }
    case "contains":
      if (typeof actual === "string") {
        return actual.includes(String(rule.value ?? ""));
      }
      if (Array.isArray(actual)) return actual.includes(rule.value);
      return false;
  }
}

export function validateConditionRule(
  rule: ConditionRule | undefined,
): string[] {
  if (!rule) return ["Configure a data-driven condition rule."];
  const errors: string[] = [];
  if (!/^\$\.[A-Za-z0-9_.-]+$/.test(rule.path)) {
    errors.push(
      "Condition path must start with $. and contain field names only.",
    );
  }
  if (!rule.trueBranch.trim() || !rule.falseBranch.trim()) {
    errors.push("Condition rules require true and false branch keys.");
  }
  if (rule.trueBranch === rule.falseBranch) {
    errors.push("True and false branches must be different.");
  }
  if (rule.operator !== "exists" && rule.value === undefined) {
    errors.push("This condition operator requires a comparison value.");
  }
  return errors;
}
