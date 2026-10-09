//! Test bridge to the real native manager; never reads the user's default profile.
use buzzodz_plugins::{development::PreparedDevelopment, Catalog, Manager};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let home = PathBuf::from(&args[0]);
    assert!(home.is_absolute());
    if args[1] == "hold-lock" {
        let profile = home.join("profiles/proof");
        fs::create_dir_all(&profile).unwrap();
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(profile.join("registry.lock"))
            .unwrap();
        lock.lock().unwrap();
        println!("locked");
        std::io::stdout().flush().unwrap();
        // Explicit parent-controlled release, not a sleep-as-synchronization.
        std::io::stdin().read_exact(&mut [0]).unwrap();
        return;
    }
    let manager = Manager::open(Some(home), "proof", false).unwrap();
    if args[1] == "session" {
        session(manager);
        return;
    }
    let result = match args[1].as_str() {
        "catalog" => {
            serde_json::json!({"status":"ready","catalog":manager.catalog().unwrap(),"externalPluginsPaused":false})
        }
        "module" => serde_json::json!({"code":manager.module(&args[2], &args[3]).unwrap()}),
        "change" => {
            manager.change(&args[2], &args[3]).unwrap();
            serde_json::json!({"status":"ready","catalog":manager.catalog().unwrap(),"externalPluginsPaused":false})
        }
        "reload" => {
            serde_json::json!({"status":"ready","catalog":manager.reload(&args[2]).unwrap(),"externalPluginsPaused":false})
        }
        "install" => {
            manager.install(&PathBuf::from(&args[2])).unwrap();
            serde_json::json!({"status":"ready","catalog":manager.catalog().unwrap(),"externalPluginsPaused":false})
        }
        _ => panic!("Unknown fixture operation"),
    };
    println!("{result}");
}

// One process owns the development selection and preview. EOF closes the session;
// only normal enabled flags use the isolated profile's installed registry.
fn ready(catalog: Catalog) -> serde_json::Value {
    serde_json::json!({"status":"ready","catalog":catalog,"externalPluginsPaused":false})
}
#[derive(serde::Deserialize)]
struct Request {
    command: String,
    #[serde(default)]
    args: serde_json::Value,
}
fn dispatch(
    manager: &Manager,
    pending: &mut Option<PreparedDevelopment>,
    request: Request,
) -> Result<serde_json::Value, String> {
    let string = |key: &str| {
        request.args[key]
            .as_str()
            .ok_or_else(|| format!("Missing fixture argument: {key}"))
    };
    Ok(match request.command.as_str() {
        "plugin_catalog" => ready(manager.catalog()?),
        "plugin_module" => serde_json::json!(manager.module(string("id")?, string("revision")?)?),
        "plugin_change" => ready(manager.change(string("action")?, string("id")?)?),
        "plugin_reload" => ready(manager.reload(string("id")?)?),
        "plugin_development_initialize" => {
            manager.initialize_development(
                serde_json::from_value(request.args["fingerprints"].clone())
                    .map_err(|error| error.to_string())?,
            )?;
            serde_json::Value::Null
        }
        "plugin_development_folder" => {
            *pending = None;
            let prepared =
                manager.prepare_development(string("id")?, &PathBuf::from(string("directory")?))?;
            let preview =
                serde_json::to_value(&prepared.preview).map_err(|error| error.to_string())?;
            *pending = Some(prepared);
            preview
        }
        "plugin_development_attach" => {
            let catalog = manager.attach_development(
                pending
                    .as_ref()
                    .ok_or("Development preview expired; choose the folder again")?,
                string("token")?,
            )?;
            *pending = None;
            ready(catalog)
        }
        "plugin_development_discard" => {
            if pending.as_ref().is_some_and(|prepared| {
                Some(prepared.preview.token.as_str()) == request.args["token"].as_str()
            }) {
                *pending = None;
            }
            serde_json::Value::Null
        }
        "plugin_development_compiled" => ready(manager.use_compiled(string("id")?)?),
        _ => return Err(format!("Unknown fixture operation: {}", request.command)),
    })
}
fn session(manager: Manager) {
    let mut pending = None;
    for line in std::io::stdin().lock().lines() {
        let result = line
            .map_err(|error| error.to_string())
            .and_then(|line| serde_json::from_str(&line).map_err(|error| error.to_string()))
            .and_then(|request| dispatch(&manager, &mut pending, request));
        let response = match result {
            Ok(value) => serde_json::json!({"ok": value}),
            Err(error) => serde_json::json!({"error": error}),
        };
        println!("{response}");
        std::io::stdout().flush().unwrap();
    }
}
