use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

use super::types::{
    artifact_content, artifact_name, content_hash_for, make_artifact_key, sanitize_artifact_name,
    ApprovedArtifact, ArtifactRef, DeliveryCompareResult,
};

/// Assign hostOrdinal, artifactKey, contentHash on each artifact (host-owned).
/// Previous attempt ordinals are rematched by content-hash then name when possible.
pub fn materialize_artifacts(
    source_node_id: &str,
    artifacts: &[Value],
    previous: Option<&[Value]>,
) -> (Vec<Value>, Vec<ArtifactRef>) {
    let mut used_ordinals = HashSet::new();
    let mut next_ordinal: u32 = 0;
    let mut prev_by_hash: HashMap<String, u32> = HashMap::new();
    let mut prev_by_name: HashMap<String, u32> = HashMap::new();
    if let Some(prev) = previous {
        for (i, art) in prev.iter().enumerate() {
            let ordinal = art
                .get("hostOrdinal")
                .and_then(Value::as_u64)
                .map(|v| v as u32)
                .unwrap_or(i as u32);
            let name = sanitize_artifact_name(&artifact_name(art));
            let hash = art
                .get("contentHash")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
                .unwrap_or_else(|| content_hash_for(&artifact_content(art)));
            prev_by_hash.entry(hash).or_insert(ordinal);
            prev_by_name.entry(name).or_insert(ordinal);
        }
        next_ordinal = prev
            .iter()
            .filter_map(|a| a.get("hostOrdinal").and_then(Value::as_u64))
            .map(|v| v as u32)
            .max()
            .map(|m| m.saturating_add(1))
            .unwrap_or(prev.len() as u32);
    }

    let mut out_artifacts = Vec::with_capacity(artifacts.len());
    let mut refs = Vec::with_capacity(artifacts.len());

    for art in artifacts {
        let name = sanitize_artifact_name(&artifact_name(art));
        let content = artifact_content(art);
        let hash = content_hash_for(&content);

        let ordinal = if let Some(&o) = prev_by_hash.get(&hash) {
            if used_ordinals.insert(o) {
                o
            } else {
                allocate_ordinal(&mut next_ordinal, &mut used_ordinals)
            }
        } else if let Some(&o) = prev_by_name.get(&name) {
            if used_ordinals.insert(o) {
                o
            } else {
                allocate_ordinal(&mut next_ordinal, &mut used_ordinals)
            }
        } else {
            allocate_ordinal(&mut next_ordinal, &mut used_ordinals)
        };

        let key = make_artifact_key(source_node_id, ordinal, &name);
        let mut obj = match art {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        obj.insert("hostOrdinal".into(), json!(ordinal));
        obj.insert("artifactKey".into(), json!(key));
        obj.insert("contentHash".into(), json!(hash));
        if !obj.contains_key("name")
            || obj
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .is_empty()
        {
            obj.insert("name".into(), json!(name));
        }
        let value = Value::Object(obj);
        refs.push(ArtifactRef {
            artifact_key: key,
            content_hash: hash,
            source_node_id: source_node_id.to_string(),
            name,
            host_ordinal: ordinal,
        });
        out_artifacts.push(value);
    }

    (out_artifacts, refs)
}

fn allocate_ordinal(next: &mut u32, used: &mut HashSet<u32>) -> u32 {
    while used.contains(next) {
        *next = next.saturating_add(1);
    }
    let o = *next;
    used.insert(o);
    *next = next.saturating_add(1);
    o
}

/// Collect host-keyed artifact refs from all completed specialist/creative outputs.
pub fn collect_upstream_artifacts(
    outputs: &HashMap<String, (String, Vec<Value>)>,
) -> Vec<ArtifactRef> {
    // outputs: node_id -> (kind, artifacts)
    let mut refs = Vec::new();
    for (node_id, (kind, artifacts)) in outputs {
        if kind != "agent" && kind != "creative" {
            continue;
        }
        for art in artifacts {
            if let (Some(key), Some(hash), Some(ordinal)) = (
                art.get("artifactKey").and_then(Value::as_str),
                art.get("contentHash").and_then(Value::as_str),
                art.get("hostOrdinal").and_then(Value::as_u64),
            ) {
                refs.push(ArtifactRef {
                    artifact_key: key.to_string(),
                    content_hash: hash.to_string(),
                    source_node_id: node_id.clone(),
                    name: sanitize_artifact_name(&artifact_name(art)),
                    host_ordinal: ordinal as u32,
                });
            }
        }
    }
    refs
}

/// Freeze approval snapshot payload for approval node output.data.
pub fn freeze_approval_snapshot(
    request_id: &str,
    approved_at: &str,
    refs: &[ArtifactRef],
) -> Value {
    let approved: Vec<ApprovedArtifact> = refs.iter().map(ApprovedArtifact::from).collect();
    json!({
        "decision": "approved",
        "explicitHuman": true,
        "approvedArtifacts": approved,
        "approvedAt": approved_at,
        "requestId": request_id
    })
}

/// Pair-equality compare: every approved (key,hash) must match live, and every
/// live release-set key must be in the approved set.
pub fn delivery_pair_compare(
    approved: &[ApprovedArtifact],
    live: &[ArtifactRef],
) -> DeliveryCompareResult {
    // Empty↔empty is valid pair equality (analysis/review workflows may freeze
    // zero file artifacts). Residual risk `empty_approval_artifact_set` is
    // recorded by the delivery assembler — not a hard fail here.
    let live_map: HashMap<&str, &str> = live
        .iter()
        .map(|r| (r.artifact_key.as_str(), r.content_hash.as_str()))
        .collect();
    let approved_keys: HashSet<&str> = approved.iter().map(|a| a.artifact_key.as_str()).collect();

    for entry in approved {
        match live_map.get(entry.artifact_key.as_str()) {
            None => {
                return DeliveryCompareResult::Fail(format!(
                    "approved key missing from live set: {}",
                    entry.artifact_key
                ));
            }
            Some(hash) if *hash != entry.content_hash.as_str() => {
                return DeliveryCompareResult::Fail(format!(
                    "hash mismatch for {}: approved {} live {}",
                    entry.artifact_key, entry.content_hash, hash
                ));
            }
            _ => {}
        }
    }
    for live_ref in live {
        if !approved_keys.contains(live_ref.artifact_key.as_str()) {
            return DeliveryCompareResult::Fail(format!(
                "live key not in approved set: {}",
                live_ref.artifact_key
            ));
        }
    }
    DeliveryCompareResult::Pass
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn host_assigns_artifact_key_ordinal() {
        let (arts, refs) = materialize_artifacts(
            "builder",
            &[json!({"name":"src/app.ts","content":"export const x=1"})],
            None,
        );
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].host_ordinal, 0);
        assert_eq!(refs[0].artifact_key, "builder::0::src/app.ts");
        assert!(refs[0].content_hash.starts_with("sha256:"));
        assert!(arts[0]
            .get("contentHash")
            .and_then(|v| v.as_str())
            .is_some_and(|h| h.starts_with("sha256:")));
    }

    #[test]
    fn delivery_pair_compare_hash_mismatch() {
        let approved = vec![ApprovedArtifact {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: "h1".into(),
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        }];
        let live = vec![ArtifactRef {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: "h2".into(),
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        }];
        match delivery_pair_compare(&approved, &live) {
            DeliveryCompareResult::Fail(msg) => assert!(msg.contains("hash mismatch")),
            DeliveryCompareResult::Pass => panic!("expected fail"),
        }
    }

    #[test]
    fn delivery_new_key_fails() {
        let approved = vec![ApprovedArtifact {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: "h1".into(),
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        }];
        let live = vec![
            ArtifactRef {
                artifact_key: "builder::0::a.ts".into(),
                content_hash: "h1".into(),
                source_node_id: "builder".into(),
                name: "a.ts".into(),
                host_ordinal: 0,
            },
            ArtifactRef {
                artifact_key: "builder::1::b.ts".into(),
                content_hash: "h2".into(),
                source_node_id: "builder".into(),
                name: "b.ts".into(),
                host_ordinal: 1,
            },
        ];
        match delivery_pair_compare(&approved, &live) {
            DeliveryCompareResult::Fail(msg) => assert!(msg.contains("not in approved")),
            DeliveryCompareResult::Pass => panic!("expected fail"),
        }
    }

    #[test]
    fn rename_after_approve_fails_closed() {
        let approved = vec![ApprovedArtifact {
            artifact_key: "builder::0::old.ts".into(),
            content_hash: "h1".into(),
            source_node_id: "builder".into(),
            name: "old.ts".into(),
            host_ordinal: 0,
        }];
        let live = vec![ArtifactRef {
            artifact_key: "builder::0::new.ts".into(),
            content_hash: "h1".into(),
            source_node_id: "builder".into(),
            name: "new.ts".into(),
            host_ordinal: 0,
        }];
        assert!(matches!(
            delivery_pair_compare(&approved, &live),
            DeliveryCompareResult::Fail(_)
        ));
    }

    #[test]
    fn empty_approved_and_empty_live_passes() {
        assert!(matches!(
            delivery_pair_compare(&[], &[]),
            DeliveryCompareResult::Pass
        ));
    }

    #[test]
    fn empty_approved_with_live_artifacts_fails() {
        let live = vec![ArtifactRef {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: "h1".into(),
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        }];
        match delivery_pair_compare(&[], &live) {
            DeliveryCompareResult::Fail(msg) => assert!(msg.contains("not in approved")),
            DeliveryCompareResult::Pass => panic!("expected fail"),
        }
    }

    #[test]
    fn approved_without_live_still_fails() {
        let approved = vec![ApprovedArtifact {
            artifact_key: "builder::0::a.ts".into(),
            content_hash: "h1".into(),
            source_node_id: "builder".into(),
            name: "a.ts".into(),
            host_ordinal: 0,
        }];
        match delivery_pair_compare(&approved, &[]) {
            DeliveryCompareResult::Fail(msg) => assert!(msg.contains("missing from live")),
            DeliveryCompareResult::Pass => panic!("expected fail"),
        }
    }
}
