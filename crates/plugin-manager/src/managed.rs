//! Managed plugin sources: a JSON policy that an external tool writes next to the
//! profile folders. It only recommends sources; every install still goes through
//! the Git import and its access review.
use crate::{
    err, imports::repository_url, is_reserved, valid_id, validate_candidate_path, Catalog,
    InstallSource, Result,
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    ffi::OsString,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

pub const FILE_NAME: &str = "managed-plugins.json";
pub const PATH_ENV: &str = "BUZZ_MANAGED_PLUGINS";
const MAX_BYTES: u64 = 256 * 1024;
const MAX_PLUGINS: usize = 64;
const MAX_PROBLEMS: usize = 16;
const MAX_SOURCE_CHARS: usize = 80;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPlugin {
    pub id: String,
    pub repository: String,
    pub reference: String,
    pub commit: String,
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedState {
    /// Not installed: the user can review and install it.
    Missing,
    /// Installed from this repository at the pinned commit and path.
    Current,
    /// Installed from this repository, but not at the pinned commit or path.
    Outdated,
    /// Installed from a folder, an unrecorded source, another repository or with Buzz itself.
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedEntry {
    #[serde(flatten)]
    pub plugin: ManagedPlugin,
    pub state: ManagedState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub source: String,
    pub plugins: Vec<ManagedPlugin>,
    pub problems: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Default)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Managed {
    #[default]
    Absent,
    /// The file as a whole cannot be used; nothing is recommended.
    Invalid { path: String, reason: String },
    /// Usable entries, plus a report for each one that was ignored.
    Ready {
        path: String,
        source: String,
        plugins: Vec<ManagedEntry>,
        problems: Vec<String>,
    },
}
impl Managed {
    pub fn is_absent(&self) -> bool {
        matches!(self, Managed::Absent)
    }
}

/// `BUZZ_MANAGED_PLUGINS` when set, otherwise the file beside the profile folders.
pub fn path(home: &Path, env: Option<OsString>) -> Result<PathBuf> {
    match env.filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                Ok(path)
            } else {
                Err(format!("{PATH_ENV} must be an absolute path"))
            }
        }
        None => Ok(home.join(FILE_NAME)),
    }
}

pub fn status(path: Result<PathBuf>, catalog: &Catalog) -> Managed {
    let path = match path {
        Ok(path) => path,
        Err(reason) => {
            return Managed::Invalid {
                path: String::new(),
                reason,
            }
        }
    };
    let shown = path.display().to_string();
    let text = match read(&path) {
        Ok(Some(text)) => text,
        Ok(None) => return Managed::Absent,
        Err(reason) => {
            return Managed::Invalid {
                path: shown,
                reason,
            }
        }
    };
    match parse(&text) {
        Ok(policy) => Managed::Ready {
            path: shown,
            source: policy.source,
            plugins: policy
                .plugins
                .into_iter()
                .map(|plugin| {
                    let state = state(&plugin, catalog);
                    ManagedEntry { plugin, state }
                })
                .collect(),
            problems: policy.problems,
        },
        Err(reason) => Managed::Invalid {
            path: shown,
            reason,
        },
    }
}

fn read(path: &Path) -> Result<Option<String>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(err(error)),
    };
    if !file.metadata().map_err(err)?.is_file() {
        return Err("Managed plugin file must be a regular file".into());
    }
    let mut bytes = vec![];
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Managed plugin file exceeds 256 KiB".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Managed plugin file must be UTF-8".into())
}

pub fn parse(text: &str) -> Result<Policy> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {e}"))?;
    let Value::Object(mut root) = value else {
        return Err("Expected a JSON object".into());
    };
    match root.remove("version") {
        Some(Value::Number(version)) if version.as_u64() == Some(1) => {}
        Some(_) => return Err("Unsupported version; this Buzz reads version 1".into()),
        None => return Err("Missing version".into()),
    }
    let source = match root.remove("source") {
        Some(Value::String(source)) => source.trim().to_owned(),
        _ => return Err("source must be a display name".into()),
    };
    if source.is_empty()
        || source.chars().count() > MAX_SOURCE_CHARS
        || source.chars().any(char::is_control)
    {
        return Err(format!(
            "source must be 1 to {MAX_SOURCE_CHARS} characters without control characters"
        ));
    }
    let Some(Value::Array(entries)) = root.remove("plugins") else {
        return Err("plugins must be an array".into());
    };
    if let Some(unknown) = root.keys().next() {
        return Err(format!("Unknown field {unknown:?}"));
    }
    let mut problems = vec![];
    let mut report = |message: String| {
        if problems.len() < MAX_PROBLEMS {
            problems.push(message);
        }
    };
    if entries.len() > MAX_PLUGINS {
        report(format!(
            "Only the first {MAX_PLUGINS} of {} plugins are used",
            entries.len()
        ));
    }
    let mut plugins = vec![];
    let mut seen = HashSet::new();
    for (index, entry) in entries.into_iter().take(MAX_PLUGINS).enumerate() {
        match entry_plugin(entry) {
            Ok(plugin) if seen.insert(plugin.id.clone()) => plugins.push(plugin),
            Ok(plugin) => report(format!(
                "Plugin {}: {:?} is listed more than once; only the first entry is used",
                index + 1,
                plugin.id
            )),
            Err(reason) => report(format!("Plugin {}: {reason}", index + 1)),
        }
    }
    Ok(Policy {
        source,
        plugins,
        problems,
    })
}

fn entry_plugin(entry: Value) -> Result<ManagedPlugin> {
    let Value::Object(mut entry) = entry else {
        return Err("expected an object".into());
    };
    let id = text(&mut entry, "id")?;
    valid_id(&id)?;
    if is_reserved(&id) {
        return Err(format!("{id:?} is included with Buzz"));
    }
    let repository = repository_url(&text(&mut entry, "repository")?)?;
    let reference = text(&mut entry, "reference")?;
    if !valid_reference(&reference) {
        return Err("reference must be a branch or tag name".into());
    }
    let commit = text(&mut entry, "commit")?.to_ascii_lowercase();
    if !valid_commit(&commit) {
        return Err("commit must be a full 40 or 64 digit hexadecimal object ID".into());
    }
    let path = match entry.remove("path") {
        None => ".".to_owned(),
        Some(Value::String(path)) => {
            validate_candidate_path(&path)?;
            path
        }
        Some(_) => return Err("path must be a string".into()),
    };
    if let Some(unknown) = entry.keys().next() {
        return Err(format!("unknown field {unknown:?}"));
    }
    Ok(ManagedPlugin {
        id,
        repository,
        reference,
        commit,
        path,
    })
}

fn text(entry: &mut Map<String, Value>, key: &str) -> Result<String> {
    match entry.remove(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(value.trim().to_owned()),
        _ => Err(format!("{key} is required and must be a string")),
    }
}

pub fn valid_reference(reference: &str) -> bool {
    !reference.is_empty()
        && !reference.starts_with('-')
        && reference.len() <= 200
        && reference
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c))
}

pub fn valid_commit(commit: &str) -> bool {
    matches!(commit.len(), 40 | 64) && commit.bytes().all(|c| c.is_ascii_hexdigit())
}

fn same_repository(a: &str, b: &str) -> bool {
    let canonical = |url: &str| {
        let url = url.trim_end_matches('/');
        url.strip_suffix(".git").unwrap_or(url).to_owned()
    };
    canonical(a) == canonical(b)
}

fn state(plugin: &ManagedPlugin, catalog: &Catalog) -> ManagedState {
    let Some(installed) = catalog
        .plugins
        .iter()
        .find(|installed| installed.manifest.id == plugin.id)
    else {
        return ManagedState::Missing;
    };
    match &installed.update_source {
        Some(InstallSource::Git(source))
            if installed.source == "external"
                && same_repository(&source.repository, &plugin.repository) =>
        {
            let pinned = source
                .commit
                .as_deref()
                .is_some_and(|commit| commit.eq_ignore_ascii_case(&plugin.commit));
            if pinned && source.path == plugin.path {
                ManagedState::Current
            } else {
                ManagedState::Outdated
            }
        }
        _ => ManagedState::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GitSource, Manifest, PluginInfo};
    use std::fs;

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

    fn entry(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","repository":"https://github.com/acme/plugins","reference":"v1","commit":"{COMMIT}","path":"dist/{id}"}}"#
        )
    }
    fn policy(plugins: &[String]) -> String {
        format!(
            r#"{{"version":1,"source":"Acme IT","plugins":[{}]}}"#,
            plugins.join(",")
        )
    }
    fn installed(id: &str, source: Option<InstallSource>, origin: &'static str) -> PluginInfo {
        PluginInfo {
            manifest: Manifest {
                id: id.into(),
                name: id.into(),
                api_version: 1,
                description: None,
                discovery: None,
                host: None,
            },
            source: origin,
            enabled: false,
            revision: "0".repeat(64),
            previous: None,
            has_signature: false,
            rollback_blocked_reason: None,
            reloadable: false,
            update_source: source,
            error: None,
            publisher: None,
            readme_revision: None,
            icon_png_revision: None,
            icon_jpg_revision: None,
        }
    }
    fn git(repository: &str, commit: Option<&str>, path: &str) -> Option<InstallSource> {
        Some(InstallSource::Git(GitSource {
            repository: repository.into(),
            reference: "v1".into(),
            path: path.into(),
            commit: commit.map(Into::into),
        }))
    }
    fn catalog(plugins: Vec<PluginInfo>) -> Catalog {
        Catalog {
            profile: "test".into(),
            location: "test".into(),
            plugins,
        }
    }

    #[test]
    fn parses_a_valid_policy_and_normalizes_entries() {
        let text = format!(
            r#"{{"version":1,"source":"  Acme IT ","plugins":[
                {{"id":"acme.one","repository":"acme/plugins","reference":"main","commit":"{}"}},
                {}
            ]}}"#,
            COMMIT.to_uppercase(),
            entry("acme.two")
        );
        let parsed = parse(&text).unwrap();
        assert_eq!(parsed.source, "Acme IT");
        assert!(parsed.problems.is_empty());
        assert_eq!(parsed.plugins.len(), 2);
        let first = &parsed.plugins[0];
        assert_eq!(first.repository, "https://github.com/acme/plugins");
        assert_eq!(first.commit, COMMIT);
        assert_eq!(first.path, ".");
        assert_eq!(parsed.plugins[1].path, "dist/acme.two");
        let sha256 = "a".repeat(64);
        let long = policy(&[entry("acme.three").replace(COMMIT, &sha256)]);
        assert_eq!(parse(&long).unwrap().plugins[0].commit, sha256);
    }

    #[test]
    fn rejects_unusable_files_as_a_whole() {
        for (text, reason) in [
            ("", "Invalid JSON"),
            ("[]", "Expected a JSON object"),
            (r#"{"source":"A","plugins":[]}"#, "Missing version"),
            (
                r#"{"version":2,"source":"A","plugins":[]}"#,
                "Unsupported version",
            ),
            (
                r#"{"version":"1","source":"A","plugins":[]}"#,
                "Unsupported",
            ),
            (r#"{"version":1,"plugins":[]}"#, "source"),
            (r#"{"version":1,"source":"  ","plugins":[]}"#, "source"),
            (r#"{"version":1,"source":"a\nb","plugins":[]}"#, "source"),
            (r#"{"version":1,"source":"A"}"#, "plugins must be an array"),
            (
                r#"{"version":1,"source":"A","plugins":{}}"#,
                "plugins must be an array",
            ),
            (
                r#"{"version":1,"source":"A","plugins":[],"extra":1}"#,
                "Unknown field",
            ),
        ] {
            let error = parse(text).unwrap_err();
            assert!(error.contains(reason), "{text:?} gave {error:?}");
        }
        let long = format!(
            r#"{{"version":1,"source":"{}","plugins":[]}}"#,
            "x".repeat(81)
        );
        assert!(parse(&long).is_err());
    }

    #[test]
    fn ignores_invalid_entries_and_reports_each() {
        let sha = |len| "b".repeat(len);
        let bad = [
            r#"[]"#.to_owned(),
            r#"{}"#.to_owned(),
            entry("Not_Valid"),
            entry("buzz.channels"),
            entry("acme.one").replace("https://github.com/acme/plugins", "/tmp/local"),
            entry("acme.one").replace("https://github.com/acme/plugins", "http://example.com/a"),
            entry("acme.one").replace(r#""reference":"v1""#, r#""reference":"-x""#),
            entry("acme.one").replace(r#""reference":"v1""#, r#""reference":"a b""#),
            entry("acme.one").replace(COMMIT, "main"),
            entry("acme.one").replace(COMMIT, &sha(39)),
            entry("acme.one").replace(COMMIT, &sha(41)),
            entry("acme.one").replace(COMMIT, &"g".repeat(40)),
            entry("acme.one").replace(r#""path":"dist/acme.one""#, r#""path":"../x""#),
            entry("acme.one").replace(r#""path":"dist/acme.one""#, r#""path":"/abs""#),
            entry("acme.one").replace(r#""path":"dist/acme.one""#, r#""path":7"#),
            entry("acme.one").replace(r#""path""#, r#""extra":1,"path""#),
            entry("acme.one").replace(r#""id":"acme.one","#, ""),
        ];
        let mut all = bad.to_vec();
        all.push(entry("acme.ok"));
        let parsed = parse(&policy(&all)).unwrap();
        assert_eq!(parsed.plugins.len(), 1);
        assert_eq!(parsed.plugins[0].id, "acme.ok");
        assert_eq!(parsed.problems.len(), bad.len().min(MAX_PROBLEMS));
        assert!(parsed.problems[0].starts_with("Plugin 1: "));
        assert!(parsed.problems[3].contains("included with Buzz"));
    }

    #[test]
    fn keeps_the_first_duplicate_and_bounds_the_list() {
        let first = entry("acme.one");
        let second = entry("acme.one").replace("v1", "v2");
        let parsed = parse(&policy(&[first, second])).unwrap();
        assert_eq!(parsed.plugins.len(), 1);
        assert_eq!(parsed.plugins[0].reference, "v1");
        assert!(parsed.problems[0].contains("more than once"));

        let many: Vec<String> = (0..MAX_PLUGINS + 3)
            .map(|i| entry(&format!("acme.p{i}")))
            .collect();
        let parsed = parse(&policy(&many)).unwrap();
        assert_eq!(parsed.plugins.len(), MAX_PLUGINS);
        assert!(parsed.problems[0].contains("Only the first 64"));
    }

    #[test]
    fn locates_the_file_beside_profiles_unless_overridden() {
        let home = Path::new("/data/xyz.block.buzz.desktop");
        assert_eq!(path(home, None).unwrap(), home.join("managed-plugins.json"));
        assert_eq!(
            path(home, Some("".into())).unwrap(),
            home.join("managed-plugins.json")
        );
        #[cfg(unix)]
        {
            assert_eq!(
                path(home, Some("/etc/buzz/policy.json".into())).unwrap(),
                Path::new("/etc/buzz/policy.json")
            );
            assert!(path(home, Some("relative.json".into())).is_err());
        }
    }

    #[test]
    fn reads_absent_invalid_and_oversized_files_without_failing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE_NAME);
        let empty = catalog(vec![]);
        assert_eq!(status(Ok(file.clone()), &empty), Managed::Absent);

        fs::write(&file, "{").unwrap();
        let Managed::Invalid { reason, .. } = status(Ok(file.clone()), &empty) else {
            panic!("expected invalid");
        };
        assert!(reason.contains("Invalid JSON"));

        fs::write(&file, vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        let Managed::Invalid { reason, .. } = status(Ok(file.clone()), &empty) else {
            panic!("expected invalid");
        };
        assert!(reason.contains("256 KiB"));

        fs::write(&file, [0xff, 0xfe]).unwrap();
        assert!(matches!(
            status(Ok(file.clone()), &empty),
            Managed::Invalid { .. }
        ));

        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        assert!(matches!(status(Ok(file), &empty), Managed::Invalid { .. }));

        assert!(matches!(
            status(Err("bad".into()), &empty),
            Managed::Invalid { .. }
        ));
    }

    #[test]
    fn compares_each_entry_with_the_installed_source() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE_NAME);
        let ids = [
            "acme.missing",
            "acme.current",
            "acme.moved",
            "acme.legacy",
            "acme.path",
            "acme.fork",
            "acme.folder",
            "acme.bundled",
        ];
        fs::write(
            &file,
            policy(&ids.map(entry).into_iter().collect::<Vec<_>>()),
        )
        .unwrap();
        let repo = "https://github.com/acme/plugins.git/";
        let other = "0123456789abcdef0123456789abcdef01234568";
        let installed = catalog(vec![
            installed(
                "acme.current",
                git(repo, Some(&COMMIT.to_uppercase()), "dist/acme.current"),
                "external",
            ),
            installed(
                "acme.moved",
                git(repo, Some(other), "dist/acme.moved"),
                "external",
            ),
            installed(
                "acme.legacy",
                git(repo, None, "dist/acme.legacy"),
                "external",
            ),
            installed(
                "acme.path",
                git(repo, Some(COMMIT), "elsewhere"),
                "external",
            ),
            installed(
                "acme.fork",
                git(
                    "https://github.com/someone/plugins",
                    Some(COMMIT),
                    "dist/acme.fork",
                ),
                "external",
            ),
            installed("acme.folder", None, "external"),
            installed("acme.bundled", None, "bundled"),
        ]);
        let Managed::Ready {
            source,
            plugins,
            problems,
            ..
        } = status(Ok(file), &installed)
        else {
            panic!("expected a usable policy");
        };
        assert_eq!(source, "Acme IT");
        assert!(problems.is_empty());
        use ManagedState::*;
        assert_eq!(
            plugins.iter().map(|entry| entry.state).collect::<Vec<_>>(),
            [Missing, Current, Outdated, Outdated, Outdated, Other, Other, Other]
        );
    }

    #[test]
    fn serializes_for_the_frontend() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE_NAME);
        fs::write(&file, policy(&[entry("acme.one")])).unwrap();
        let json = serde_json::to_value(status(Ok(file), &catalog(vec![]))).unwrap();
        assert_eq!(json["status"], "ready");
        assert_eq!(json["source"], "Acme IT");
        assert_eq!(json["plugins"][0]["id"], "acme.one");
        assert_eq!(json["plugins"][0]["state"], "missing");
        assert_eq!(json["plugins"][0]["commit"], COMMIT);
        assert_eq!(json["problems"], serde_json::json!([]));
    }
}
