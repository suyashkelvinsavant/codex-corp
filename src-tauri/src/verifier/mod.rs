//! Runtime-owned verification: host artifact keys, hashes, delivery pair-compare,
//! command allowlist, artifact existence, architecture policy.
//! Pass bit ownership lives here — never producer `passed: true` for required gates.
//!
//! Kind normalization lives in `criteria`. Host I/O evaluate helpers live in
//! sibling modules. Text/JSON criteria (`structured_json`, `concise_summary`,
//! `no_hidden_reasoning`, `claim`) remain runtime-local for now.

pub mod architecture;
pub mod artifact;
pub mod command;
pub mod criteria;
pub mod delivery;
pub mod fingerprint;
pub mod types;

pub use architecture::architecture_policy_failed;
pub use artifact::artifact_exists_failed;
pub use command::{command_failed, is_allowed_template, ProcessCommandRunner};
pub use criteria::{kind_requires_workspace, normalize_kind};
// Additional SSOT surface (host-kind classification) — import via `verifier::criteria`.
#[allow(unused_imports)]
pub use criteria::{
    is_host_verifier_kind, is_known_kind, HOST_VERIFIER_KINDS, KNOWN_CRITERION_KINDS,
};
pub use delivery::{
    collect_upstream_artifacts, delivery_pair_compare, freeze_approval_snapshot,
    materialize_artifacts,
};
pub use fingerprint::{
    artifact_hash_set_key, attempt_fingerprint, classify_failure, is_plateau, FailureClass,
};
// ArtifactRef is part of the public verifier surface (tests + future callers).
#[allow(unused_imports)]
pub use types::{ApprovedArtifact, ArtifactRef, DeliveryCompareResult};

#[cfg(test)]
mod golden_evals {
    use super::*;
    use serde_json::Value;
    use std::collections::BTreeMap;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;

    fn fixtures() -> BTreeMap<String, Value> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("evals/golden");
        let mut out = BTreeMap::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let value: Value =
                serde_json::from_str(&std::fs::read_to_string(entry.path()).unwrap()).unwrap();
            out.insert(value["id"].as_str().unwrap().to_string(), value);
        }
        out
    }

    #[test]
    fn golden_fixtures_execute_against_host_verifiers() {
        let all = fixtures();
        assert_eq!(
            all.len(),
            18,
            "every golden JSON fixture must be executable"
        );

        let claim = &all["self-attestation-blocked"];
        assert_eq!(
            normalize_kind(claim["criterion"]["kind"].as_str().unwrap()),
            "claim"
        );
        assert_eq!(claim["criterion"]["enforcement"], "required");

        let missing = &all["missing-artifact"];
        assert!(artifact_exists_failed(
            missing["criterion"]["artifactName"].as_str(),
            None,
            missing["producerOutput"]["artifacts"].as_array().unwrap()
        ));

        let fake = command::FakeCommandRunner::new(1);
        let (failed, _) = command_failed(
            &fake,
            Some("npm_test"),
            None,
            Path::new("."),
            &AtomicBool::new(false),
        );
        assert!(failed);

        let temp = std::env::temp_dir().join(format!("codex-golden-arch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(temp.join("src/runtime")).unwrap();
        std::fs::write(temp.join("src/runtime/scheduler.ts"), "x").unwrap();
        assert!(architecture_policy_failed(None, &temp).failed);
        let _ = std::fs::remove_dir_all(&temp);

        // P1: v2 structural policy must catch an unanticipated wrong-layer
        // scheduler by SHAPE (path infix + control flow), where v1's fixed
        // suspect globs (with native markers present) would pass it.
        let unanticipated = &all["architecture-wrong-layer-unanticipated"];
        let signals = &unanticipated["workspaceSignals"];
        let files = signals["files"].as_array().unwrap();
        let policy_id = signals["policyId"].as_str().unwrap();
        let temp =
            std::env::temp_dir().join(format!("codex-golden-arch-v2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        for file in files {
            let path = file["path"].as_str().unwrap();
            let content = file["content"].as_str().unwrap();
            let target = temp.join(path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&target, content).unwrap();
        }
        let v1 = architecture_policy_failed(Some("native_runtime_ownership_v1"), &temp);
        assert!(
            !v1.failed,
            "v1 must pass unanticipated names (the P0.4 allowlist gap): {}",
            v1.detail
        );
        let v2 = architecture_policy_failed(Some(policy_id), &temp);
        assert!(
            v2.failed,
            "v2 must fail the unanticipated wrong-layer fixture"
        );
        assert!(
            v2.detail.contains("src/scheduler/job_runner.ts"),
            "v2 detail must name the offending module: {}",
            v2.detail
        );
        let _ = std::fs::remove_dir_all(&temp);

        let approved = vec![ApprovedArtifact {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: "h-approved".into(),
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        }];
        let live = vec![ArtifactRef {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: "h-stale".into(),
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        }];
        assert!(matches!(
            delivery_pair_compare(&approved, &live),
            DeliveryCompareResult::Fail(_)
        ));

        // Failure taxonomy fixtures (P0.6): classify + stop rules must be real.
        assert_eq!(
            classify_failure(
                all["transient-failure-retry"]["attempts"][0]["error"]
                    .as_str()
                    .unwrap(),
            ),
            FailureClass::Transient
        );
        assert_eq!(
            all["transient-failure-retry"]["expect"]["failureClass"],
            "transient"
        );

        assert_eq!(
            classify_failure(all["capability-denial"]["attemptError"].as_str().unwrap()),
            FailureClass::Capability
        );
        assert_eq!(
            all["capability-denial"]["expect"]["gate"].as_str(),
            Some("needs_human"),
            "capability recovery must arm a needs_human gate (P2)"
        );

        let plateau = &all["quality-plateau-stop"];
        let attempts = plateau["attempts"].as_array().unwrap();
        let fps: Vec<String> = attempts
            .iter()
            .map(|a| a["fingerprint"].as_str().unwrap().to_string())
            .collect();
        let sets: Vec<String> = attempts
            .iter()
            .map(|a| a["artifactHashSet"].as_str().unwrap().to_string())
            .collect();
        assert!(
            is_plateau(&fps, &sets),
            "identical input+artifacts must plateau"
        );

        assert_eq!(
            classify_failure(
                all["spec-ambiguity-pause"]["producerOutput"]["summary"]
                    .as_str()
                    .unwrap()
            ),
            FailureClass::Specification
        );
        assert_eq!(
            all["spec-ambiguity-pause"]["expect"]["gate"].as_str(),
            Some("needs_human"),
            "specification recovery must arm a needs_human gate (P2)"
        );

        let revision = &all["revision-loop-evidence-routing"];
        let results = revision["producerOutput"]["data"]["verification"]["results"]
            .as_array()
            .expect("verification.results must be an array");
        let first = &results[0];
        assert_eq!(first["passed"], false, "producer cannot own the pass bit");
        assert_eq!(
            first["detail"].as_str().unwrap(),
            "npm_test exited 1 — missing export"
        );
        let required_failed = revision["producerOutput"]["data"]["verification"]["requiredFailed"]
            .as_array()
            .expect("requiredFailed must be an array");
        assert!(
            required_failed
                .iter()
                .any(|id| id.as_str() == Some("cmd-1")),
            "failed required criterion must be routed as revision evidence"
        );
        assert_eq!(
            revision["expect"]["revisionFeedbackContains"]
                .as_str()
                .unwrap(),
            "npm_test exited 1"
        );
        let persist = &revision["expect"]["persist"];
        assert_eq!(
            persist["failureClass"].as_str(),
            Some("verification"),
            "P3: verification-driven revisions must persist failureClass"
        );
        assert_eq!(
            persist["criterionIds"][0].as_str(),
            Some("cmd-1"),
            "P3: failing criterion id must ride the persisted record"
        );
    }
}
