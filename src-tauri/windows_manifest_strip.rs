//! Pure helpers for stripping RT_MANIFEST from tauri-build's resource.rc.
//! Shared by `build.rs` (include via `#[path]`) and unit tests.

/// Returns true if the `.rc` text still contains an application RT_MANIFEST resource.
///
/// Matches common tauri-build / MSVC forms:
/// - `1 24` (CREATEPROCESS_MANIFEST_RESOURCE_ID + RT_MANIFEST numeric type)
/// - `1 RT_MANIFEST`
/// - `CREATEPROCESS_MANIFEST_RESOURCE_ID RT_MANIFEST`
pub fn contains_rt_manifest(rc: &str) -> bool {
    for line in rc.lines() {
        if is_rt_manifest_header(line.trim()) {
            return true;
        }
    }
    false
}

/// Remove RT_MANIFEST resource block(s) from a Windows `.rc` source string.
///
/// Leaves VERSIONINFO, ICON, and any other resources intact. If no RT_MANIFEST
/// block is found, returns the input unchanged (caller should treat that as
/// failure when a strip was required).
pub fn strip_rc_rt_manifest(rc: &str) -> String {
    let mut out = String::with_capacity(rc.len());
    let mut lines = rc.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if !is_rt_manifest_header(trimmed) {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        // Drop header and its `{ ... }` body (single- or multi-line).
        if brace_balance(trimmed) == 0 && trimmed.contains('{') && trimmed.contains('}') {
            // Entire resource on one line: `1 24 { "..." }`
            continue;
        }

        let mut depth = brace_balance(trimmed);
        // Header line without `{` yet (unusual): wait for the opening brace.
        if depth == 0 && !trimmed.contains('{') {
            let mut blanks = Vec::new();
            while lines.peek().is_some_and(|next| next.trim().is_empty()) {
                blanks.push(lines.next().unwrap());
            }
            if lines
                .peek()
                .is_some_and(|next| next.trim().starts_with('{'))
            {
                if let Some(opening) = lines.next() {
                    depth += brace_balance(opening);
                }
            } else {
                // Malformed/unknown shape: preserve it verbatim so the caller's
                // post-strip RT_MANIFEST check fails closed instead of corrupting RC.
                out.push_str(line);
                out.push('\n');
                for blank in blanks {
                    out.push_str(blank);
                    out.push('\n');
                }
                continue;
            }
        }

        if depth > 0 {
            for next in lines.by_ref() {
                depth += brace_balance(next);
                if depth <= 0 {
                    break;
                }
            }
        }
    }
    out
}

/// Format a filesystem path for MSVC linker / tool flags (`/MANIFESTINPUT:…`, `/out:…`).
///
/// Quotes only when the path contains whitespace or characters that break unquoted
/// MSVC flag parsing. Always quoting breaks some tools (notably `cvtres.exe`), which
/// treat the quotes as part of the filename and fail with CVT1108.
pub fn quote_msvc_path(path: &std::path::Path) -> String {
    let s = path.display().to_string();
    let needs_quotes = s
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '"' | '\''));
    if needs_quotes {
        format!("\"{}\"", s.replace('"', r#""""#))
    } else {
        s
    }
}

fn is_rt_manifest_header(trimmed: &str) -> bool {
    let parts: Vec<_> = trimmed.split_whitespace().collect();
    if parts.len() < 2 {
        return false;
    }
    let id = parts[0];
    let ty = parts[1];
    let id_is_app_manifest =
        id == "1" || id.eq_ignore_ascii_case("CREATEPROCESS_MANIFEST_RESOURCE_ID");
    let type_is_manifest = ty == "24" || ty.eq_ignore_ascii_case("RT_MANIFEST");
    id_is_app_manifest && type_is_manifest
}

fn brace_balance(s: &str) -> i32 {
    (s.matches('{').count() as i32) - (s.matches('}').count() as i32)
}
