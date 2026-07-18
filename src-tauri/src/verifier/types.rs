use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Host-assigned artifact identity after materialize.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub artifact_key: String,
    pub content_hash: String,
    pub source_node_id: String,
    pub name: String,
    pub host_ordinal: u32,
}

/// Frozen entry stored on approval node output.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedArtifact {
    pub artifact_key: String,
    pub content_hash: String,
    pub source_node_id: String,
    pub name: String,
    pub host_ordinal: u32,
}

impl From<&ArtifactRef> for ApprovedArtifact {
    fn from(value: &ArtifactRef) -> Self {
        Self {
            artifact_key: value.artifact_key.clone(),
            content_hash: value.content_hash.clone(),
            source_node_id: value.source_node_id.clone(),
            name: value.name.clone(),
            host_ordinal: value.host_ordinal,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryCompareResult {
    Pass,
    Fail(String),
}

/// Sanitize producer-controlled name for key composition.
/// Keeps path separators so keys like `src/app.ts` remain readable (plan Q18 example).
pub fn sanitize_artifact_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "unnamed".into();
    }
    trimmed
        .chars()
        .map(|ch| match ch {
            // Colon would break the `::` key delimiter; strip other controls.
            ':' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .chars()
        .take(200)
        .collect()
}

/// Stable content digest for artifact keys, fingerprints, and delivery bundle self-hash.
/// Emits `sha256:<hex>` of UTF-8 content bytes (plan III.5).
pub fn content_hash_for(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(content.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("sha256:{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_uses_sha256_prefix() {
        let h = content_hash_for("export const x=1");
        assert!(h.starts_with("sha256:"), "got {h}");
        assert_eq!(h.len(), "sha256:".len() + 64);
        assert_eq!(content_hash_for("export const x=1"), h);
        assert_ne!(content_hash_for("export const x=2"), h);
    }
}

/// Build host key: `{sourceNodeId}::{hostOrdinal}::{sanitizedName}`
pub fn make_artifact_key(source_node_id: &str, host_ordinal: u32, name: &str) -> String {
    format!(
        "{source_node_id}::{host_ordinal}::{}",
        sanitize_artifact_name(name)
    )
}

pub fn artifact_content(artifact: &Value) -> String {
    artifact
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub fn artifact_name(artifact: &Value) -> String {
    artifact
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}
