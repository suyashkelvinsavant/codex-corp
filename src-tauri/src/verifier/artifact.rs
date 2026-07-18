//! artifact_exists verifier — host checks materialized artifact refs.

use serde_json::Value;

use super::types::{artifact_name, sanitize_artifact_name};

/// Fail if no artifact matches the expected name/path fragment.
///
/// Match order: exact sanitized name → name/key `ends_with` → `contains` only
/// when the needle is long enough (≥ 4) or when `artifactPath` path-fragment
/// mode was used (reduces false-pass on short needles like `ap` / `ts`).
pub fn artifact_exists_failed(
    expected_name: Option<&str>,
    expected_path: Option<&str>,
    artifacts: &[Value],
) -> bool {
    let path_fragment_mode = expected_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some();
    let needle = expected_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| expected_path.map(str::trim).filter(|s| !s.is_empty()))
        .map(sanitize_artifact_name);

    match needle {
        None => {
            // No name/path configured — require at least one artifact.
            artifacts.is_empty()
        }
        Some(want) => {
            let want_lower = want.to_ascii_lowercase();
            let allow_contains = path_fragment_mode || want_lower.chars().count() >= 4;
            !artifacts.iter().any(|art| {
                let name = sanitize_artifact_name(&artifact_name(art)).to_ascii_lowercase();
                let key = art
                    .get("artifactKey")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if name == want_lower {
                    return true;
                }
                if name.ends_with(&want_lower) || key.ends_with(&want_lower) {
                    return true;
                }
                if allow_contains && (name.contains(&want_lower) || key.contains(&want_lower)) {
                    return true;
                }
                false
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_artifact_fails() {
        assert!(artifact_exists_failed(
            Some("src/app.ts"),
            None,
            &[json!({"name":"README.md","content":"x"})]
        ));
    }

    #[test]
    fn present_artifact_passes() {
        assert!(!artifact_exists_failed(
            Some("src/app.ts"),
            None,
            &[json!({"name":"src/app.ts","content":"export {}","artifactKey":"b::0::src/app.ts"})]
        ));
    }

    #[test]
    fn empty_artifacts_fail_when_no_needle() {
        assert!(artifact_exists_failed(None, None, &[]));
    }

    #[test]
    fn short_needle_does_not_false_pass_via_contains() {
        // "ap" is a substring of "src/app.ts" but not exact/ends_with — must fail.
        assert!(artifact_exists_failed(
            Some("ap"),
            None,
            &[json!({"name":"src/app.ts","content":"x"})]
        ));
    }

    #[test]
    fn ends_with_still_matches_basename() {
        assert!(!artifact_exists_failed(
            Some("app.ts"),
            None,
            &[json!({"name":"src/app.ts","content":"x"})]
        ));
    }

    #[test]
    fn path_fragment_mode_allows_contains() {
        // artifactPath enables path-fragment contains even for short needles that
        // would otherwise be gated (here needle is long enough anyway).
        assert!(!artifact_exists_failed(
            None,
            Some("src/app"),
            &[json!({"name":"src/app.ts","content":"x"})]
        ));
    }

    #[test]
    fn blank_name_falls_back_to_configured_path() {
        assert!(artifact_exists_failed(
            Some(""),
            Some("src/required.ts"),
            &[json!({"name":"notes.md","content":"x"})]
        ));
    }
}
