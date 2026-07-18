//! Shared completion-criterion kind normalization and host-I/O classification.
//!
//! Used by `workflow_runtime` evaluate path and `lib::validate_graph` so kind
//! aliases stay consistent. Host I/O evaluators live in sibling modules
//! (`command`, `architecture`, `artifact`, `delivery`).
//!
//! ## Ownership boundary
//!
//! | Kind | Owner |
//! |------|--------|
//! | `command`, `architecture_policy`, `artifact_exists`, delivery pair-compare | `verifier/*` |
//! | `structured_json`, `concise_summary`, `no_hidden_reasoning`, `claim` | still runtime-local in `workflow_runtime` (text/JSON checks) |
//!
//! Do **not** add new criterion kinds outside `verifier/`. Prefer moving remaining
//! runtime-local kinds here in a later pass (see HEADLESS.md Architecture debt).

/// Canonical platform / operator kinds the host understands.
#[allow(dead_code)] // SSOT for future graph-validate / catalog surfaces
pub const KNOWN_CRITERION_KINDS: &[&str] = &[
    "structured_json",
    "concise_summary",
    "no_hidden_reasoning",
    "claim",
    "command",
    "artifact_exists",
    "architecture_policy",
];

/// Kinds evaluated only by the host (never invent pass/fail from agent text alone).
#[allow(dead_code)] // SSOT aligned with TS HOST_VERIFIER_KINDS
pub const HOST_VERIFIER_KINDS: &[&str] = &["command", "artifact_exists", "architecture_policy"];

/// Normalize legacy / alias kind names to the canonical form.
///
/// - `custom` → `claim` (legacy self-attestation)
/// - other values returned trimmed as-is
pub fn normalize_kind(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed == "custom" {
        "claim".into()
    } else {
        trimmed.to_string()
    }
}

/// True when evaluating this kind requires an explicit workspace path
/// (never fall back to process CWD).
pub fn kind_requires_workspace(kind: &str) -> bool {
    matches!(
        normalize_kind(kind).as_str(),
        "command" | "architecture_policy"
    )
}

/// True for kinds whose pass/fail is owned by host verifiers (`verification.results`).
#[allow(dead_code)] // used by unit tests + available to runtime/UI bridges
pub fn is_host_verifier_kind(kind: &str) -> bool {
    let normalized = normalize_kind(kind);
    HOST_VERIFIER_KINDS.iter().any(|k| *k == normalized)
}

/// True when `kind` is one of the known platform/operator kinds.
#[allow(dead_code)] // used by unit tests + available to validate_graph extensions
pub fn is_known_kind(kind: &str) -> bool {
    let normalized = normalize_kind(kind);
    KNOWN_CRITERION_KINDS.iter().any(|k| *k == normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_normalizes_to_claim() {
        assert_eq!(normalize_kind("custom"), "claim");
        assert_eq!(normalize_kind("  custom  "), "claim");
        assert_eq!(normalize_kind("command"), "command");
    }

    #[test]
    fn workspace_required_only_for_host_io_fs() {
        assert!(kind_requires_workspace("command"));
        assert!(kind_requires_workspace("architecture_policy"));
        assert!(!kind_requires_workspace("artifact_exists"));
        assert!(!kind_requires_workspace("claim"));
        assert!(!kind_requires_workspace("custom"));
        assert!(!kind_requires_workspace("structured_json"));
    }

    #[test]
    fn host_verifier_kinds() {
        assert!(is_host_verifier_kind("command"));
        assert!(is_host_verifier_kind("artifact_exists"));
        assert!(is_host_verifier_kind("architecture_policy"));
        assert!(!is_host_verifier_kind("claim"));
        assert!(!is_host_verifier_kind("custom"));
    }
}
