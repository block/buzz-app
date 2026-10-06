use crate::{connection::private_directory, Result};
use std::fs;
use std::io::Write;
use std::path::Path;

// Copied from desktop/src-tauri/src/managed_agents/nest_skill.md at the Buzz
// revision in runtime/agent-runtime.json.
const CLI_SKILL: &str = include_str!("buzz_cli_skill.md");
// Shares the old desktop's marker. Bump only with a newer template; never
// downgrade an installation refreshed by a newer old desktop.
const CLI_SKILL_VERSION: u32 = 6;
// Owned here; old Buzz never installs it. Bump when changing the template.
const MEMORY_SKILL: &str = include_str!("buzz_memory_skill.md");
const MEMORY_SKILL_VERSION: u32 = 1;
const SKILLS: &[(&str, &str, u32)] = &[
    ("buzz-cli", CLI_SKILL, CLI_SKILL_VERSION),
    ("buzz-memory", MEMORY_SKILL, MEMORY_SKILL_VERSION),
];
#[cfg(unix)]
const PROVIDERS: &[&str] = &[".claude", ".codex", ".goose"];

/// Install the bundled Buzz skills in the desktop's default workspace.
/// Like the old desktop, custom content survives until a template upgrade.
/// One skill's failure does not block the others.
pub fn ensure_buzz_skills(workspace: &Path) -> Result<()> {
    if !workspace.is_absolute() {
        return Err("Buzz skill workspace must be absolute".into());
    }
    private_directory(workspace)?;
    let agents = workspace.join(".agents");
    private_directory(&agents)?;
    let skills = agents.join("skills");
    private_directory(&skills)?;
    let failures: Vec<String> = SKILLS
        .iter()
        .filter_map(|&(name, template, version)| {
            ensure_skill(workspace, &skills, name, template, version)
                .err()
                .map(|error| format!("{name}: {error}"))
        })
        .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn ensure_skill(
    workspace: &Path,
    skills: &Path,
    name: &str,
    template: &str,
    current: u32,
) -> Result<()> {
    let canonical = skills.join(name);
    // Only buzz-cli had the old Claude-only layout.
    #[cfg(unix)]
    if name == "buzz-cli" {
        migrate_claude_skill(workspace, &canonical)?;
    }
    private_directory(&canonical)?;
    let skill = canonical.join("SKILL.md");
    let version = canonical.join(".skill-version");
    let skill_exists = regular_file(&skill)?;
    let installed_version = read_version(&version)?;
    if !skill_exists || installed_version < current {
        atomic_write(&skill, template)?;
    }
    // Publish the marker only after the content succeeds; interrupted installs
    // retry next startup. Missing content is repaired even with a newer marker.
    if installed_version < current {
        atomic_write(&version, &format!("{current}\n"))?;
    }
    #[cfg(unix)]
    for provider in PROVIDERS {
        let parent = workspace.join(provider);
        if let Err(error) = link_provider(&parent, name) {
            eprintln!(
                "buzz: skipped {name} skill link at {}: {error}",
                parent.display()
            );
        }
    }
    Ok(())
}

#[cfg(unix)]
fn link_provider(parent: &Path, name: &str) -> Result<()> {
    private_directory(parent)?;
    let skills = parent.join("skills");
    private_directory(&skills)?;
    let link = skills.join(name);
    match fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() && !link.exists() => {
            fs::remove_file(&link).map_err(|_| "Could not repair Buzz skill link")?;
        }
        Ok(_) => return Ok(()), // Preserve existing links and custom real directories.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Could not inspect Buzz skill link".into()),
    }
    std::os::unix::fs::symlink(format!("../../.agents/skills/{name}"), &link)
        .map_err(|_| "Could not create Buzz skill link".into())
}

#[cfg(unix)]
fn migrate_claude_skill(workspace: &Path, canonical: &Path) -> Result<()> {
    let canonical_exists = match fs::symlink_metadata(canonical) {
        Ok(_) => {
            private_directory(canonical)?;
            if read_version(&canonical.join(".skill-version"))? >= CLI_SKILL_VERSION {
                return Ok(());
            }
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("Could not inspect canonical Buzz skill directory".into()),
    };
    let provider = workspace.join(".claude");
    let skills = provider.join("skills");
    // Migrate only from the workspace's own directories. A missing or
    // redirected ancestor holds no legacy layout to move, and must not stop
    // the canonical install.
    let real_dir = |path: &Path| fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir());
    if !real_dir(&provider) || !real_dir(&skills) {
        return Ok(());
    }
    let legacy = skills.join("buzz-cli");
    match fs::symlink_metadata(&legacy) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            let legacy_skill_exists = regular_file(&legacy.join("SKILL.md"))?;
            let version = legacy.join(".skill-version");
            let legacy_version = read_version(&version)?;
            if canonical_exists {
                // Old startup created the canonical template before migrating.
                // Merge that partial directory into the legacy one, preserving
                // resources from both. Refuse name collisions before any moves.
                let entries = fs::read_dir(canonical)
                    .map_err(|_| "Could not inspect incomplete Buzz skill")?
                    .collect::<std::io::Result<Vec<_>>>()
                    .map_err(|_| "Could not inspect incomplete Buzz skill")?;
                for entry in &entries {
                    if entry.file_name() == "SKILL.md" || entry.file_name() == ".skill-version" {
                        regular_file(&entry.path())?;
                    } else if fs::symlink_metadata(legacy.join(entry.file_name())).is_ok() {
                        return Err(
                            "Legacy and canonical Buzz skill resources conflict; left unchanged"
                                .into(),
                        );
                    }
                }
                for entry in entries {
                    if entry.file_name() == "SKILL.md" || entry.file_name() == ".skill-version" {
                        fs::remove_file(entry.path())
                            .map_err(|_| "Could not replace incomplete Buzz skill")?;
                    } else {
                        fs::rename(entry.path(), legacy.join(entry.file_name()))
                            .map_err(|_| "Could not preserve incomplete Buzz skill resources")?;
                    }
                }
                fs::remove_dir(canonical)
                    .map_err(|_| "Could not replace incomplete Buzz skill directory")?;
            }
            // Mark preserved legacy content before moving it. If startup stops
            // after the rename, the next launch still preserves those user edits.
            if legacy_skill_exists && legacy_version < CLI_SKILL_VERSION {
                atomic_write(&version, &format!("{CLI_SKILL_VERSION}\n"))?;
            }
            // Move the whole directory so supporting files and user edits survive.
            fs::rename(legacy, canonical).map_err(|_| "Could not migrate legacy Buzz skill")?;
            Ok(())
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not inspect legacy Buzz skill".into()),
    }
}

fn read_version(path: &Path) -> Result<u32> {
    if !regular_file(path)? {
        return Ok(0);
    }
    Ok(fs::read_to_string(path)
        .map_err(|_| "Could not read Buzz skill version")?
        .trim()
        .parse()
        .unwrap_or(0))
}

fn regular_file(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(true),
        Ok(_) => Err("Buzz skill content and version must be regular files".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("Could not inspect Buzz skill file".into()),
    }
}

fn atomic_write(path: &Path, content: &str) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing skill directory")?)
        .map_err(|_| "Could not prepare Buzz skill write")?;
    file.write_all(content.as_bytes())
        .map_err(|_| "Could not write Buzz skill")?;
    file.persist(path)
        .map_err(|_| "Could not install Buzz skill")?;
    Ok(())
}

#[cfg(test)]
mod tests;
