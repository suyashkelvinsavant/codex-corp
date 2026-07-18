#[test]
fn discover_codex_does_not_create_or_mutate_the_data_directory() {
    let data_dir = std::env::temp_dir().join(format!(
        "codex-discover-readonly-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&data_dir);

    std::env::set_var("CODEX_CORP_DATA_DIR", &data_dir);
    let result = codex_corp_lib::mcp_server::discover_codex_json();
    std::env::remove_var("CODEX_CORP_DATA_DIR");
    assert!(result.is_ok(), "discover-codex failed: {result:?}");
    assert!(
        !data_dir.exists(),
        "read-only discovery created {}",
        data_dir.display()
    );
}
