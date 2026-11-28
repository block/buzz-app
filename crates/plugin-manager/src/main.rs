use buzzodz_plugins::{
    automatic::Action,
    managed::{Install, Managed, ManagedSource, ManagedState, Update},
    pack_release, release_manifest,
    secrets::{CleanupStatus, CLEANUP_BUDGET},
    sign_policy, sign_release_saved,
    trust::{self, Publisher, Trust},
    valid_id, Catalog, Manager, Manifest, Result,
};
use serde_json::json;
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const HELP: &str = "buzzodz [--home ABSOLUTE_PATH] [--profile NAME] plugin COMMAND

Commands:
  init DIRECTORY ID NAME   Create a page-plugin source project
  build DIRECTORY          Run the project's pnpm build script
  sign DIST_DIRECTORY       Sign with your saved Buzz human identity
  pack DIST_DIRECTORY FILE  Write the single-file artifact a URL source serves; prints its SHA-256
  sign-policy FILE         Sign a managed plugin policy with the key in
                           BUZZ_MANAGED_PLUGINS_SIGNING_KEY; writes FILE.sig
  install DIRECTORY        Install a plugin (new plugins start disabled)
  reload ID                Reload a folder plugin, preserving its enabled state
  list                     List pages and aggregate saved-credential cleanup
  cleanup-retry            Attempt one bounded saved-credential cleanup batch
  managed [--apply]        Show the managed plugin sources policy and its status;
                           --apply first installs and updates its automatic entries
  access [URL]             Show repository access rules and how Git would read URL
  trust                    Show trusted publishers and whether self-developed plugins run
  trust add PUBLISHER [NAME]  Trust a publisher key (npub or hex); the first one turns on
                           the trusted-publisher restriction
  trust remove PUBLISHER   Stop trusting a publisher key
  trust self-developed on|off  Allow plugins signed with your saved Buzz human identity
  enable ID | disable ID | remove ID | rollback ID
  recover                  Back up settings and reset to bundled defaults

Options:
  --home PATH              Plugin data directory (absolute path)
  --profile NAME           Local profile (default: default)
  --help, -h               Show this help

Saved-credential cleanup:
  list never reads saved plugin credentials or retries their deletion. With
  self-developed trust on, a plugin signed by an unlisted publisher makes it
  read your saved Buzz identity, which secure storage may prompt for.
  Aggregate status remains visible after the plugin row has been removed.
  Pending, running, or unknown cleanup makes list exit nonzero.
  An unconfigured backend with no tracked history is not observed, not clean.
  cleanup-retry is explicit; there is no automatic retry or status alias.
  remove and recover save the plugin change before attempting cleanup.
  Their mutation output is separate from the saved-credential cleanup result.
  A saved change exits zero unless the mutation reported a problem; unconfirmed
  cleanup after it is a separate warning, not confirmed deletion.
  cleanup-retry exits nonzero unless its batch is confirmed complete.
  Each attempt waits at most 30 seconds; timeout is not OS cancellation.
  Process exit or a timed-out wait does not prove credentials were deleted.
  Durable pending records remain until actual deletion is confirmed.
  If a native sign-out is unfinished, open Buzz to complete it first.
  CLI cleanup cannot clear that journal or finish native sign-out itself.
  CLI management never enrolls credentials or records native boot observations.
  Arbitrary --home paths are outside the desktop's fixed sign-out scan.
  That scan does not exclude latent CLI writers or prove maintained absence.
  Live secure-storage backend selection remains unavailable in this CLI.

The desktop and CLI also read BUZZODZ_HOME and BUZZODZ_PROFILE.
BUZZ_MANAGED_PLUGINS overrides the managed plugin policy file location.
BUZZ_REPOSITORY_ACCESS overrides the repository access rules file location.
BUZZ_PLUGIN_TRUST overrides the plugin trust file location.
Set BUZZ_REQUIRE_PLUGIN_SIGNATURES=1 when launching the desktop or CLI to require
signed plugins. Enforcement is off by default; supplied signatures are always verified.
Launch the desktop with BUZZODZ_SAFE_MODE=1 to skip external pages.";

fn main() {
    if let Err(message) = run() {
        eprintln!("Error: {message}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{HELP}");
        return Ok(());
    }
    let mut home = None;
    let mut profile = std::env::var("BUZZODZ_PROFILE").unwrap_or_else(|_| "default".into());
    while args.first().is_some_and(|s| s.starts_with("--")) {
        let flag = args.remove(0);
        if args.is_empty() {
            return Err(format!("{flag} requires a value. See buzzodz --help."));
        }
        let value = args.remove(0);
        match flag.as_str() {
            "--home" => home = Some(PathBuf::from(value)),
            "--profile" => profile = value,
            _ => return Err(format!("Unknown option {flag}. See buzzodz --help.")),
        }
    }
    if args.first().map(String::as_str) != Some("plugin") || args.len() < 2 {
        return Err("Expected plugin COMMAND. See buzzodz --help.".into());
    }
    let action = &args[1];
    let rest = &args[2..];
    // Source creation/building does not require a local installation profile.
    match (action.as_str(), rest) {
        ("init", [directory, id, name]) => {
            init(Path::new(directory), id, name)?;
            println!("Created {id} in {directory}\nNext: add the host-matched @buzz/author preview archive with pnpm add -D /absolute/path/buzz-author-VERSION.tgz, then buzzodz plugin build DIRECTORY.");
            return Ok(());
        }
        ("build", [directory]) => {
            build(Path::new(directory))?;
            let dist = Path::new(directory).join("dist");
            println!(
                "Built {}\nNext: buzzodz plugin sign {}",
                dist.display(),
                dist.display()
            );
            return Ok(());
        }
        ("sign", [directory]) => {
            let publisher = sign_release_saved(Path::new(directory))?;
            println!("Signed release in {directory} by {publisher}");
            return Ok(());
        }
        ("sign", _) => return Err("Usage: buzzodz plugin sign DIST_DIRECTORY".into()),
        ("pack", [directory, file]) => {
            let (manifest, bytes, digest) = pack_release(Path::new(directory))?;
            std::fs::write(file, bytes).map_err(|e| e.to_string())?;
            println!(
                "{}",
                json!({"id": manifest.id, "file": file, "sha256": digest})
            );
            return Ok(());
        }
        ("pack", _) => return Err("Usage: buzzodz plugin pack DIST_DIRECTORY FILE".into()),
        ("sign-policy", [file]) => {
            let key = std::env::var("BUZZ_MANAGED_PLUGINS_SIGNING_KEY")
                .map_err(|_| "Set BUZZ_MANAGED_PLUGINS_SIGNING_KEY to the signing key")?;
            let signer = sign_policy(Path::new(file), &key)?;
            println!(
                "{}",
                json!({"signature": format!("{file}.sig"), "signer": signer})
            );
            return Ok(());
        }
        ("sign-policy", _) => return Err("Usage: buzzodz plugin sign-policy FILE".into()),
        _ => {}
    }
    let manager = Manager::open(home, &profile, false)?;
    if let Some(result) = dispatch(
        &manager,
        action,
        rest,
        &profile,
        &mut std::io::stdout(),
        CLEANUP_BUDGET,
    ) {
        return result;
    }
    match (action.as_str(), rest) {
        ("install", [directory]) => {
            let manifest = release_manifest(Path::new(directory))?;
            let catalog = manager.install(Path::new(directory))?;
            let installed = catalog
                .plugins
                .iter()
                .find(|p| p.manifest.id == manifest.id)
                .ok_or("Installed plugin missing from catalog")?;
            println!(
                "Installed {} ({}) in profile {profile}. Publisher: {}",
                installed.manifest.id,
                if installed.enabled {
                    "enabled"
                } else {
                    "disabled"
                },
                installed.publisher.as_deref().unwrap_or("unsigned")
            );
        }
        ("reload", [id]) => {
            let before = manager.catalog()?;
            let after = manager.reload_live(id)?;
            for (label, catalog) in [
                ("Previous host access", &before),
                ("Updated host access", &after),
            ] {
                let grants = catalog
                    .plugins
                    .iter()
                    .find(|p| p.manifest.id == *id)
                    .and_then(|p| p.manifest.host.as_ref());
                println!(
                    "{label}: {}",
                    serde_json::to_string_pretty(&grants).map_err(|e| e.to_string())?
                );
            }
            println!("Reloaded {id} in profile {profile}. The running app picks up changed builds automatically.");
        }
        ("reload", _) => return Err("Usage: buzzodz plugin reload ID".into()),
        ("managed", []) => print_managed(&manager.managed(&manager.catalog()?)),
        ("managed", [flag]) if flag == "--apply" => {
            manager.apply_automatic()?;
            print_managed(&manager.managed(&manager.catalog()?));
        }
        ("access", [] | [_]) => {
            let home = dirs::home_dir().ok_or("Cannot find the home directory")?;
            print!(
                "{}",
                manager
                    .repository_access()
                    .describe(rest.first().map(String::as_str), &home)?
            );
        }
        ("access", _) => return Err("Usage: buzzodz plugin access [URL]".into()),
        ("trust", []) => print_trust(&manager.trust()),
        ("trust", [command, rest @ ..]) => {
            match (command.as_str(), rest) {
                ("add", [publisher] | [publisher, _]) => {
                    let publisher = trust::parse_publisher(publisher)?;
                    let name = rest.get(1).map(|name| trust::valid_name(name)).transpose()?;
                    manager.trust().update(|policy| {
                        match policy.publishers.iter_mut().find(|p| p.publisher == publisher) {
                            Some(existing) => {
                                if name.is_some() {
                                    existing.name = name;
                                }
                            }
                            None => policy.publishers.push(Publisher { publisher, name }),
                        }
                        Ok(())
                    })?
                }
                ("remove", [publisher]) => {
                    let publisher = trust::parse_publisher(publisher)?;
                    manager.trust().update(|policy| {
                        let before = policy.publishers.len();
                        policy.publishers.retain(|p| p.publisher != publisher);
                        if policy.publishers.len() == before {
                            return Err(format!("{publisher} is not a trusted publisher"));
                        }
                        Ok(())
                    })?
                }
                ("self-developed", [value]) if value == "on" || value == "off" => manager
                    .trust()
                    .update(|policy| {
                        policy.allow_self_developed = value == "on";
                        Ok(())
                    })?,
                _ => return Err("Usage: buzzodz plugin trust [add PUBLISHER [NAME] | remove PUBLISHER | self-developed on|off]".into()),
            };
            print_trust(&manager.trust());
            let blocked: Vec<_> = manager
                .catalog()?
                .plugins
                .into_iter()
                .filter(|p| p.source == "external" && p.error.is_some())
                .collect();
            if !blocked.is_empty() {
                println!("\nInstalled plugins that cannot run:");
                for plugin in blocked {
                    println!(
                        "{:<24} {}",
                        plugin.manifest.id,
                        plugin.error.unwrap_or_default()
                    );
                }
            }
        }
        ("enable" | "disable" | "rollback", [id]) => {
            manager.change(action, id)?;
            let verb = match action.as_str() {
                "enable" => "Enabled",
                "disable" => "Disabled",
                _ => "Rolled back",
            };
            println!("{verb} {id} in profile {profile}.");
        }
        _ => {
            return Err(format!(
                "Unknown command or incorrect arguments: plugin {}. See buzzodz --help.",
                args[1..].join(" ")
            ))
        }
    }
    Ok(())
}
pub(crate) fn dispatch(
    manager: &Manager,
    action: &str,
    rest: &[String],
    profile: &str,
    out: &mut dyn Write,
    budget: Duration,
) -> Option<Result<()>> {
    if !matches!(
        (action, rest),
        ("list" | "recover" | "cleanup-retry", []) | ("remove", [_])
    ) {
        return None;
    }
    Some((|| {
        if action == "list" {
            print_catalog(&manager.catalog()?, out)?;
            return print_cleanup(
                manager
                    .credential_cleanup_observation()
                    .map_err(|_| CLEANUP_UNKNOWN)?,
                out,
            );
        }
        let outcome = match (action, rest) {
            ("recover", []) => manager.recover_managed()?,
            ("remove", [id]) => manager.change_managed("remove", id)?,
            _ => return wait_cleanup(manager, out, budget),
        };
        if !outcome.committed {
            return Err("Plugin change outcome is unknown; refresh before trying again".into());
        }
        if action == "remove" {
            writeln!(out, "Removed {} in profile {profile}.", rest[0])
                .map_err(|e| e.to_string())?;
        } else {
            writeln!(out, "Reset profile {profile} to bundled defaults.")
                .map_err(|e| e.to_string())?;
            if let Some(catalog) = &outcome.catalog {
                writeln!(out, "Any previous settings were backed up in {}.\nExternal artifacts remain available for reinstallation.", catalog.location).map_err(|e| e.to_string())?;
            }
        }
        if let Some(problem) = outcome.problem {
            writeln!(out, "{problem}").map_err(|e| e.to_string())?;
        }
        // The change is saved: cleanup this CLI can't confirm is a separate
        // warning, never a failed change or a confirmed deletion.
        if let Err(cleanup) = wait_cleanup(manager, out, budget) {
            eprintln!("Warning: {cleanup}");
        }
        outcome
            .problem
            .map_or(Ok(()), |problem| Err(problem.into()))
    })())
}
const CLEANUP_UNKNOWN: &str = "Saved credential cleanup is incomplete/unknown — not confirmed. If a sign-out is still finishing, open Buzz to complete it first.";
fn wait_cleanup(manager: &Manager, out: &mut dyn Write, budget: Duration) -> Result<()> {
    let manager = manager.clone();
    let budget = budget.min(CLEANUP_BUDGET);
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("plugin credential cleanup".into())
        .spawn(move || {
            let _ = send.send(
                manager
                    .credential_cleanup(budget)
                    .and_then(|_| manager.credential_cleanup_observation()),
            );
        })
        .map_err(|_| CLEANUP_UNKNOWN)?;
    // Only the caller wait ends: the worker keeps shared ownership and never prints.
    let status = receive
        .recv_timeout(budget)
        .map_err(|_| CLEANUP_UNKNOWN)?
        .map_err(|_| CLEANUP_UNKNOWN)?;
    print_cleanup(Some(status.ok_or(CLEANUP_UNKNOWN)?), out)
}
fn print_cleanup(status: Option<CleanupStatus>, out: &mut dyn Write) -> Result<()> {
    let Some(status) = status else {
        return writeln!(
            out,
            "Saved credential cleanup: not observed (backend unavailable or no history)."
        )
        .map_err(|e| e.to_string());
    };
    writeln!(
        out,
        "Saved credential cleanup — pending: {}, running: {}, unknown: {}",
        status.pending, status.running, status.unreadable
    )
    .map_err(|e| e.to_string())?;
    if status.unreadable || status.pending != 0 || status.running != 0 {
        return Err(CLEANUP_UNKNOWN.into());
    }
    writeln!(out, "Saved credential cleanup: confirmed complete.").map_err(|e| e.to_string())
}
fn print_catalog(catalog: &Catalog, out: &mut dyn Write) -> Result<()> {
    writeln!(
        out,
        "Profile: {}\nDirectory: {}\n",
        catalog.profile, catalog.location
    )
    .map_err(|e| e.to_string())?;
    for plugin in &catalog.plugins {
        writeln!(
            out,
            "{:<24} {:<10} {:<10} {}",
            plugin.manifest.id,
            if plugin.enabled {
                "enabled"
            } else {
                "disabled"
            },
            plugin.source,
            plugin.manifest.name
        )
        .map_err(|e| e.to_string())?;
        if let Some(error) = &plugin.error {
            writeln!(out, "  Problem: {error}").map_err(|e| e.to_string())?;
        }
        if plugin.source == "external" {
            writeln!(
                out,
                "  Publisher: {}",
                plugin
                    .publisher
                    .as_deref()
                    .unwrap_or(if plugin.error.is_some() {
                        "unverified"
                    } else {
                        "unsigned"
                    })
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn print_trust(trust: &Trust) {
    let path = trust
        .path
        .as_ref()
        .map_or("none".into(), |path| path.display().to_string());
    match &trust.status {
        trust::Status::Absent => println!(
            "Trust file: {path} (not present)\nAny publisher with a valid signature can run external plugins."
        ),
        trust::Status::Missing => println!(
            "Trust file: {path} (named by {}, but not present)\nStatus: no external plugin can run until the file exists or {} is unset",
            trust::PATH_ENV,
            trust::PATH_ENV
        ),
        trust::Status::Invalid { reason } => println!(
            "Trust file: {path}\nStatus: unusable, so no external plugin can run\nProblem: {reason}"
        ),
        trust::Status::Ready(policy) => {
            println!("Trust file: {path}\nOnly trusted publishers can run external plugins.\n");
            if policy.publishers.is_empty() {
                println!("Trusted publishers: none");
            } else {
                println!("Trusted publishers:");
                for publisher in &policy.publishers {
                    match &publisher.name {
                        Some(name) => println!("  {} {name}", publisher.publisher),
                        None => println!("  {}", publisher.publisher),
                    }
                }
            }
            println!(
                "Self-developed: {}",
                if policy.allow_self_developed {
                    "allowed (plugins signed with your saved Buzz human identity)"
                } else {
                    "not allowed"
                }
            );
        }
    }
}
fn print_managed(managed: &Managed) {
    match managed {
        Managed::Absent => println!("No managed plugin policy found."),
        Managed::Invalid { path, reason } => {
            println!("Policy: {path}\nStatus: unusable\nProblem: {reason}")
        }
        Managed::Loading { url } => println!("Policy: {url}\nStatus: not fetched yet"),
        Managed::Unavailable { url, reason } => {
            println!("Policy: {url}\nStatus: unavailable\nProblem: {reason}")
        }
        Managed::Ready {
            path,
            source,
            plugins,
            problems,
            signed,
            automatic,
        } => {
            println!("Policy: {path}\nManaged by: {source}");
            if *signed {
                println!("Signed by the build's policy signer: automatic entries apply\n");
            } else {
                println!("Not signed by the build's policy signer: entries are recommendations\n");
            }
            for change in automatic {
                let action = match change.action {
                    Action::Installed => "Installed",
                    Action::Updated => "Updated",
                };
                println!(
                    "{action} {} ({}) at {}",
                    change.name, change.id, change.revision
                );
            }
            for entry in plugins {
                let state = match entry.state {
                    ManagedState::Missing => "not installed",
                    ManagedState::Current => "installed, current",
                    ManagedState::Outdated => "installed, update available",
                    ManagedState::Other => "installed from another source",
                };
                let location = match &entry.plugin.source {
                    ManagedSource::Git {
                        repository,
                        reference,
                        commit,
                        path,
                    } => format!("{repository} {reference} {commit} ({path})"),
                    ManagedSource::Url { url, sha256 } => format!("{url} (sha256 {sha256})"),
                };
                let install = match entry.plugin.install {
                    Install::Recommend => "",
                    Install::Automatic => ", installs automatically",
                    Install::Manual => ", not recommended",
                };
                let update = match entry.plugin.update {
                    Update::Review => "",
                    Update::Automatic => ", updates automatically",
                };
                println!(
                    "{:<24} {state}{install}{update}\n  {location}",
                    entry.plugin.id
                );
            }
            for problem in problems {
                println!("Ignored: {problem}");
            }
        }
    }
}
fn read_manifest(directory: &Path) -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_slice(
        &std::fs::read(directory.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    manifest.validate()?;
    Ok(manifest)
}
fn init(directory: &Path, id: &str, name: &str) -> Result<()> {
    valid_id(id)?;
    let manifest = Manifest {
        id: id.into(),
        name: name.into(),
        api_version: 1,
        description: None,
        discovery: None,
        updates: None,
        host: None,
    };
    manifest.validate()?;
    // Never overwrite an existing source directory.
    std::fs::create_dir(directory).map_err(|e| e.to_string())?;
    std::fs::create_dir(directory.join("src")).map_err(|e| e.to_string())?;
    let package = json!({"name": id, "private": true, "type": "module", "scripts": {"build": "tsc && vite build"}, "devDependencies": {"vite": "8.2.2", "typescript": "7.0.2", "@types/react": "19.2.18"}, "engines": {"node": ">=24"}});
    for (file, text) in [
        ("manifest.json", serde_json::to_string_pretty(&manifest).unwrap()),
        ("package.json", serde_json::to_string_pretty(&package).unwrap()),
        (".gitignore", "node_modules/\ndist/\n".into()),
        ("tsconfig.json", r#"{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","jsx":"react","strict":true,"noEmit":true},"include":["src"]}"#.into()),
        ("src/index.tsx", r#"import type { Context } from '@buzz/author';

export const inject = ['react', 'pages'];

export function apply(ctx: Context) {
  const React = ctx.react;
  // Plugin resources belong in ctx.effect(() => cleanup).
  // React effects belong to the visible page and stop when navigating away.
  // primary gives the page a sidebar row; every active page is still listed in search.
  ctx.pages.register({ id: "main", title: "My page", primary: true, component: function Page() {
    const [count, setCount] = React.useState(0);
    return <section>
      <h1>My page</h1>
      <button type='button' onClick={() => setCount(count + 1)}>Clicked {count} times</button>
    </section>;
  }});
}
"#.into()),
        // A normal, editable Vite config in the author's project, not injected code.
        ("vite.config.ts", r#"import { defineConfig } from 'vite';
import manifest from './manifest.json';

export default defineConfig({
  publicDir: false,
  oxc: { jsx: { runtime: 'classic' } },
  build: {
    lib: { entry: 'src/index.tsx', formats: ['es'], fileName: () => 'plugin.js' },
    rolldownOptions: { output: { codeSplitting: false } },
  },
  plugins: [{
    name: 'page-contract',
    enforce: 'pre',
    resolveId(id) {
      if (/^react(?:-dom)?(?:\/|$)/.test(id) || id === '@buzz/author' || id === '@deepseek-ai/cordis' || id.startsWith('@deepseek-ai/cordis/')) {
        throw new Error('Host capabilities are supplied by Buzz; use type-only imports');
      }
    },
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle);
      const page = outputs[0];
      if (outputs.length !== 1 || page?.type !== 'chunk' || page.imports.length) {
        throw new Error('Page API v1 requires one self-contained JS module, without separate assets');
      }
      if (!page.exports.includes('apply')) throw new Error('Export apply(ctx)');
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) });
    },
  }],
});
"#.into()),
    ] { std::fs::write(directory.join(file), text).map_err(|e| e.to_string())?; }
    Ok(())
}
fn build(directory: &Path) -> Result<()> {
    read_manifest(directory)?;
    let status = Command::new(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" })
        .args(["run", "build"])
        .current_dir(directory)
        .status()
        .map_err(|e| {
            format!("Could not start pnpm: {e}. Install Node and pnpm to build plugins.")
        })?;
    if !status.success() {
        return Err("Plugin build failed. See the build output above.".into());
    }
    // A successful script must actually produce the artifact that install consumes.
    read_manifest(&directory.join("dist"))?;
    if !directory.join("dist/plugin.js").is_file() {
        return Err("Build did not produce dist/plugin.js".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_unconfigured_home_prints_catalog_without_claiming_observed_completion() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("arbitrary-home");
        let manager = Manager::open(Some(home), "test", false).unwrap();
        let mut out = Vec::new();
        dispatch(&manager, "list", &[], "test", &mut out, Duration::ZERO)
            .unwrap()
            .unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("Profile: test"));
        assert!(text.contains("buzz.channels"));
        assert!(text.contains("not observed"));
        assert!(!text.contains("confirmed complete"));
    }

    #[test]
    fn saved_recovery_succeeds_while_unconfirmed_retry_fails() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let mut out = Vec::new();
        dispatch(&manager, "recover", &[], "test", &mut out, Duration::ZERO)
            .unwrap()
            .unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("Reset profile test"));
        assert!(!text.contains("confirmed complete"));
        let mut out = Vec::new();
        assert_eq!(
            dispatch(
                &manager,
                "cleanup-retry",
                &[],
                "test",
                &mut out,
                Duration::ZERO
            )
            .unwrap(),
            Err(CLEANUP_UNKNOWN.into())
        );
        assert!(!String::from_utf8(out)
            .unwrap()
            .contains("confirmed complete"));
    }

    #[test]
    fn dispatch_has_no_alias_or_argument_taking_retry() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        for (action, args) in [
            ("cleanup-status", vec![]),
            ("cleanup-retry", vec!["id".into()]),
        ] {
            let mut out = Vec::new();
            assert!(dispatch(&manager, action, &args, "test", &mut out, Duration::ZERO).is_none());
            assert!(out.is_empty());
        }
    }
}
