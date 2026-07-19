import type { MediatorQuestion, MediatorQuestionAnswer } from "./mediator-ui";

export type PendingInteraction =
  | { kind: "userInput"; requestId: string; nodeId: string; params: Record<string, unknown> }
  | { kind: "elicitation"; requestId: string; nodeId: string; params: Record<string, unknown> };

type RawQuestion = {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: { label: string; description?: string }[] | null;
};

export function parseUserInputQuestions(params: Record<string, unknown>): MediatorQuestion[] {
  if (!Array.isArray(params.questions)) throw new Error("requestUserInput questions must be an array");
  return (params.questions as RawQuestion[]).map((question) => {
    if (!question.id || !question.header || !question.question) {
      throw new Error("requestUserInput question is missing required fields");
    }
    return {
      id: question.id,
      title: question.header,
      body: question.question,
      options: question.options?.map((option) => ({
        id: option.label,
        label: option.label,
        description: option.description,
      })),
      allowFreeText: question.isOther || !question.options?.length,
      optionsOnly: Boolean(question.options?.length) && !question.isOther,
      secret: Boolean(question.isSecret),
      source: "specialist-request",
      blocksRun: true,
    };
  });
}

export function buildUserInputResponse(answers: MediatorQuestionAnswer[]) {
  return {
    answers: Object.fromEntries(
      answers.map((answer) => [
        answer.questionId,
        { answers: [...answer.optionIds, ...(answer.freeText ? [answer.freeText] : [])] },
      ]),
    ),
  };
}

export type ElicitationField = { id: string; question: MediatorQuestion; valueType: "string" | "number" | "boolean" };

export function parseElicitationForm(params: Record<string, unknown>): ElicitationField[] {
  const schema = params.requestedSchema as Record<string, unknown> | undefined;
  if (params.mode !== "form" && params.mode !== "openai/form") throw new Error("Unsupported elicitation mode");
  if (!schema || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") {
    throw new Error("Elicitation requires an object schema");
  }
  return Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(([id, field]) => {
    const valueType = field.type;
    if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
      throw new Error(`Unsupported elicitation field type for ${id}`);
    }
    const choices = Array.isArray(field.enum) ? field.enum.map(String) : valueType === "boolean" ? ["true", "false"] : [];
    return {
      id,
      valueType,
      question: {
        id,
        title: String(field.title ?? id),
        body: String(field.description ?? params.message ?? `Enter ${id}`),
        options: choices.map((choice) => ({ id: choice, label: choice })),
        allowFreeText: choices.length === 0,
        optionsOnly: choices.length > 0,
        secret: field.format === "password",
        source: "specialist-request",
        blocksRun: true,
      },
    };
  });
}
