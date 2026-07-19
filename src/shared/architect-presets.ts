import { Plus, ShieldCheck, Wrench } from "lucide-react";

export const STARTERS = [
  {
    icon: Plus,
    title: "Design a company",
    prompt:
      "Help me design a new company workflow. Start by asking me for the objective, users, inputs, outputs, constraints, approvals, and success criteria.",
  },
  {
    icon: Wrench,
    title: "Diagnose a workflow",
    prompt:
      "List my workflows and help me diagnose the most likely graph, prompt, tool-access, or handoff problems.",
  },
  {
    icon: ShieldCheck,
    title: "Audit access",
    prompt:
      "Audit every specialist for least-privilege tool and skill access. Show proposed changes before applying them.",
  },
];
