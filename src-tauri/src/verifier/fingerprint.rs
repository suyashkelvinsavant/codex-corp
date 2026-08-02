//! Attempt/retry fingerprints for plateau detection (III.13) and the run-level
//! failure taxonomy (product-strategy P0.6). The failure class is recorded on
//! node_attempts and run events so retries can be audited per category and
//! recovery can become strategy-aware instead of blindly re-prompting.

use super::types::content_hash_for;

/// Stable fingerprint of material inputs for retry de-duplication.
pub fn attempt_fingerprint(role: &str, mission: &str, extra: &str) -> String {
    content_hash_for(&format!("{role}\n{mission}\n{extra}"))
}

/// Failure categories from product-strategy §5 (failure taxonomy).
///
/// Only those categories map to a strategy-aware recovery. Errors that fit none
/// of them are recorded as `Fatal` (unknown / operator-declined / internal),
/// preserving the legacy "non-transient, non-contract ⇒ stop" behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FailureClass {
    /// Provider timeout / rate limit / connection loss → backoff and retry.
    Transient,
    /// Invalid JSON / schema / missing artifact → focused repair turn.
    Contract,
    /// Test or policy failed → send exact failing evidence to the producer.
    Verification,
    /// Permission / unavailable tool → request authorization or route to a capable node.
    Capability,
    /// Acceptance-criteria conflict or incompleteness → pause for human clarification.
    Specification,
    /// Repeated identical failure with a stable artifact set → change strategy or stop.
    Plateau,
    /// Fallback: no known category matched (operator declined, internal errors).
    Fatal,
}

impl FailureClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            FailureClass::Transient => "transient",
            FailureClass::Contract => "contract",
            FailureClass::Verification => "verification",
            FailureClass::Capability => "capability",
            FailureClass::Specification => "specification",
            FailureClass::Plateau => "plateau",
            FailureClass::Fatal => "fatal",
        }
    }
}

/// Best-effort single-attempt failure classification. Strict phrase matching only
/// (no bare substring drift, see `classify_retry_error` history of false positives).
pub fn classify_failure(message: &str) -> FailureClass {
    let lower = message.to_ascii_lowercase();

    // Contract first: schema/parse errors are unambiguous and deserve a repair turn.
    if lower.contains("failed to parse")
        || lower.contains("parse error")
        || lower.contains("error parsing json")
        || lower.contains("invalid json")
        || lower.contains("json parse")
        || lower.contains("schema validation")
        || lower.contains("output schema")
        || lower.contains("output_schema")
        || lower.contains("deserialize")
        || lower.contains("structured output")
        || lower.contains("invalid response")
        || lower.contains("validation failed")
    {
        return FailureClass::Contract;
    }

    // Transient: provider / network / budget flakiness keeps identical inputs.
    if (lower.contains("wall-clock budget") && lower.contains("exceeded"))
        || (lower.contains("hard-deadline")
            && lower.contains("active budget")
            && lower.contains("exceeded"))
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("rate limit")
        || lower.contains("rate-limit")
        || lower.contains("ratelimit")
        || lower.contains("too many requests")
        || lower.contains("status 429")
        || lower.contains("http 429")
        || lower.contains("error 429")
        || lower.contains("connection reset")
        || lower.contains("connection refused")
        || lower.contains("connection timed")
        || lower.contains("econnreset")
        || lower.contains("econnrefused")
        || lower.contains("broken pipe")
        || lower.contains("temporarily unavailable")
        || lower.contains("network unreachable")
        || lower.contains("network error")
    {
        return FailureClass::Transient;
    }

    // Verification: deterministic checks / policies reported non-zero.
    if lower.contains("verification failed")
        || lower.contains("criterion failed")
        || lower.contains("required completion criterion failed")
        || lower.contains("architecture_policy")
        || lower.contains("exited 1")
        || lower.contains("exited 2")
        || lower.contains("failed (exit code")
        || lower.contains("tests failed")
        || lower.contains("check failed")
    {
        return FailureClass::Verification;
    }

    // Capability: permission / sandbox / authorization boundary.
    if lower.contains("permission denied")
        || lower.contains("access denied")
        || lower.contains("not authorized")
        || lower.contains("authorization required")
        || lower.contains("forbidden")
        || lower.contains("sandbox")
        || lower.contains("workspace write denied")
        || lower.contains("this request is not allowed")
        || lower.contains("write access is not available")
        || lower.contains("approval declined")
    {
        return FailureClass::Capability;
    }

    // Specification: acceptance-criteria ambiguity / incompleteness → pause for human.
    if lower.contains("ambiguous")
        || lower.contains("acceptance criteria")
        || lower.contains("specification")
        || lower.contains("requirements unclear")
        || lower.contains("clarification needed")
        || lower.contains("need clarification")
        || lower.contains("conflicting requirements")
        || lower.contains("definition of done is unclear")
    {
        return FailureClass::Specification;
    }

    FailureClass::Fatal
}

/// True when ≥2 identical fingerprints observed without artifact hash-set change.
pub fn is_plateau(fingerprints: &[String], artifact_hash_sets: &[String]) -> bool {
    if fingerprints.len() < 2 || artifact_hash_sets.len() < 2 {
        return false;
    }
    let n = fingerprints.len();
    let same_fp = fingerprints[n - 1] == fingerprints[n - 2];
    let same_artifacts = artifact_hash_sets[n - 1] == artifact_hash_sets[n - 2];
    same_fp && same_artifacts
}

/// Canonical hash-set key for a list of content hashes.
pub fn artifact_hash_set_key(hashes: &[String]) -> String {
    let mut sorted = hashes.to_vec();
    sorted.sort();
    content_hash_for(&sorted.join("|"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_stable() {
        let a = attempt_fingerprint("Builder", "ship it", "rev0");
        let b = attempt_fingerprint("Builder", "ship it", "rev0");
        let c = attempt_fingerprint("Builder", "ship it", "rev1");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn plateau_stops_retry() {
        let fps = vec!["f1".into(), "f1".into()];
        let arts = vec!["a1".into(), "a1".into()];
        assert!(is_plateau(&fps, &arts));
        assert!(!is_plateau(&["f1".into()], &["a1".into()]));
        assert!(!is_plateau(
            &["f1".into(), "f2".into()],
            &["a1".into(), "a1".into()]
        ));
    }

    #[test]
    fn failure_class_covers_the_full_taxonomy() {
        assert_eq!(
            classify_failure("connection reset by peer"),
            FailureClass::Transient
        );
        assert_eq!(
            classify_failure("request timed out after 120s"),
            FailureClass::Transient
        );
        assert_eq!(
            classify_failure("failed to parse structured output JSON"),
            FailureClass::Contract
        );
        assert_eq!(
            classify_failure("schema validation failed: missing field"),
            FailureClass::Contract
        );
        assert_eq!(
            classify_failure("criterion npm_test exited 1 — missing export"),
            FailureClass::Verification
        );
        assert_eq!(
            classify_failure("architecture_policy checked src/runtime/scheduler.ts"),
            FailureClass::Verification
        );
        assert_eq!(
            classify_failure("workspace write denied: sandbox policy is read-only"),
            FailureClass::Capability
        );
        assert_eq!(
            classify_failure("request not authorized for workspace.write"),
            FailureClass::Capability
        );
        assert_eq!(
            classify_failure(
                "acceptance criteria are ambiguous; clarification needed before implementation"
            ),
            FailureClass::Specification
        );
        assert_eq!(
            classify_failure("operator declined the approval gate"),
            FailureClass::Fatal
        );
        // Guard: unrelated text must not drift onto a specific class.
        assert_eq!(
            classify_failure("returned business json payload ok"),
            FailureClass::Fatal
        );
        assert_eq!(FailureClass::Plateau.as_str(), "plateau");
        assert_eq!(FailureClass::Verification.as_str(), "verification");
    }
}
