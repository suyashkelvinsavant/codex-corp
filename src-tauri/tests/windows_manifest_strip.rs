//! Unit tests for the build-script RT_MANIFEST strip helpers.
//! Logic lives in `../windows_manifest_strip.rs` (shared with `build.rs`).

#[path = "../windows_manifest_strip.rs"]
mod windows_manifest_strip;

// Re-export tests defined inside the module's `#[cfg(test)]` block by invoking
// the same assertions here so `cargo test` runs them as an integration target.
// (The `#[cfg(test)]` submodule inside the path-included file is only compiled
// when that file is the crate root under `cfg(test)`; path-include from a test
// binary does compile `cfg(test)` on the included file.)

use windows_manifest_strip::{contains_rt_manifest, quote_msvc_path, strip_rc_rt_manifest};

const TAURI_STYLE: &str = r#"#pragma code_page(65001)
1 VERSIONINFO
FILEVERSION 0, 3, 0, 0
{
BLOCK "StringFileInfo"
{
BLOCK "000004b0"
{
VALUE "ProductName", "Codex Corp"
}
}
}
32512 ICON "C:\\icons\\icon.ico"
1 24
{
" <assembly xmlns=""urn:schemas-microsoft-com:asm.v1"" manifestVersion=""1.0""> "
" <dependency> "
" <dependentAssembly> "
" <assemblyIdentity "
" type=""win32"" "
" name=""Microsoft.Windows.Common-Controls"" "
" version=""6.0.0.0"" "
" /> "
" </dependentAssembly> "
" </dependency> "
" </assembly> "
}
"#;

#[test]
fn strips_tauri_numeric_rt_manifest_and_keeps_other_resources() {
    assert!(contains_rt_manifest(TAURI_STYLE));
    let stripped = strip_rc_rt_manifest(TAURI_STYLE);
    assert!(
        !contains_rt_manifest(&stripped),
        "RT_MANIFEST must be gone after strip:\n{stripped}"
    );
    assert!(stripped.contains("VERSIONINFO"));
    assert!(stripped.contains("32512 ICON"));
    assert!(stripped.contains("ProductName"));
    assert!(!stripped.contains("Common-Controls"));
}

#[test]
fn strips_named_rt_manifest_form() {
    let rc = "1 RT_MANIFEST\n{\n\" <assembly/> \"\n}\n2 ICON \"x.ico\"\n";
    let stripped = strip_rc_rt_manifest(rc);
    assert!(!contains_rt_manifest(&stripped));
    assert!(stripped.contains("2 ICON"));
}

#[test]
fn strips_createprocess_manifest_resource_id_form() {
    let rc = "CREATEPROCESS_MANIFEST_RESOURCE_ID RT_MANIFEST { \"x\" }\n1 VERSIONINFO\n";
    let stripped = strip_rc_rt_manifest(rc);
    assert!(!contains_rt_manifest(&stripped));
    assert!(stripped.contains("VERSIONINFO"));
}

#[test]
fn strips_single_line_manifest_block() {
    let rc = "1 24 { \" <assembly/> \" }\n1 VERSIONINFO\n";
    let stripped = strip_rc_rt_manifest(rc);
    assert!(!contains_rt_manifest(&stripped));
    assert!(stripped.contains("VERSIONINFO"));
}

#[test]
fn no_op_when_no_manifest_present() {
    let rc = "1 VERSIONINFO\n{\n}\n";
    let stripped = strip_rc_rt_manifest(rc);
    assert_eq!(stripped, "1 VERSIONINFO\n{\n}\n");
    assert!(!contains_rt_manifest(&stripped));
}

#[test]
fn malformed_manifest_header_preserves_following_resource() {
    let rc = "1 RT_MANIFEST\n\nIDI_ICON1 ICON \"app.ico\"\n";
    let stripped = strip_rc_rt_manifest(rc);
    assert!(stripped.contains("1 RT_MANIFEST"));
    assert!(stripped.contains("IDI_ICON1 ICON"));
}

#[test]
fn quote_msvc_path_wraps_spaces_only_when_needed() {
    let spaced = std::path::Path::new(r"C:\workspaces\My Projects\app\manifest.xml");
    let q = quote_msvc_path(spaced);
    assert!(q.starts_with('"') && q.ends_with('"'), "{q}");
    assert!(q.contains(r"My Projects"));

    let plain = std::path::Path::new(r"C:\workspaces\Projects\app\manifest.xml");
    let q = quote_msvc_path(plain);
    assert!(!q.contains('"'), "unquoted path must not gain quotes: {q}");
    assert_eq!(q, r"C:\workspaces\Projects\app\manifest.xml");
}
