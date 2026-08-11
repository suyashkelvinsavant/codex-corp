use serde_json::Value;
use std::collections::HashSet;

use super::{ConditionRule, RuntimeGraph};

pub(super) fn parse_graph(raw: &str) -> Result<RuntimeGraph, String> {
    let graph: RuntimeGraph = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if graph.nodes.iter().all(|node| node.data.kind != "input") {
        return Err("workflow requires an input node".into());
    }
    if graph.nodes.iter().all(|node| node.data.kind != "output") {
        return Err("workflow requires an output node".into());
    }
    let ids: HashSet<_> = graph.nodes.iter().map(|node| node.id.as_str()).collect();
    for edge in &graph.edges {
        if !ids.contains(edge.source.as_str()) || !ids.contains(edge.target.as_str()) {
            return Err(format!("edge {} references a missing node", edge.id));
        }
    }
    for node in graph
        .nodes
        .iter()
        .filter(|node| node.data.kind == "condition")
    {
        validate_condition_rule(node.data.condition_rule.as_ref())?;
        let inbound: Vec<_> = graph
            .edges
            .iter()
            .filter(|edge| {
                edge.target == node.id
                    && edge.data.as_ref().map(|data| data.edge_type.as_str()) != Some("revision")
            })
            .collect();
        if inbound.len() > 1
            && node
                .data
                .condition_rule
                .as_ref()
                .and_then(|rule| rule.source_node_id.as_ref())
                .is_none()
        {
            return Err(format!(
                "condition {} must select an explicit upstream source",
                node.data.label
            ));
        }
        if let Some(source) = node
            .data
            .condition_rule
            .as_ref()
            .and_then(|rule| rule.source_node_id.as_ref())
        {
            if !inbound.iter().any(|edge| &edge.source == source) {
                return Err(format!(
                    "condition {} source must be a direct upstream node",
                    node.data.label
                ));
            }
        }
    }
    Ok(graph)
}

pub(super) fn validate_condition_rule(rule: Option<&ConditionRule>) -> Result<(), String> {
    let rule = rule.ok_or("legacy static condition must be configured before running")?;
    if !rule.path.starts_with("$.")
        || !rule
            .path
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "$._-".contains(character))
    {
        return Err("condition path is invalid".into());
    }
    if !matches!(
        rule.operator.as_str(),
        "==" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "exists"
    ) {
        return Err("condition operator is not allowed".into());
    }
    if rule.true_branch.trim().is_empty()
        || rule.false_branch.trim().is_empty()
        || rule.true_branch == rule.false_branch
    {
        return Err("condition branches must be non-empty and distinct".into());
    }
    if rule.operator != "exists" && rule.value.is_none() {
        return Err("condition comparison value is required".into());
    }
    Ok(())
}

fn read_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.strip_prefix("$.")?
        .split('.')
        .try_fold(value, |current, segment| current.get(segment))
}

pub(super) fn evaluate_condition(rule: &ConditionRule, source: &Value) -> bool {
    let actual = read_path(source, &rule.path);
    match rule.operator.as_str() {
        "exists" => actual.is_some_and(|value| !value.is_null()),
        "==" => actual == rule.value.as_ref(),
        "!=" => actual != rule.value.as_ref(),
        ">" | ">=" | "<" | "<=" => {
            let Some(left) = actual.and_then(Value::as_f64) else {
                return false;
            };
            let Some(right) = rule.value.as_ref().and_then(Value::as_f64) else {
                return false;
            };
            match rule.operator.as_str() {
                ">" => left > right,
                ">=" => left >= right,
                "<" => left < right,
                _ => left <= right,
            }
        }
        "contains" => match (actual, rule.value.as_ref()) {
            (Some(Value::String(text)), Some(Value::String(needle))) => text.contains(needle),
            (Some(Value::Array(items)), Some(needle)) => items.contains(needle),
            _ => false,
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn evaluate_condition_exists_checks_non_null() {
        let source = json!({"a": 1, "b": null});
        let rule = ConditionRule {
            source_node_id: None,
            path: "$.a".into(),
            operator: "exists".into(),
            value: None,
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(evaluate_condition(&rule, &source));
        let rule_b = ConditionRule {
            source_node_id: None,
            path: "$.b".into(),
            operator: "exists".into(),
            value: None,
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(!evaluate_condition(&rule_b, &source));
        let rule_missing = ConditionRule {
            source_node_id: None,
            path: "$.c".into(),
            operator: "exists".into(),
            value: None,
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(!evaluate_condition(&rule_missing, &source));
    }

    #[test]
    fn evaluate_condition_numeric_comparisons() {
        let source = json!({"score": 5});
        let mk = |op: &str, val: Value| ConditionRule {
            source_node_id: None,
            path: "$.score".into(),
            operator: op.into(),
            value: Some(val),
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(evaluate_condition(&mk(">", json!(4)), &source));
        assert!(evaluate_condition(&mk(">=", json!(5)), &source));
        assert!(!evaluate_condition(&mk(">", json!(5)), &source));
        assert!(evaluate_condition(&mk("<", json!(6)), &source));
        assert!(evaluate_condition(&mk("<=", json!(5)), &source));
        assert!(!evaluate_condition(&mk("<", json!(5)), &source));
    }

    #[test]
    fn evaluate_condition_string_contains() {
        let source = json!({"text": "hello world"});
        let rule = ConditionRule {
            source_node_id: None,
            path: "$.text".into(),
            operator: "contains".into(),
            value: Some(json!("world")),
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(evaluate_condition(&rule, &source));
        let rule_no = ConditionRule {
            source_node_id: None,
            path: "$.text".into(),
            operator: "contains".into(),
            value: Some(json!("missing")),
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(!evaluate_condition(&rule_no, &source));
    }

    #[test]
    fn evaluate_condition_array_contains() {
        let source = json!({"tags": ["a", "b", "c"]});
        let rule = ConditionRule {
            source_node_id: None,
            path: "$.tags".into(),
            operator: "contains".into(),
            value: Some(json!("b")),
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(evaluate_condition(&rule, &source));
    }

    #[test]
    fn evaluate_condition_equality() {
        let source = json!({"status": "ready"});
        let rule = ConditionRule {
            source_node_id: None,
            path: "$.status".into(),
            operator: "==".into(),
            value: Some(json!("ready")),
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(evaluate_condition(&rule, &source));
        let rule_ne = ConditionRule {
            source_node_id: None,
            path: "$.status".into(),
            operator: "!=".into(),
            value: Some(json!("ready")),
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(!evaluate_condition(&rule_ne, &source));
    }

    #[test]
    fn validate_condition_rule_rejects_invalid_path() {
        let rule = ConditionRule {
            source_node_id: None,
            path: "invalid".into(),
            operator: "==".into(),
            value: Some(json!(1)),
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(validate_condition_rule(Some(&rule)).is_err());
    }

    #[test]
    fn validate_condition_rule_rejects_same_branches() {
        let rule = ConditionRule {
            source_node_id: None,
            path: "$.a".into(),
            operator: "==".into(),
            value: Some(json!(1)),
            true_branch: "same".into(),
            false_branch: "same".into(),
        };
        assert!(validate_condition_rule(Some(&rule)).is_err());
    }

    #[test]
    fn validate_condition_rule_rejects_missing_value_for_comparison() {
        let rule = ConditionRule {
            source_node_id: None,
            path: "$.a".into(),
            operator: "==".into(),
            value: None,
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(validate_condition_rule(Some(&rule)).is_err());
    }

    #[test]
    fn validate_condition_rule_accepts_exists_without_value() {
        let rule = ConditionRule {
            source_node_id: None,
            path: "$.a".into(),
            operator: "exists".into(),
            value: None,
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(validate_condition_rule(Some(&rule)).is_ok());
    }

    #[test]
    fn validate_condition_rule_rejects_unknown_operator() {
        let rule = ConditionRule {
            source_node_id: None,
            path: "$.a".into(),
            operator: "matches".into(),
            value: Some(json!("x")),
            true_branch: "t".into(),
            false_branch: "f".into(),
        };
        assert!(validate_condition_rule(Some(&rule)).is_err());
    }
}
