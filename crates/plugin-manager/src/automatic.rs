//! Applies version 2 managed entries that ask for `install` or `update` to be
//! automatic. Only content-pinned versions install: a URL entry's SHA-256 or a Git
//! entry's full commit. An update that changes host access or publisher is left for the
//! person's review, and a plugin Buzz installed or the person removed is never
//! installed automatically again.
use crate::{
    atomic_write, effective_grants, err,
    imports::{self, PreparedImport, RequiredCommit},
    managed::{state, Install, Managed, ManagedPlugin, ManagedSource, ManagedState, Update},
    Catalog, InstallSource, Manager, PluginInfo, Result,
};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    sync::{Arc, Mutex},
};

const RECEIPT: &str = "managed-automatic.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub name: String,
    pub revision: String,
    pub action: Action,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Installed,
    Updated,
}

/// Per app run: one apply at a time, each pinned version tried at most once, and the
/// changes made so far for Settings and the shell to report.
#[derive(Clone, Default)]
pub(crate) struct Session {
    running: Arc<Mutex<()>>,
    attempted: Arc<Mutex<HashSet<String>>>,
    changes: Arc<Mutex<Vec<Change>>>,
}
impl Session {
    pub(crate) fn changes(&self) -> Vec<Change> {
        self.changes.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Plan {
    Install,
    Update,
}

fn plan(plugin: &ManagedPlugin, installed: Option<&PluginInfo>, catalog: &Catalog) -> Option<Plan> {
    match state(plugin, catalog) {
        ManagedState::Missing if plugin.install == Install::Automatic => Some(Plan::Install),
        ManagedState::Outdated if plugin.update == Update::Automatic => Some(Plan::Update),
        // A URL entry may replace a Git install of the same plugin, as a reviewed
        // URL update can. Folder and bundled installs are never replaced.
        ManagedState::Other
            if plugin.update == Update::Automatic
                && matches!(plugin.source, ManagedSource::Url { .. })
                && installed.is_some_and(|p| {
                    p.source == "external" && matches!(p.update_source, Some(InstallSource::Git(_)))
                }) =>
        {
            Some(Plan::Update)
        }
        _ => None,
    }
}

fn pin(plugin: &ManagedPlugin) -> String {
    match &plugin.source {
        ManagedSource::Url { sha256, .. } => format!("{}@{sha256}", plugin.id),
        ManagedSource::Git { commit, path, .. } => format!("{}@{commit}:{path}", plugin.id),
    }
}

/// Whether `managed` has an automatic entry that this run has not tried yet. Cheap
/// enough to ask on every catalog read.
pub(crate) fn due(session: &Session, managed: &Managed, catalog: &Catalog) -> bool {
    let Managed::Ready { plugins, .. } = managed else {
        return false;
    };
    let Ok(attempted) = session.attempted.lock() else {
        return false;
    };
    plugins.iter().any(|entry| {
        let installed = catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == entry.plugin.id);
        plan(&entry.plugin, installed, catalog).is_some()
            && !attempted.contains(&pin(&entry.plugin))
    })
}

/// Reads the pinned version. The caller's network and Git access apply.
pub(crate) fn fetch(manager: &Manager, plugin: &ManagedPlugin) -> Result<PreparedImport> {
    match &plugin.source {
        ManagedSource::Url { url, sha256 } => {
            imports::prepare_url(url, sha256, imports::download(url)?)
        }
        ManagedSource::Git {
            repository,
            reference,
            commit,
            path,
        } => imports::prepare_git_authorized(
            repository,
            reference,
            Some(path),
            Some(RequiredCommit::parse(commit)?),
            None,
            None,
            None,
            &manager.repository_access(),
        ),
    }
}

pub(crate) fn apply(
    manager: &Manager,
    fetch: &dyn Fn(&Manager, &ManagedPlugin) -> Result<PreparedImport>,
) -> Result<Vec<Change>> {
    let session = &manager.automatic;
    let Ok(_running) = session.running.try_lock() else {
        return Ok(vec![]);
    };
    if manager.external_plugins_paused() {
        return Ok(vec![]);
    }
    let catalog = manager.catalog()?;
    let Managed::Ready { plugins, .. } = manager.managed(&catalog) else {
        return Ok(vec![]);
    };
    let mut changes = vec![];
    for entry in plugins {
        let plugin = entry.plugin;
        let installed = catalog.plugins.iter().find(|p| p.manifest.id == plugin.id);
        let Some(plan) = plan(&plugin, installed, &catalog) else {
            continue;
        };
        if !session.attempted.lock().map_err(err)?.insert(pin(&plugin)) {
            continue;
        }
        match apply_one(manager, &plugin, installed, &plan, fetch) {
            Ok(Some(change)) => changes.push(change),
            Ok(None) => {}
            Err(reason) => eprintln!("Could not apply managed plugin {}: {reason}", plugin.id),
        }
    }
    if let Ok(mut all) = session.changes.lock() {
        all.extend(changes.iter().cloned());
    }
    Ok(changes)
}

/// `None` when the pinned version must go to the person's review instead.
fn apply_one(
    manager: &Manager,
    plugin: &ManagedPlugin,
    installed: Option<&PluginInfo>,
    plan: &Plan,
    fetch: &dyn Fn(&Manager, &ManagedPlugin) -> Result<PreparedImport>,
) -> Result<Option<Change>> {
    if *plan == Plan::Install && read_receipt(manager)?.contains(&plugin.id) {
        return Ok(None);
    }
    let prepared = fetch(manager, plugin)?;
    let path = match &plugin.source {
        ManagedSource::Url { .. } => ".",
        ManagedSource::Git { path, .. } => path,
    };
    let candidate = prepared
        .preview
        .candidates
        .iter()
        .find(|c| c.path == path && c.manifest.id == plugin.id)
        .ok_or("The pinned version is not this plugin")?;
    if let (Plan::Update, Some(installed)) = (plan, installed) {
        let unchanged = effective_grants(candidate.manifest.host.clone().unwrap_or_default())
            == effective_grants(installed.manifest.host.clone().unwrap_or_default());
        if !unchanged || candidate.publisher != installed.publisher {
            return Ok(None);
        }
    }
    // A fetch can take a minute; leave the plugin alone if the person changed it meanwhile.
    let now = manager.catalog()?;
    let current = now.plugins.iter().find(|p| p.manifest.id == plugin.id);
    if current.map(|p| &p.revision) != installed.map(|p| &p.revision)
        || (*plan == Plan::Install && read_receipt(manager)?.contains(&plugin.id))
    {
        return Ok(None);
    }
    let change = Change {
        id: plugin.id.clone(),
        name: candidate.manifest.name.clone(),
        revision: candidate.revision.clone(),
        action: match plan {
            Plan::Install => Action::Installed,
            Plan::Update => Action::Updated,
        },
    };
    prepared.install(manager, &prepared.preview.token, path)?;
    if *plan == Plan::Install {
        {
            let _lock = manager.lock()?;
            remember(manager, &plugin.id)?;
        }
        if let Err(reason) = manager.change("enable", &plugin.id) {
            eprintln!(
                "Installed managed plugin {}, but could not enable it: {reason}",
                plugin.id
            );
        }
    }
    Ok(Some(change))
}

fn read_receipt(manager: &Manager) -> Result<BTreeSet<String>> {
    match fs::read(manager.root.join(RECEIPT)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(err),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(error) => Err(err(error)),
    }
}

/// Records that `id` must not be installed automatically again in this profile: Buzz
/// installed it, or the person removed it. The caller holds the registry lock.
pub(crate) fn remember(manager: &Manager, id: &str) -> Result<()> {
    let mut ids = read_receipt(manager)?;
    if !ids.insert(id.to_owned()) {
        return Ok(());
    }
    atomic_write(
        &manager.root.join(RECEIPT),
        &serde_json::to_vec(&ids).map_err(err)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{hash, imports::prepare_unsigned_artifact, managed::FILE_NAME, GitSource};
    use std::{cell::RefCell, collections::HashMap, path::Path};

    const BASE: &str = "https://plugins.example.org/";

    struct Fixture {
        home: tempfile::TempDir,
        sources: tempfile::TempDir,
        artifacts: RefCell<HashMap<String, Vec<u8>>>,
        fetched: RefCell<Vec<String>>,
    }
    impl Fixture {
        fn new() -> Self {
            Self {
                home: tempfile::tempdir().unwrap(),
                sources: tempfile::tempdir().unwrap(),
                artifacts: Default::default(),
                fetched: Default::default(),
            }
        }
        fn manager(&self) -> Manager {
            Manager::open(Some(self.home.path().to_path_buf()), "default", false).unwrap()
        }
        /// Packs a plugin and serves it; returns its URL entry fields.
        fn artifact(&self, id: &str, code: &str, host: &str) -> (String, String) {
            let dir = self.sources.path().join(hash(code.as_bytes()));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("manifest.json"),
                format!(r#"{{"id":"{id}","name":"Example {id}","apiVersion":1{host}}}"#),
            )
            .unwrap();
            fs::write(dir.join("plugin.js"), code).unwrap();
            let bytes = prepare_unsigned_artifact(&dir).unwrap();
            let sha256 = hash(&bytes);
            let url = format!("{BASE}{id}-{sha256}.json");
            self.artifacts.borrow_mut().insert(url.clone(), bytes);
            (url, sha256)
        }
        fn policy(&self, entries: &[(&str, &(String, String), &str)]) {
            let plugins = entries
                .iter()
                .map(|(id, (url, sha256), modes)| {
                    format!(r#"{{"id":"{id}","url":"{url}","sha256":"{sha256}"{modes}}}"#)
                })
                .collect::<Vec<_>>()
                .join(",");
            fs::write(
                self.home.path().join(FILE_NAME),
                format!(r#"{{"version":2,"source":"Example Org","plugins":[{plugins}]}}"#),
            )
            .unwrap();
        }
        fn apply(&self, manager: &Manager) -> Vec<Change> {
            let fetch = |_: &Manager, plugin: &ManagedPlugin| {
                let ManagedSource::Url { url, sha256 } = &plugin.source else {
                    panic!("expected a URL entry");
                };
                self.fetched.borrow_mut().push(url.clone());
                let bytes = self
                    .artifacts
                    .borrow()
                    .get(url)
                    .cloned()
                    .ok_or("HTTP 404")?;
                imports::prepare_url(url, sha256, bytes)
            };
            apply(manager, &fetch).unwrap()
        }
    }
    fn info(manager: &Manager, id: &str) -> Option<PluginInfo> {
        manager
            .catalog()
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == id)
    }
    const AUTO: &str = r#","install":"automatic","update":"automatic""#;

    #[test]
    fn installs_once_enabled_and_remembers_a_removal() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        fixture.policy(&[("example.one", &one, AUTO)]);
        let manager = fixture.manager();
        let changes = fixture.apply(&manager);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].action, Action::Installed);
        assert_eq!(changes[0].name, "Example example.one");
        let installed = info(&manager, "example.one").unwrap();
        assert!(installed.enabled);
        assert_eq!(installed.revision, one.1);
        let Managed::Ready { automatic, .. } = manager.managed(&manager.catalog().unwrap()) else {
            panic!("expected a usable policy");
        };
        assert_eq!(automatic, changes);
        assert!(fixture.apply(&manager).is_empty());

        manager.change("remove", "example.one").unwrap();
        // A later app run, with a fresh session, still leaves it removed.
        let later = fixture.manager();
        let catalog = later.catalog().unwrap();
        assert!(due(&later.automatic, &later.managed(&catalog), &catalog));
        assert!(fixture.apply(&later).is_empty());
        assert!(info(&later, "example.one").is_none());
        assert!(!due(&later.automatic, &later.managed(&catalog), &catalog));
        assert_eq!(fixture.fetched.borrow().len(), 1);
    }

    #[test]
    fn a_plugin_the_person_installed_then_removed_is_not_installed_automatically() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        fixture.policy(&[("example.one", &one, AUTO)]);
        let manager = fixture.manager();
        let bytes = fixture.artifacts.borrow()[&one.0].clone();
        let prepared = imports::prepare_url(&one.0, &one.1, bytes).unwrap();
        prepared
            .install(&manager, &prepared.preview.token, ".")
            .unwrap();
        manager.change("remove", "example.one").unwrap();
        assert!(fixture.apply(&fixture.manager()).is_empty());
        assert!(info(&manager, "example.one").is_none());
    }

    #[test]
    fn an_unreadable_record_stops_installs_but_not_updates() {
        let fixture = Fixture::new();
        let v1 = fixture.artifact("example.two", "export function apply() {} // 1", "");
        fixture.policy(&[("example.two", &v1, AUTO)]);
        fixture.apply(&fixture.manager());
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        let v2 = fixture.artifact("example.two", "export function apply() {} // 2", "");
        fixture.policy(&[("example.one", &one, AUTO), ("example.two", &v2, AUTO)]);
        fs::write(
            fixture.home.path().join("profiles/default").join(RECEIPT),
            "{",
        )
        .unwrap();
        let manager = fixture.manager();
        let changes = fixture.apply(&manager);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].action, Action::Updated);
        assert!(info(&manager, "example.one").is_none());
        let catalog = manager.catalog().unwrap();
        assert!(!due(
            &manager.automatic,
            &manager.managed(&catalog),
            &catalog
        ));
    }

    #[test]
    fn a_plugin_the_person_changes_during_the_fetch_is_left_alone() {
        let fixture = Fixture::new();
        let v1 = fixture.artifact("example.one", "export function apply() {} // 1", "");
        fixture.policy(&[("example.one", &v1, AUTO)]);
        fixture.apply(&fixture.manager());
        let v2 = fixture.artifact("example.one", "export function apply() {} // 2", "");
        fixture.policy(&[("example.one", &v2, AUTO)]);
        let manager = fixture.manager();
        let bytes = fixture.artifacts.borrow()[&v2.0].clone();
        let fetch = |manager: &Manager, _: &ManagedPlugin| {
            manager.change("remove", "example.one")?;
            imports::prepare_url(&v2.0, &v2.1, bytes.clone())
        };
        assert!(apply(&manager, &fetch).unwrap().is_empty());
        assert!(info(&manager, "example.one").is_none());
    }

    #[test]
    fn updates_to_the_pin_only_while_access_and_publisher_stay_the_same() {
        let fixture = Fixture::new();
        let v1 = fixture.artifact("example.one", "export function apply() {} // 1", "");
        fixture.policy(&[("example.one", &v1, AUTO)]);
        fixture.apply(&fixture.manager());
        let manager = fixture.manager();
        manager.change("disable", "example.one").unwrap();

        let v2 = fixture.artifact("example.one", "export function apply() {} // 2", "");
        fixture.policy(&[("example.one", &v2, AUTO)]);
        let changes = fixture.apply(&manager);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].action, Action::Updated);
        let updated = info(&manager, "example.one").unwrap();
        assert_eq!(updated.revision, v2.1);
        assert!(!updated.enabled, "an update keeps the enabled state");

        let wider = fixture.artifact(
            "example.one",
            "export function apply() {} // 3",
            r#","host":{"files":true}"#,
        );
        fixture.policy(&[("example.one", &wider, AUTO)]);
        assert!(fixture.apply(&manager).is_empty());
        assert_eq!(info(&manager, "example.one").unwrap().revision, v2.1);
        let catalog = manager.catalog().unwrap();
        let Managed::Ready { plugins, .. } = manager.managed(&catalog) else {
            panic!("expected a usable policy");
        };
        assert_eq!(plugins[0].state, ManagedState::Outdated, "left for review");
        assert!(!due(
            &manager.automatic,
            &manager.managed(&catalog),
            &catalog
        ));
    }

    #[test]
    fn review_entries_and_manual_installs_are_left_alone() {
        let fixture = Fixture::new();
        let one = fixture.artifact("example.one", "export function apply() {}", "");
        let two = fixture.artifact("example.two", "export function apply() {}", "");
        fixture.policy(&[
            ("example.one", &one, ""),
            (
                "example.two",
                &two,
                r#","install":"manual","update":"automatic""#,
            ),
        ]);
        let manager = fixture.manager();
        assert!(fixture.apply(&manager).is_empty());
        assert!(fixture.fetched.borrow().is_empty());
        assert!(info(&manager, "example.one").is_none());
        assert!(info(&manager, "example.two").is_none());
    }

    #[test]
    fn a_failed_pin_is_tried_once_per_run() {
        let fixture = Fixture::new();
        let missing = (format!("{BASE}gone.json"), "a".repeat(64));
        fixture.policy(&[("example.one", &missing, AUTO)]);
        let manager = fixture.manager();
        assert!(fixture.apply(&manager).is_empty());
        assert!(fixture.apply(&manager).is_empty());
        assert_eq!(fixture.fetched.borrow().len(), 1);
        assert!(fixture.apply(&fixture.manager()).is_empty());
        assert_eq!(fixture.fetched.borrow().len(), 2, "a new run tries again");
        assert!(!fs::exists(manager.root.join(RECEIPT)).unwrap());
    }

    #[test]
    fn a_publisher_change_is_left_for_review() {
        let fixture = Fixture::new();
        let v1 = fixture.artifact("example.one", "export function apply() {} // 1", "");
        fixture.policy(&[("example.one", &v1, AUTO)]);
        let manager = fixture.manager();
        fixture.apply(&manager);
        let signed = fixture.sources.path().join("signed");
        fs::create_dir_all(&signed).unwrap();
        fs::write(
            signed.join("manifest.json"),
            r#"{"id":"example.one","name":"Example example.one","apiVersion":1}"#,
        )
        .unwrap();
        fs::write(signed.join("plugin.js"), "export function apply() {} // 2").unwrap();
        crate::sign_release(&signed, &"01".repeat(32)).unwrap();
        let v2 = (format!("{BASE}signed.json"), "b".repeat(64));
        fixture.policy(&[("example.one", &v2, AUTO)]);
        let fetch = |_: &Manager, _: &ManagedPlugin| imports::prepare_folder(Path::new(&signed));
        assert!(apply(&manager, &fetch).unwrap().is_empty());
        assert_eq!(info(&manager, "example.one").unwrap().revision, v1.1);
    }

    fn installed(id: &str, origin: &'static str, source: Option<InstallSource>) -> PluginInfo {
        let mut info = crate::managed::tests::installed(id, source, origin);
        info.revision = "0".repeat(64);
        info
    }

    #[test]
    fn a_url_entry_may_replace_a_git_install_but_never_a_folder_or_bundled_one() {
        let url = ManagedPlugin {
            id: "example.one".into(),
            source: ManagedSource::Url {
                url: format!("{BASE}one.json"),
                sha256: "a".repeat(64),
            },
            install: Install::Recommend,
            update: Update::Automatic,
        };
        let git = Some(InstallSource::Git(GitSource {
            repository: "https://github.com/example-org/plugins".into(),
            reference: "main".into(),
            path: ".".into(),
            commit: None,
        }));
        let folder = Some(InstallSource::Folder(
            crate::ReloadSource::folder(std::env::temp_dir(), ".".into()).unwrap(),
        ));
        for (origin, source, expected) in [
            ("external", git.clone(), Some(Plan::Update)),
            ("external", folder, None),
            ("external", None, None),
            ("bundled", git, None),
        ] {
            let plugin = installed("example.one", origin, source);
            let catalog = Catalog {
                profile: "default".into(),
                location: String::new(),
                plugins: vec![plugin],
            };
            assert_eq!(plan(&url, catalog.plugins.first(), &catalog), expected);
        }
        let review = ManagedPlugin {
            update: Update::Review,
            ..url
        };
        let catalog = Catalog {
            profile: "default".into(),
            location: String::new(),
            plugins: vec![installed(
                "example.one",
                "external",
                Some(InstallSource::Url(crate::UrlSource {
                    url: format!("{BASE}old.json"),
                    sha256: "b".repeat(64),
                })),
            )],
        };
        assert_eq!(plan(&review, catalog.plugins.first(), &catalog), None);
    }
}
