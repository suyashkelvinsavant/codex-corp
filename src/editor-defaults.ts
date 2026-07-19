export const defaultInputSchema = JSON.stringify(
  {
    type: "object",
    properties: {
      workflowInput: { type: "string" },
      upstreamOutputs: { type: "array" },
      revisionFeedback: { type: "array" },
    },
    required: ["workflowInput", "upstreamOutputs"],
  },
  null,
  2,
);
