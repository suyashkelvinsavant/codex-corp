export type CodexSkillOption = {
  name: string;
  description: string;
  scope: string;
  enabled: boolean;
};

export type CodexToolOption = {
  id: string;
  server: string;
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
};

export type CodexCapabilityInventory = {
  skills: CodexSkillOption[];
  tools: CodexToolOption[];
  skillErrors: string[];
  collaborationModes: Array<{
    name: string;
    mode: "plan" | "default";
    reasoningEffort?: string;
  }>;
  permissionProfiles: Array<{
    id: string;
    description: string;
    allowed: boolean;
  }>;
  apps: Array<{ id: string; name: string; description: string }>;
  hooks: Array<{
    key: string;
    eventName: string;
    trustStatus: string;
    managed: boolean;
  }>;
  provider: {
    namespaceTools: boolean;
    imageGeneration: boolean;
    webSearch: boolean;
  };
  enabledRuntimeFeatures: string[];
  realtimeConversationAvailable: boolean;
  account: { type: string; email?: string | null; planType?: string | null } | null;
  authMode: string | null;
  requiresOpenaiAuth: boolean;
};

export const EMPTY_CODEX_CAPABILITIES: CodexCapabilityInventory = {
  skills: [],
  tools: [],
  skillErrors: [],
  collaborationModes: [],
  permissionProfiles: [],
  apps: [],
  hooks: [],
  provider: {
    namespaceTools: false,
    imageGeneration: false,
    webSearch: false,
  },
  enabledRuntimeFeatures: [],
  realtimeConversationAvailable: false,
  account: null,
  authMode: null,
  requiresOpenaiAuth: false,
};

export function sanitizeCapabilityInventory(
  value: CodexCapabilityInventory | null | undefined,
): CodexCapabilityInventory {
  const skills = (value?.skills ?? [])
    .filter((skill) => skill.enabled && Boolean(skill.name?.trim()))
    .filter(
      (skill, index, all) =>
        all.findIndex((candidate) => candidate.name === skill.name) === index,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const tools = (value?.tools ?? [])
    .filter((tool) => Boolean(tool.id?.trim()) && Boolean(tool.name?.trim()))
    .filter(
      (tool, index, all) =>
        all.findIndex((candidate) => candidate.id === tool.id) === index,
    )
    .sort(
      (a, b) =>
        a.server.localeCompare(b.server) || a.name.localeCompare(b.name),
    );
  return {
    skills,
    tools,
    skillErrors: value?.skillErrors ?? [],
    collaborationModes: (value?.collaborationModes ?? []).filter(
      (mode) => mode.mode === "default" || mode.mode === "plan",
    ),
    permissionProfiles: (value?.permissionProfiles ?? []).filter(
      (profile) => profile.allowed && Boolean(profile.id),
    ),
    apps: (value?.apps ?? []).filter((app) => Boolean(app.id && app.name)),
    hooks: value?.hooks ?? [],
    provider: value?.provider ?? EMPTY_CODEX_CAPABILITIES.provider,
    enabledRuntimeFeatures: value?.enabledRuntimeFeatures ?? [],
    realtimeConversationAvailable:
      value?.realtimeConversationAvailable === true,
    account: value?.account ?? null,
    authMode: value?.authMode ?? null,
    requiresOpenaiAuth: value?.requiresOpenaiAuth ?? false,
  };
}

export function isRealtimeUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("does not support realtime conversation") ||
    normalized.includes("realtime conversation requires api key auth") ||
    normalized.includes("-32601") ||
    normalized.includes("method not found")
  );
}

const GENERIC_CAPABILITY_WORDS = new Set([
  "agent",
  "node",
  "codex",
  "specialist",
  "return",
  "output",
  "workflow",
  "using",
  "with",
  "from",
  "that",
  "this",
]);

/** Content-based ranking only; it never auto-grants or auto-selects access. */
export function capabilityRelevanceScore(
  context: string,
  capabilityText: string,
): number {
  const haystack = capabilityText.toLowerCase();
  const terms = [
    ...new Set(
      context
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(
          (term) => term.length >= 4 && !GENERIC_CAPABILITY_WORDS.has(term),
        ),
    ),
  ];
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0,
  );
}

export function reconcileCapabilitySelections(
  kind: string,
  selectedSkills: string[] | undefined,
  activeSkill: string | undefined,
  selectedTools: string[] | undefined,
  inventory: CodexCapabilityInventory,
): { skills: string[]; activeSkill?: string; connectorTools: string[] } {
  const availableSkills = new Set(inventory.skills.map((skill) => skill.name));
  const availableTools = new Set(inventory.tools.map((tool) => tool.id));
  let skills = (selectedSkills ?? []).filter((name) =>
    availableSkills.has(name),
  );
  if (
    kind === "creative" &&
    skills.length === 0 &&
    availableSkills.has("imagegen")
  ) {
    skills = ["imagegen"];
  }
  return {
    skills,
    activeSkill:
      activeSkill && skills.includes(activeSkill) ? activeSkill : skills[0],
    connectorTools: (selectedTools ?? []).filter((id) =>
      availableTools.has(id),
    ),
  };
}
