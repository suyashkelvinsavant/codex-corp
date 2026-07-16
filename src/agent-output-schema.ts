import schema from "./shared/agent-output.schema.json";

/** Canonical schema shared with and embedded by the native runtime. */
export const DEFAULT_AGENT_OUTPUT_SCHEMA = schema;

export const defaultOutputSchemaJson = JSON.stringify(
  DEFAULT_AGENT_OUTPUT_SCHEMA,
  null,
  2,
);
