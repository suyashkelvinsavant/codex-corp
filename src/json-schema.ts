import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";

type SchemaValidator = Pick<Ajv, "validateSchema" | "errors" | "errorsText">;

const validators = {
  draft7: new Ajv({ allErrors: true, strict: false }),
  draft2019: new Ajv2019({ allErrors: true, strict: false }),
  draft2020: new Ajv2020({ allErrors: true, strict: false }),
};

function validatorFor(schema: Record<string, unknown>): SchemaValidator {
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
  if (dialect.includes("2020-12")) return validators.draft2020;
  if (dialect.includes("2019-09")) return validators.draft2019;
  return validators.draft7;
}

/** Parse and validate a JSON Schema definition against its declared dialect. */
export function jsonSchemaDefinitionError(raw: string): string | null {
  let schema: unknown;
  try {
    schema = JSON.parse(raw);
  } catch (error) {
    return `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return "schema must be a JSON object";
  }
  const validator = validatorFor(schema as Record<string, unknown>);
  try {
    if (validator.validateSchema(schema)) return null;
    return validator.errorsText(validator.errors, { separator: "; " });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
