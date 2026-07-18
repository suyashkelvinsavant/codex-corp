/**
 * Role-aware Lucide icons for specialist packs and canvas agent nodes.
 * Prefer packId (stable SSOT); fall back to role/label text matching.
 */
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Boxes,
  Bug,
  ClipboardList,
  Code2,
  FileSearch,
  Image,
  LayoutTemplate,
  Package,
  Palette,
  Search,
  Server,
  Shield,
} from "lucide-react";

/** Stable icons keyed by builtin pack id. */
const PACK_ICONS: Record<string, LucideIcon> = {
  "product-manager": ClipboardList,
  researcher: Search,
  architect: Boxes,
  designer: Palette,
  "frontend-engineer": LayoutTemplate,
  "backend-engineer": Server,
  "senior-software-engineer": Code2,
  "qa-engineer": Bug,
  "security-reviewer": Shield,
  "code-reviewer": FileSearch,
  "delivery-agent": Package,
  creative: Image,
  "empty-agent": Bot,
};

/** Loose role/label phrases → pack id (first match wins). */
const ROLE_HINTS: Array<{ re: RegExp; packId: string }> = [
  { re: /product\s*manager|pm\b/i, packId: "product-manager" },
  { re: /research/i, packId: "researcher" },
  { re: /architect|systems?\s*architect/i, packId: "architect" },
  { re: /design|ux|ui\s*design/i, packId: "designer" },
  { re: /front[\s-]?end|react|client/i, packId: "frontend-engineer" },
  { re: /back[\s-]?end|api|server/i, packId: "backend-engineer" },
  {
    re: /senior\s*software|full[\s-]?stack|implementer/i,
    packId: "senior-software-engineer",
  },
  { re: /\bqa\b|quality\s*assurance|test/i, packId: "qa-engineer" },
  { re: /security|threat/i, packId: "security-reviewer" },
  { re: /code\s*review|reviewer/i, packId: "code-reviewer" },
  { re: /deliver|release|handoff|ship/i, packId: "delivery-agent" },
  { re: /creative|studio|visual|image/i, packId: "creative" },
];

export type RoleIconLookup = {
  packId?: string | null;
  role?: string | null;
  label?: string | null;
  kind?: string | null;
};

/**
 * Resolve the Lucide icon for a specialist role / pack.
 * Kind `"creative"` always uses the creative icon when no pack match exists.
 */
export function iconForSpecialistRole(lookup: RoleIconLookup): LucideIcon {
  const packId = lookup.packId?.trim();
  if (packId && PACK_ICONS[packId]) return PACK_ICONS[packId];

  const text = `${lookup.role ?? ""} ${lookup.label ?? ""}`.trim();
  if (text) {
    for (const hint of ROLE_HINTS) {
      if (hint.re.test(text)) return PACK_ICONS[hint.packId] ?? Bot;
    }
  }

  if (lookup.kind === "creative") return Image;
  return Bot;
}

/** Icon for a catalog pack entry (library / role picker). */
export function iconForPack(pack: {
  id: string;
  kind?: string;
  role?: string;
  label?: string;
}): LucideIcon {
  return iconForSpecialistRole({
    packId: pack.id,
    kind: pack.kind,
    role: pack.role,
    label: pack.label,
  });
}
