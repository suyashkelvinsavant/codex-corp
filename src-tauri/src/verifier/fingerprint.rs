//! Attempt/retry fingerprints for plateau detection (III.13).

use super::types::content_hash_for;

/// Stable fingerprint of material inputs for retry de-duplication.
pub fn attempt_fingerprint(role: &str, mission: &str, extra: &str) -> String {
    content_hash_for(&format!("{role}\n{mission}\n{extra}"))
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
}
