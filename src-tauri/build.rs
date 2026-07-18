// Shared strip/quote helpers (also unit-tested via tests/windows_manifest_strip.rs).
#[path = "windows_manifest_strip.rs"]
#[allow(dead_code)]
mod windows_manifest_strip;

use windows_manifest_strip::{contains_rt_manifest, quote_msvc_path, strip_rc_rt_manifest};

fn main() {
    tauri_build::build();

    // Windows: unit-test harnesses for the lib do not receive tauri-build's
    // rustc-link-arg-bins resource.lib, so they lack Common-Controls 6.0 and
    // fail at load with STATUS_ENTRYPOINT_NOT_FOUND (TaskDialogIndirect).
    //
    // Strip tauri's manifest from its resource.lib, then apply the known-good
    // manifest as a linker input for the lib unit-test harness. Official binary
    // scripts embed and verify that same manifest after linking because MSVC
    // does not reliably retain /MANIFESTINPUT for Rust package binaries.
    #[cfg(windows)]
    embed_comctl_manifest_once();
}

#[cfg(windows)]
fn embed_comctl_manifest_once() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-comctl.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());

    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        println!("cargo:warning=OUT_DIR unset; skipping comctl manifest workaround");
        return;
    };
    let out_dir = std::path::PathBuf::from(out_dir);
    let resource_rc = out_dir.join("resource.rc");
    let resource_lib = out_dir.join("resource.lib");
    match strip_rt_manifest_and_rebuild(&resource_rc, &resource_lib) {
        Ok(()) => {
            let quoted = quote_msvc_path(&manifest);
            println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            println!("cargo:rustc-link-arg=/MANIFESTINPUT:{quoted}");
        }
        Err(err) => println!(
            "cargo:warning=comctl resource rebuild failed ({err}); leaving tauri resource unchanged"
        ),
    }
}

#[cfg(windows)]
fn strip_rt_manifest_and_rebuild(
    resource_rc: &std::path::Path,
    resource_lib: &std::path::Path,
) -> Result<(), String> {
    let original = std::fs::read_to_string(resource_rc)
        .map_err(|e| format!("read {}: {e}", resource_rc.display()))?;
    if !contains_rt_manifest(&original) {
        return Err("resource.rc has no RT_MANIFEST block to strip".into());
    }
    let stripped = strip_rc_rt_manifest(&original);
    if contains_rt_manifest(&stripped) || stripped == original {
        return Err("RT_MANIFEST strip failed closed".into());
    }
    let stripped_rc = resource_rc.with_extension("no-manifest.rc");
    std::fs::write(&stripped_rc, stripped)
        .map_err(|e| format!("write {}: {e}", stripped_rc.display()))?;
    let res_path = resource_rc.with_extension("no-manifest.res");
    let rc = find_tool("rc.exe").ok_or_else(|| "rc.exe not found".to_string())?;
    let status = std::process::Command::new(rc)
        .args([
            "/nologo",
            "/fo",
            res_path.to_str().ok_or("resource path is not UTF-8")?,
            stripped_rc.to_str().ok_or("resource path is not UTF-8")?,
        ])
        .status()
        .map_err(|e| format!("spawn rc.exe: {e}"))?;
    if !status.success() {
        return Err(format!("rc.exe exited with {status}"));
    }
    let cvtres = find_tool("cvtres.exe").ok_or_else(|| "cvtres.exe not found".to_string())?;
    let out_arg = format!("/out:{}", quote_msvc_path(resource_lib));
    let status = std::process::Command::new(cvtres)
        .args([
            "/nologo",
            &out_arg,
            res_path.to_str().ok_or("resource path is not UTF-8")?,
        ])
        .status()
        .map_err(|e| format!("spawn cvtres.exe: {e}"))?;
    if !status.success() {
        return Err(format!("cvtres.exe exited with {status}"));
    }
    Ok(())
}

#[cfg(windows)]
fn find_tool(name: &str) -> Option<std::path::PathBuf> {
    // 1) PATH (vcvars, rust-msvc, developer shells).
    if let Some(found) = find_on_path(name) {
        return Some(found);
    }

    // 2) vswhere (handles BuildTools / nonstandard VS roots).
    if let Some(found) = find_via_vswhere(name) {
        return Some(found);
    }

    // 3) Windows Kits (typical home of rc.exe).
    if let Some(found) = find_in_windows_kits(name) {
        return Some(found);
    }

    // 4) Well-known MSVC tool directories under Program Files.
    find_in_msvc_tools(name)
}

#[cfg(windows)]
fn find_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn find_via_vswhere(name: &str) -> Option<std::path::PathBuf> {
    let vswhere = std::env::var_os("ProgramFiles(x86)")
        .map(std::path::PathBuf::from)
        .map(|p| p.join(r"Microsoft Visual Studio\Installer\vswhere.exe"))
        .filter(|p| p.is_file())?;

    // -find returns matching tool paths under the selected installation.
    let output = std::process::Command::new(&vswhere)
        .args([
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-find",
            &format!(r"**\{name}"),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let candidate = std::path::PathBuf::from(line.trim());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn find_in_windows_kits(name: &str) -> Option<std::path::PathBuf> {
    let program_files =
        std::env::var_os("ProgramFiles(x86)").or_else(|| std::env::var_os("ProgramFiles"))?;
    let kits = std::path::Path::new(&program_files).join(r"Windows Kits\10\bin");
    if !kits.is_dir() {
        return None;
    }
    let mut vers: Vec<_> = std::fs::read_dir(&kits)
        .ok()?
        .filter_map(|e| e.ok())
        .collect();
    vers.sort_by_key(|e| e.file_name());
    for entry in vers.into_iter().rev() {
        for arch in ["x64", "x86"] {
            let candidate = entry.path().join(arch).join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn find_in_msvc_tools(name: &str) -> Option<std::path::PathBuf> {
    let pf = std::env::var_os("ProgramFiles")?;
    let vs_root = std::path::Path::new(&pf).join("Microsoft Visual Studio");
    if !vs_root.is_dir() {
        return None;
    }

    // Layouts look like: Microsoft Visual Studio\{year|18}\{Edition}\VC\Tools\MSVC\{ver}\bin\Hostx64\x64
    for year in std::fs::read_dir(&vs_root).ok()?.flatten() {
        let year_path = year.path();
        if !year_path.is_dir() {
            continue;
        }
        for edition in std::fs::read_dir(&year_path).ok()?.flatten() {
            let msvc = edition.path().join(r"VC\Tools\MSVC");
            if !msvc.is_dir() {
                continue;
            }
            let mut vers: Vec<_> = std::fs::read_dir(&msvc)
                .ok()?
                .filter_map(|e| e.ok())
                .collect();
            vers.sort_by_key(|e| e.file_name());
            for ver in vers.into_iter().rev() {
                for host in [r"bin\Hostx64\x64", r"bin\HostX64\x64", r"bin\Hostx86\x86"] {
                    let candidate = ver.path().join(host).join(name);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    None
}
