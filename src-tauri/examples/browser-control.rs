//! Disposable native acceptance: no Buzz frontend, identity, relay, or Keychain.
//! Run: bin/cargo run --locked -p Buzz --example browser-control [refs] [navigation] [forms]
//! With no group names, every group runs.
#[path = "../src/browser/mod.rs"]
#[allow(dead_code)]
mod browser;

// The real module needs the plugin manager and OAuth host. Builderlab sign-in
// is outside this fixture, so attach sees an identity with no session.
#[allow(dead_code)]
mod federated_identity {
    pub struct Config {
        pub identity_origin: String,
        pub api_base_path: String,
    }
    pub struct FederatedIdentity;
    impl FederatedIdentity {
        pub fn with_session<T>(
            &self,
            _: impl FnOnce(&zeroize::Zeroizing<String>, &str, &Config) -> T,
        ) -> Option<T> {
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("This fixture requires macOS");
}

#[cfg(target_os = "macos")]
macro_rules! verify {
    ($condition:expr) => {
        if !$condition {
            return Err(format!("Failed: {}", stringify!($condition)));
        }
    };
    ($condition:expr, $($detail:tt)+) => {
        if !$condition {
            return Err(format!("Failed: {}: {}", stringify!($condition), format!($($detail)+)));
        }
    };
}

#[cfg(target_os = "macos")]
fn main() {
    use acceptance::*;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    let server = serve();
    let selected: Vec<String> = std::env::args().skip(1).collect();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(move |app| {
            app.manage(federated_identity::FederatedIdentity);
            let home = format!("{}/", server.base);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(home.parse().unwrap()))
                .title("Buzz browser control acceptance")
                .inner_size(800.0, 600.0)
                .build()?;
            let fixture = Fixture {
                app: app.handle().clone(),
                base: server.base.clone(),
                requests: server.requests.clone(),
            };
            tauri::async_runtime::spawn(async move {
                let mut failed = false;
                for group in ["refs", "navigation", "forms"] {
                    if !selected.is_empty() && !selected.iter().any(|name| name == group) {
                        continue;
                    }
                    let result = match group {
                        "refs" => refs(&fixture).await,
                        "navigation" => navigation(&fixture).await,
                        _ => forms(&fixture).await,
                    };
                    match result {
                        Ok(()) => println!("PASS {group}"),
                        Err(error) => {
                            failed = true;
                            eprintln!("FAIL {group}: {error}");
                        }
                    }
                }
                if failed {
                    eprintln!("FAIL native browser control");
                    fixture.app.exit(1);
                } else {
                    println!("PASS native website observe/fill/click, rejected inputs, takeover, hide, detach");
                    fixture.app.exit(0);
                }
            });
            Ok(())
        })
        .run(context)
        .expect("Disposable browser fixture failed");
}

#[cfg(target_os = "macos")]
mod acceptance {
    use crate::browser::{control::*, *};
    use serde_json::{json, Value};
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    use tauri::{AppHandle, Manager};

    const BOUNDS: BrowserBounds = BrowserBounds {
        x: 10.0,
        y: 70.0,
        width: 780.0,
        height: 500.0,
    };

    pub struct Server {
        pub base: String,
        pub requests: Arc<Mutex<Vec<String>>>,
    }

    /// Answers each connection on its own thread, so `/slow` and `/slower` hold
    /// only their own request.
    pub fn serve() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let log = log.clone();
                std::thread::spawn(move || respond(stream, &log));
            }
        });
        Server { base, requests }
    }

    fn respond(mut stream: TcpStream, log: &Mutex<Vec<String>>) {
        let mut request = [0; 4096];
        let read = stream.read(&mut request).unwrap_or(0);
        let head = String::from_utf8_lossy(&request[..read]);
        let target = head.split_whitespace().nth(1).unwrap_or("/");
        let path = target.split('?').next().unwrap_or("/").to_string();
        log.lock().unwrap().push(path.clone());
        match path.as_str() {
            "/slow" => std::thread::sleep(Duration::from_secs(2)),
            "/slower" => std::thread::sleep(Duration::from_secs(5)),
            _ => {}
        }
        let (status, body) = match page(&path) {
            Some(body) => ("200 OK", body),
            None => (
                "404 Not Found",
                "<!doctype html><title>Missing</title>".to_string(),
            ),
        };
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }

    fn page(path: &str) -> Option<String> {
        Some(match path {
            "/" => r#"<!doctype html><meta charset="utf-8"><title>Browser control acceptance</title>
<h1>Disposable website</h1>
<input id="name" aria-label="Name">
<input type="password" aria-label="Password" value="never-observed">
<input type="password" id="hidden-password" aria-label="Hidden password">
<input id="hidden-field" aria-label="Hidden field">
<button aria-label="Hide fields" onclick="document.getElementById('hidden-password').hidden = true; document.getElementById('hidden-field').hidden = true">Hide fields</button>
<fieldset disabled><input aria-label="Fieldset field"></fieldset>
<input readonly aria-label="Read-only field">
<input type="file" aria-label="Upload">
<div contenteditable aria-label="Notes">Draft</div>
<input type="number" aria-label="Age">
<select aria-label="Size"><option>Small</option><option>Large</option></select>
<button aria-label="Save" onclick="document.getElementById('result').textContent = 'Saved ' + document.getElementById('name').value">Save</button>
<p id="result">Not saved</p>
<button disabled aria-label="Disabled">Disabled</button>
<div style="height: 3000px"></div>
<a href="/page1" aria-label="Far link">Far link</a>"#
                .to_string(),
            "/empty" => "<!doctype html><title>Empty</title><body></body>".to_string(),
            "/links-150" => links(150),
            "/links-151" => links(151),
            "/options-31" => format!(
                r#"<!doctype html><title>Options</title><select aria-label="Many">{}</select>"#,
                (1..=31).map(|index| format!("<option>Option {index}</option>")).collect::<String>()
            ),
            "/multibyte" => format!(
                r#"<!doctype html><meta charset="utf-8"><title>Multibyte</title><p>{}</p>{}<p id="odd"></p><script>document.getElementById('odd').textContent = '\uD800 odd';</script>"#,
                "漢".repeat(20_000),
                (1..=150)
                    .map(|_| format!(r#"<a href="/page1">{}</a> "#, "名".repeat(200)))
                    .collect::<String>()
            ),
            "/hostile-title" => r#"<!doctype html><p>Hostile</p><script>document.title = 'T'.repeat(5 * 1024 * 1024);</script>"#.to_string(),
            "/page1" => r#"<!doctype html><title>Page one</title><h1>Page one</h1><a href="/page2" aria-label="Page two">Page two</a>"#.to_string(),
            "/page2" => r#"<!doctype html><title>Page two</title><h1>Page two</h1><a href="/page1" aria-label="Page one">Page one</a>"#.to_string(),
            "/slow-link" => r#"<!doctype html><title>Slow link</title><a href="/slower" aria-label="Slow page">Slow page</a>"#.to_string(),
            "/slower" => r#"<!doctype html><title>Slower</title><h1>Slower page</h1>"#.to_string(),
            "/slow" => r#"<!doctype html><title>Slow</title><h1>Slow page</h1>"#.to_string(),
            "/reveal" => r#"<!doctype html><title>Reveal</title>
<button disabled id="later" aria-label="Later">Later</button>
<button disabled aria-label="Never">Never</button>
<script>setTimeout(() => { document.getElementById('later').disabled = false; }, 1500);</script>"#
                .to_string(),
            "/block" => r#"<!doctype html><title>Block</title><button aria-label="Block" onclick="const end = Date.now() + 6000; while (Date.now() < end) {}">Block</button>"#.to_string(),
            "/forms" => r#"<!doctype html><meta charset="utf-8"><title>Forms</title>
<pre id="log"></pre>
<form id="A"><input aria-label="A field"><select aria-label="A choice"><option>One</option><option>Two</option></select><button id="A-go" aria-label="A send">A send</button></form>
<form id="B"><input aria-label="B field"><input type="image" id="B-go" alt="B send" aria-label="B send" src="/pixel.png"></form>
<form id="C"><input aria-label="C field"><button id="C-go" disabled aria-label="C send">C send</button></form>
<form id="D"><input aria-label="D field"><button id="D-first" disabled aria-label="D first">D first</button><button id="D-second" aria-label="D second">D second</button></form>
<form id="E"><input aria-label="E field"></form>
<form id="F"><input aria-label="F one"><input aria-label="F two"></form>
<form id="G"><input aria-label="G field" onkeypress="if (event.key === 'Enter') event.preventDefault()"><button id="G-go" aria-label="G send">G send</button></form>
<form id="H"><input aria-label="H field" oninput="queueMicrotask(() => { document.getElementById('H-go').disabled = false; })"><button id="H-go" disabled aria-label="H send">H send</button></form>
<form id="I" onkeydown="if (event.key === 'Enter') { event.preventDefault(); this.requestSubmit(); }"><select aria-label="I choice"><option>One</option><option>Two</option></select></form>
<script>
const log = document.getElementById('log');
for (const form of document.forms) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    log.textContent += `${form.id} submit ${event.submitter ? event.submitter.id : 'none'}\n`;
  });
  for (const button of form.querySelectorAll('button, input[type=image]'))
    button.addEventListener('click', () => { log.textContent += `${form.id} click ${button.id}\n`; });
}
</script>"#
                .to_string(),
            "/p1" => r#"<!doctype html><title>P1</title><form action="/first-submitted"><input aria-label="First field"><button>Send first</button></form>"#.to_string(),
            "/p1-live" => r#"<!doctype html><title>P1 live</title><form action="/first-submitted"><input aria-label="First field" oninput="location.href = '/p2'"><button>Send first</button></form>"#.to_string(),
            "/p1-slow" => r#"<!doctype html><title>P1 slow</title><form action="/first-submitted"><input aria-label="First field" oninput="location.href = '/slow'"><button>Send first</button></form>"#.to_string(),
            "/p2" => r#"<!doctype html><title>P2</title><form action="/second-submitted"><input autofocus aria-label="Second field"><button>Send second</button></form>"#.to_string(),
            "/first-submitted" => "<!doctype html><title>First submitted</title><p>First submitted</p>".to_string(),
            "/second-submitted" => "<!doctype html><title>Second submitted</title><p>Second submitted</p>".to_string(),
            "/select" => r#"<!doctype html><title>Select</title>
<select aria-label="Country">
<option value="ca" selected>Canada</option>
<option value="mx" disabled>Mexico</option>
<optgroup label="Closed" disabled><option value="fr">France</option><option value="de">Germany</option></optgroup>
<option value="us">United States</option>
</select>"#
                .to_string(),
            "/scroll-pane" => r#"<!doctype html><title>Scroll pane</title>
<style>body { margin: 0; height: 3000px } #pane { position: fixed; top: 100px; left: 100px; width: 400px; height: 300px; overflow-y: auto }</style>
<p id="position">pane=0 doc=0</p>
<div id="pane"><div style="height: 3000px">Pane content</div></div>
<script>
const position = document.getElementById('position');
const pane = document.getElementById('pane');
const show = () => { position.textContent = `pane=${Math.round(pane.scrollTop)} doc=${Math.round(scrollY)}`; };
pane.addEventListener('scroll', show);
addEventListener('scroll', show);
</script>"#
                .to_string(),
            "/scroll-document" => r#"<!doctype html><title>Scroll document</title>
<style>body { margin: 0; height: 3000px }</style>
<p id="position">doc=0</p>
<script>addEventListener('scroll', () => { document.getElementById('position').textContent = `doc=${Math.round(scrollY)}`; });</script>"#
                .to_string(),
            "/scroll-ref" => r#"<!doctype html><title>Scroll ref</title><p>Top</p><div style="height: 3000px"></div><a href="/page1" aria-label="Bottom link">Bottom link</a>"#.to_string(),
            _ => return None,
        })
    }

    fn links(count: usize) -> String {
        format!(
            "<!doctype html><title>Links</title>{}",
            (1..=count)
                .map(|index| format!(r#"<a href="/page1">Link {index}</a><br>"#))
                .collect::<String>()
        )
    }

    pub struct Fixture {
        pub app: AppHandle,
        pub base: String,
        pub requests: Arc<Mutex<Vec<String>>>,
    }

    struct Page {
        id: String,
        token: String,
    }

    impl Fixture {
        fn url(&self, path: &str) -> String {
            format!("{}{path}", self.base)
        }

        fn requests_to(&self, path: &str) -> usize {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|logged| *logged == path)
                .count()
        }

        async fn open(&self, path: &str) -> Result<Page, String> {
            let id = browser_attach(
                self.app.clone(),
                self.url(path),
                BOUNDS,
                None,
                None,
                self.app.state(),
            )
            .await?;
            browser_set_bounds(self.app.clone(), id.clone(), BOUNDS, true).await?;
            self.loaded(&id, path).await?;
            let token = browser_control_grant(self.app.clone(), id.clone())
                .await?
                .token;
            Ok(Page { id, token })
        }

        /// Waits for the native status to report `path` with no load in progress.
        async fn loaded(&self, id: &str, path: &str) -> Result<(), String> {
            tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    let status = browser_status(self.app.clone(), id.to_string()).await?;
                    if !status.loading && status.url.ends_with(path) {
                        return Ok::<_, String>(());
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .map_err(|_| format!("{path} never finished loading"))?
        }

        /// A person's navigation, which the agent did not start.
        async fn load(&self, page: &Page, path: &str) -> Result<(), String> {
            browser_navigate(self.app.clone(), page.id.clone(), self.url(path), false).await?;
            self.loaded(&page.id, path).await
        }

        async fn call(&self, token: &str, request: Value) -> Result<Value, String> {
            execute(self.app.clone(), token.to_string(), request).await
        }

        /// Observes until `accept` holds and no load is in progress, for page
        /// changes the agent did not start. WKWebView reports a history load's
        /// URL before the load commits, and an agent action sent then races it.
        async fn observe_until(
            &self,
            page: &Page,
            what: &str,
            accept: impl Fn(&Value) -> bool,
        ) -> Result<Value, String> {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let snapshot = self.call(&page.token, json!({"action": "observe"})).await?;
                if snapshot["loading"] == false && accept(&snapshot) {
                    return Ok(snapshot);
                }
                if Instant::now() > deadline {
                    return Err(format!("{what} never happened: {}", brief(&snapshot)));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }

    /// Parses the request into whatever type the command takes, so the fixture
    /// sends the same JSON an agent sends.
    async fn execute(app: AppHandle, token: String, request: Value) -> Result<Value, String> {
        let request = serde_json::from_value(request.clone())
            .map_err(|error| format!("{request} did not parse: {error}"))?;
        let reply = browser_control_execute(app, token, request).await?;
        match serde_json::to_value(reply).map_err(|error| error.to_string())? {
            Value::String(text) => serde_json::from_str(&text).map_err(|error| error.to_string()),
            other => Ok(other),
        }
    }

    fn brief(value: &impl std::fmt::Debug) -> String {
        format!("{value:?}").chars().take(400).collect()
    }

    fn ok(step: &str, result: Result<Value, String>) -> Result<Value, String> {
        result.map_err(|error| format!("{step}: {}", brief(&error)))
    }

    fn expect_code(
        step: &str,
        result: Result<Value, String>,
        code: &str,
    ) -> Result<String, String> {
        match result {
            Err(message) if message.starts_with(&format!("{code}: ")) => Ok(message),
            other => Err(format!("{step}: expected {code}, got {}", brief(&other))),
        }
    }

    fn text(snapshot: &Value) -> &str {
        snapshot["text"].as_str().unwrap_or("")
    }

    fn url(snapshot: &Value) -> &str {
        snapshot["url"].as_str().unwrap_or("")
    }

    fn elements(snapshot: &Value) -> &[Value] {
        snapshot["elements"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    fn element<'a>(snapshot: &'a Value, name: &str) -> Result<&'a Value, String> {
        elements(snapshot)
            .iter()
            .find(|element| element["name"] == name)
            .ok_or_else(|| format!("no element named {name:?} in {}", brief(snapshot)))
    }

    fn reference(snapshot: &Value, name: &str) -> Result<String, String> {
        element(snapshot, name)?["ref"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("element {name:?} has no ref"))
    }

    fn references(snapshot: &Value) -> Vec<String> {
        elements(snapshot)
            .iter()
            .filter_map(|element| element["ref"].as_str().map(str::to_owned))
            .collect()
    }

    fn is_ref(candidate: &str) -> bool {
        let Some((revision, index)) = candidate
            .strip_prefix('r')
            .and_then(|rest| rest.split_once('e'))
        else {
            return false;
        };
        let digits = |part: &str, most: usize| {
            !part.is_empty()
                && part.len() <= most
                && !part.starts_with('0')
                && part.bytes().all(|byte| byte.is_ascii_digit())
        };
        digits(revision, 10) && digits(index, 6)
    }

    fn position(snapshot: &Value, label: &str) -> Option<u64> {
        let text = text(snapshot);
        let start = text.find(label)? + label.len();
        text[start..]
            .split(|character: char| !character.is_ascii_digit())
            .next()?
            .parse()
            .ok()
    }

    fn log_count(snapshot: &Value, line: &str) -> usize {
        text(snapshot).matches(line).count()
    }

    /// Slice 2: the page part, ref lifetime, and element preconditions in WebKit.
    pub async fn refs(f: &Fixture) -> Result<(), String> {
        let page = f.open("/").await?;
        let call = |request: Value| f.call(&page.token, request);

        let full = ok("observe", call(json!({"action": "observe"})).await)?;
        verify!(text(&full).contains("Disposable website"));
        verify!(!references(&full).is_empty(), "{}", brief(&full));
        verify!(
            references(&full).iter().all(|candidate| is_ref(candidate)),
            "{:?}",
            references(&full)
        );
        verify!(element(&full, "Far link")?["inViewport"] == false);
        verify!(!full.to_string().contains("never-observed"));
        let visible = ok(
            "observe viewport",
            call(json!({"action": "observe", "scope": "viewport"})).await,
        )?;
        verify!(element(&visible, "Far link").is_err());
        verify!(!elements(&visible).is_empty());
        verify!(elements(&visible)
            .iter()
            .all(|element| element["inViewport"] == true));

        let filled = ok(
            "fill by ref",
            call(json!({"action": "fill", "ref": reference(&full, "Name")?, "text": "Native ' \\ control"})).await,
        )?;
        verify!(!filled.to_string().contains("Native"), "{}", brief(&filled));
        let unsaved = ok(
            "observe after fill",
            call(json!({"action": "observe"})).await,
        )?;
        verify!(
            !unsaved.to_string().contains("Native"),
            "an input value reached the Snapshot"
        );
        ok(
            "click by ref",
            call(json!({"action": "click", "ref": reference(&full, "Save")?})).await,
        )?;
        let saved = ok(
            "observe after click",
            call(json!({"action": "observe"})).await,
        )?;
        verify!(
            text(&saved).contains("Saved Native ' \\ control"),
            "{}",
            text(&saved)
        );
        verify!(!saved.to_string().contains("never-observed"));

        browser_action(f.app.clone(), page.id.clone(), BrowserAction::Reload).await?;
        let earlier_revision = saved["revision"].as_u64();
        let reloaded = f
            .observe_until(&page, "a new revision after reload", |snapshot| {
                snapshot["revision"].as_u64() > earlier_revision
            })
            .await?;
        let message = expect_code(
            "click an earlier ref after reload",
            call(json!({"action": "click", "ref": reference(&saved, "Save")?})).await,
            "stale_ref",
        )?;
        let (_, attached) = message
            .split_once('\n')
            .ok_or("stale_ref carried no Snapshot")?;
        let fresh: Value = serde_json::from_str(attached).map_err(|error| error.to_string())?;
        verify!(
            fresh["revision"] == reloaded["revision"],
            "{}",
            brief(&fresh)
        );
        verify!(text(&fresh).contains("Disposable website"));

        let current = reloaded;
        let field = |name: &str| reference(&current, name);
        expect_code(
            "fill a password",
            call(json!({"action": "fill", "ref": field("Password")?, "text": "blocked"})).await,
            "unsupported_input",
        )?;
        expect_code(
            "click a disabled button",
            call(json!({"action": "click", "ref": field("Disabled")?})).await,
            "not_interactable",
        )?;
        expect_code(
            "fill a field in a disabled fieldset",
            call(json!({"action": "fill", "ref": field("Fieldset field")?, "text": "blocked"}))
                .await,
            "not_interactable",
        )?;
        expect_code(
            "fill a read-only field",
            call(json!({"action": "fill", "ref": field("Read-only field")?, "text": "blocked"}))
                .await,
            "not_interactable",
        )?;
        let option = expect_code(
            "click an option",
            call(json!({"action": "click", "ref": field("Small")?})).await,
            "not_interactable",
        )?;
        verify!(option.contains("select"), "{option}");
        expect_code(
            "click a file input",
            call(json!({"action": "click", "ref": field("Upload")?})).await,
            "unsupported_input",
        )?;
        expect_code(
            "fill contenteditable",
            call(json!({"action": "fill", "ref": field("Notes")?, "text": "blocked"})).await,
            "unsupported_input",
        )?;
        expect_code(
            "fill letters into a number input",
            call(json!({"action": "fill", "ref": field("Age")?, "text": "abc"})).await,
            "unsupported_input",
        )?;
        ok(
            "hide two fields",
            call(json!({"action": "click", "ref": field("Hide fields")?})).await,
        )?;
        expect_code(
            "fill a hidden password",
            call(json!({"action": "fill", "ref": field("Hidden password")?, "text": "blocked"}))
                .await,
            "not_interactable",
        )?;
        expect_code(
            "fill a hidden field",
            call(json!({"action": "fill", "ref": field("Hidden field")?, "text": "blocked"})).await,
            "not_interactable",
        )?;

        f.load(&page, "/empty").await?;
        let empty = ok(
            "observe an empty page",
            call(json!({"action": "observe"})).await,
        )?;
        verify!(empty["text"] == "", "{}", brief(&empty));
        verify!(empty["elements"] == json!([]), "{}", brief(&empty));
        verify!(empty["truncated"] == false, "{}", brief(&empty));

        f.load(&page, "/links-150").await?;
        let exactly = ok(
            "observe 150 links",
            call(json!({"action": "observe"})).await,
        )?;
        verify!(
            elements(&exactly).len() == 150,
            "{}",
            elements(&exactly).len()
        );
        verify!(exactly["truncated"] == false);

        f.load(&page, "/links-151").await?;
        let over = ok(
            "observe 151 links",
            call(json!({"action": "observe"})).await,
        )?;
        verify!(elements(&over).len() == 150, "{}", elements(&over).len());
        verify!(over["truncated"] == true);

        f.load(&page, "/options-31").await?;
        let options = ok(
            "observe 31 options",
            call(json!({"action": "observe"})).await,
        )?;
        let listed = elements(&options)
            .iter()
            .filter(|element| element["role"] == "option")
            .count();
        verify!(listed == 30, "{listed}");
        verify!(options["truncated"] == true);

        f.load(&page, "/multibyte").await?;
        let multibyte = ok(
            "observe the CJK page",
            call(json!({"action": "observe"})).await,
        )?;
        verify!(multibyte["truncated"] == true);
        verify!(
            multibyte.to_string().len() <= 131_072,
            "{}",
            multibyte.to_string().len()
        );

        f.load(&page, "/hostile-title").await?;
        let hostile = ok(
            "observe a 5 MB title",
            call(json!({"action": "observe"})).await,
        )?;
        let title = hostile["title"].as_str().unwrap_or("");
        verify!(title.chars().count() == 200, "{}", title.chars().count());
        verify!(hostile["truncated"] == true);

        expect_code(
            "navigate to file:",
            call(json!({"action": "navigate", "url": "file:///etc/passwd"})).await,
            "invalid_url",
        )?;

        browser_control_revoke(f.app.clone(), page.id.clone()).await?;
        expect_code(
            "observe after revoke",
            call(json!({"action": "observe"})).await,
            "not_visible",
        )?;
        let hidden = browser_control_grant(f.app.clone(), page.id.clone())
            .await?
            .token;
        browser_set_bounds(f.app.clone(), page.id.clone(), BOUNDS, false).await?;
        expect_code(
            "observe while hidden",
            f.call(&hidden, json!({"action": "observe"})).await,
            "not_visible",
        )?;
        browser_set_bounds(f.app.clone(), page.id.clone(), BOUNDS, true).await?;
        let detached = browser_control_grant(f.app.clone(), page.id.clone())
            .await?
            .token;
        browser_detach(f.app.clone(), page.id.clone()).await?;
        expect_code(
            "observe after detach",
            f.call(&detached, json!({"action": "observe"})).await,
            "not_visible",
        )?;
        Ok(())
    }

    /// Slice 3: history, settle, `wait`, and `busy` in WebKit.
    pub async fn navigation(f: &Fixture) -> Result<(), String> {
        let page = f.open("/page1").await?;
        let call = |request: Value| f.call(&page.token, request);

        let start = ok(
            "back with no earlier entry",
            call(json!({"action": "back"})).await,
        )?;
        verify!(url(&start).ends_with("/page1"), "{}", url(&start));

        let second = ok(
            "navigate",
            call(json!({"action": "navigate", "url": f.url("/page2")})).await,
        )?;
        verify!(url(&second).ends_with("/page2"), "{}", url(&second));
        verify!(text(&second).contains("Page two"), "{}", brief(&second));
        let page_two_refs = references(&second);

        let first = ok("back", call(json!({"action": "back"})).await)?;
        verify!(url(&first).ends_with("/page1"), "{}", url(&first));
        verify!(
            references(&first)
                .iter()
                .all(|candidate| !page_two_refs.contains(candidate)),
            "{:?} repeats {:?}",
            references(&first),
            page_two_refs
        );
        println!(
            "observation: back gave revision {} after page two's revision {}",
            first["revision"], second["revision"]
        );

        let forward = ok("forward", call(json!({"action": "forward"})).await)?;
        verify!(url(&forward).ends_with("/page2"), "{}", url(&forward));

        browser_action(f.app.clone(), page.id.clone(), BrowserAction::Back).await?;
        f.observe_until(&page, "the person's Back", |snapshot| {
            url(snapshot).ends_with("/page1")
        })
        .await?;
        let after_person = ok(
            "forward after the person's Back",
            call(json!({"action": "forward"})).await,
        )?;
        verify!(
            url(&after_person).ends_with("/page2"),
            "{}",
            url(&after_person)
        );

        let before = ok(
            "observe before reload",
            call(json!({"action": "observe"})).await,
        )?;
        let reloaded = ok("reload", call(json!({"action": "reload"})).await)?;
        verify!(
            reloaded["revision"].as_u64() > before["revision"].as_u64(),
            "{}",
            brief(&reloaded)
        );
        expect_code(
            "click an earlier ref after reload",
            call(json!({"action": "click", "ref": reference(&before, "Page one")?})).await,
            "stale_ref",
        )?;

        ok(
            "navigate to the slow link",
            call(json!({"action": "navigate", "url": f.url("/slow-link")})).await,
        )?;
        let links = ok(
            "observe the slow link",
            call(json!({"action": "observe"})).await,
        )?;
        let clicked = ok(
            "click the slow link",
            call(json!({"action": "click", "ref": reference(&links, "Slow page")?})).await,
        )?;
        verify!(
            clicked["loading"] == true,
            "precondition: /slower is still loading: {}",
            brief(&clicked)
        );
        let loaded = ok(
            "wait for load",
            call(json!({"action": "wait", "for": "load", "timeout_ms": 5000})).await,
        )?;
        verify!(url(&loaded).ends_with("/slower"), "{}", url(&loaded));
        verify!(text(&loaded).contains("Slower page"), "{}", brief(&loaded));

        ok(
            "navigate to the reveal page",
            call(json!({"action": "navigate", "url": f.url("/reveal")})).await,
        )?;
        let hidden = ok(
            "observe the reveal page",
            call(json!({"action": "observe"})).await,
        )?;
        let later = reference(&hidden, "Later")?;
        expect_code(
            "wait 0 ms for a disabled button",
            call(json!({"action": "wait", "for": {"ref": later}, "timeout_ms": 0})).await,
            "timeout",
        )?;
        let revealed = ok(
            "wait for the timer to enable the button",
            call(json!({"action": "wait", "for": {"ref": later}, "timeout_ms": 5000})).await,
        )?;
        verify!(
            element(&revealed, "Later")?["disabled"] != true,
            "{}",
            brief(&revealed)
        );

        let never = reference(&revealed, "Never")?;
        let waiting = tauri::async_runtime::spawn(execute(
            f.app.clone(),
            page.token.clone(),
            json!({"action": "wait", "for": {"ref": never}, "timeout_ms": 3000}),
        ));
        // No signal shows that the wait holds the in-flight flag; this head start
        // lets its first main-thread hop run before the probe.
        tokio::time::sleep(Duration::from_millis(500)).await;
        expect_code(
            "observe during a wait",
            call(json!({"action": "observe"})).await,
            "busy",
        )?;
        expect_code(
            "the wait itself",
            waiting.await.map_err(|error| error.to_string())?,
            "timeout",
        )?;

        ok(
            "navigate to the blocking page",
            call(json!({"action": "navigate", "url": f.url("/block")})).await,
        )?;
        let blocking = ok(
            "observe the blocking page",
            call(json!({"action": "observe"})).await,
        )?;
        expect_code(
            "click a 6 s handler",
            call(json!({"action": "click", "ref": reference(&blocking, "Block")?})).await,
            "timeout",
        )?;
        let next = call(json!({"action": "observe"})).await;
        verify!(
            !matches!(&next, Err(message) if message.starts_with("busy: ")),
            "{}",
            brief(&next)
        );

        ok(
            "navigate to the reveal page again",
            call(json!({"action": "navigate", "url": f.url("/reveal")})).await,
        )?;
        let again = ok(
            "observe the reveal page again",
            call(json!({"action": "observe"})).await,
        )?;
        let never = reference(&again, "Never")?;
        let started = Instant::now();
        let waiting = tauri::async_runtime::spawn(execute(
            f.app.clone(),
            page.token.clone(),
            json!({"action": "wait", "for": {"ref": never}, "timeout_ms": 10000}),
        ));
        tokio::time::sleep(Duration::from_millis(500)).await;
        browser_control_revoke(f.app.clone(), page.id.clone()).await?;
        expect_code(
            "wait during revoke",
            waiting.await.map_err(|error| error.to_string())?,
            "not_visible",
        )?;
        verify!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );

        let token = browser_control_grant(f.app.clone(), page.id.clone())
            .await?
            .token;
        let started = Instant::now();
        let waiting = tauri::async_runtime::spawn(execute(
            f.app.clone(),
            token,
            json!({"action": "wait", "for": {"ref": never}, "timeout_ms": 10000}),
        ));
        tokio::time::sleep(Duration::from_millis(500)).await;
        browser_detach(f.app.clone(), page.id.clone()).await?;
        expect_code(
            "wait during detach",
            waiting.await.map_err(|error| error.to_string())?,
            "not_visible",
        )?;
        verify!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        Ok(())
    }

    /// Slice 4: implicit submission, the Enter step's document test, `select`, and `scroll`.
    pub async fn forms(f: &Fixture) -> Result<(), String> {
        let page = f.open("/forms").await?;
        let call = |request: Value| f.call(&page.token, request);
        let forms = ok(
            "observe the forms",
            call(json!({"action": "observe"})).await,
        )?;
        let field = |name: &str| reference(&forms, name);
        let observe = || call(json!({"action": "observe"}));

        ok(
            "fill A",
            call(json!({"action": "fill", "ref": field("A field")?, "text": "a"})).await,
        )?;
        ok(
            "Enter in A",
            call(json!({"action": "press", "key": "Enter"})).await,
        )?;
        let default_button = ok("observe A", observe().await)?;
        verify!(
            log_count(&default_button, "A click A-go") == 1,
            "{}",
            text(&default_button)
        );
        verify!(
            log_count(&default_button, "A submit A-go") == 1,
            "{}",
            text(&default_button)
        );

        ok(
            "fill B",
            call(json!({"action": "fill", "ref": field("B field")?, "text": "b"})).await,
        )?;
        ok(
            "Enter in B",
            call(json!({"action": "press", "key": "Enter"})).await,
        )?;
        let image_button = ok("observe B", observe().await)?;
        verify!(
            log_count(&image_button, "B submit B-go") == 1,
            "{}",
            text(&image_button)
        );

        ok(
            "fill C",
            call(json!({"action": "fill", "ref": field("C field")?, "text": "c"})).await,
        )?;
        ok(
            "Enter in C",
            call(json!({"action": "press", "key": "Enter"})).await,
        )?;
        let disabled_default = ok("observe C", observe().await)?;
        verify!(
            log_count(&disabled_default, "C click") == 0,
            "{}",
            text(&disabled_default)
        );
        verify!(
            log_count(&disabled_default, "C submit") == 0,
            "{}",
            text(&disabled_default)
        );

        ok(
            "fill D",
            call(json!({"action": "fill", "ref": field("D field")?, "text": "d"})).await,
        )?;
        ok(
            "Enter in D",
            call(json!({"action": "press", "key": "Enter"})).await,
        )?;
        let disabled_first = ok("observe D", observe().await)?;
        verify!(
            log_count(&disabled_first, "D submit") == 0,
            "{}",
            text(&disabled_first)
        );

        ok(
            "fill E",
            call(json!({"action": "fill", "ref": field("E field")?, "text": "e"})).await,
        )?;
        ok(
            "Enter in E",
            call(json!({"action": "press", "key": "Enter"})).await,
        )?;
        let one_field = ok("observe E", observe().await)?;
        verify!(
            log_count(&one_field, "E submit none") == 1,
            "{}",
            text(&one_field)
        );

        ok(
            "fill F one",
            call(json!({"action": "fill", "ref": field("F one")?, "text": "f"})).await,
        )?;
        ok(
            "Enter in F one",
            call(json!({"action": "press", "key": "Enter"})).await,
        )?;
        ok(
            "fill F two",
            call(json!({"action": "fill", "ref": field("F two")?, "text": "f"})).await,
        )?;
        ok(
            "Enter in F two",
            call(json!({"action": "press", "key": "Enter"})).await,
        )?;
        let two_fields = ok("observe F", observe().await)?;
        verify!(
            log_count(&two_fields, "F submit") == 0,
            "{}",
            text(&two_fields)
        );

        ok(
            "fill G",
            call(json!({"action": "fill", "ref": field("G field")?, "text": "g"})).await,
        )?;
        ok(
            "Enter in G",
            call(json!({"action": "press", "key": "Enter"})).await,
        )?;
        let cancelled = ok("observe G", observe().await)?;
        verify!(
            log_count(&cancelled, "G click") == 0,
            "{}",
            text(&cancelled)
        );
        verify!(
            log_count(&cancelled, "G submit") == 0,
            "{}",
            text(&cancelled)
        );

        ok(
            "fill H and submit",
            call(json!({"action": "fill", "ref": field("H field")?, "text": "h", "submit": true}))
                .await,
        )?;
        let microtask = ok("observe H", observe().await)?;
        verify!(
            log_count(&microtask, "H submit H-go") == 1,
            "{}",
            text(&microtask)
        );

        let blocked = ok(
            "fill C and submit",
            call(json!({"action": "fill", "ref": field("C field")?, "text": "c", "submit": true}))
                .await,
        )?;
        verify!(log_count(&blocked, "C submit") == 0, "{}", text(&blocked));
        verify!(url(&blocked) == url(&forms), "{}", url(&blocked));
        verify!(
            element(&blocked, "C send")?["disabled"] == true,
            "{}",
            brief(&blocked)
        );

        ok(
            "select in A",
            call(json!({"action": "select", "ref": field("A choice")?, "value": "Two"})).await,
        )?;
        ok(
            "Enter on A's select",
            call(json!({"action": "press", "key": "Enter"})).await,
        )?;
        let select_enter = ok("observe A's select", observe().await)?;
        verify!(
            log_count(&select_enter, "A submit") == 1,
            "{}",
            text(&select_enter)
        );
        verify!(
            log_count(&select_enter, "A click") == 1,
            "{}",
            text(&select_enter)
        );

        ok(
            "select in I",
            call(json!({"action": "select", "ref": field("I choice")?, "value": "Two"})).await,
        )?;
        ok(
            "Enter on I's select",
            call(json!({"action": "press", "key": "Enter"})).await,
        )?;
        let page_handler = ok("observe I", observe().await)?;
        verify!(
            log_count(&page_handler, "I submit none") == 1,
            "{}",
            text(&page_handler)
        );

        ok(
            "navigate to P1",
            call(json!({"action": "navigate", "url": f.url("/p1")})).await,
        )?;
        let first = ok("observe P1", observe().await)?;
        let first_field = reference(&first, "First field")?;
        ok(
            "navigate to P2",
            call(json!({"action": "navigate", "url": f.url("/p2")})).await,
        )?;
        let reply = evaluate(
            f.app.clone(),
            page.token.clone(),
            json!({
                "revision": first["revision"],
                "request": {"action": "press", "key": "Enter"},
                "fillRef": first_field,
            }),
        )
        .await?;
        verify!(
            serde_json::from_str::<Value>(&reply).ok() == Some(json!({"skipped": true})),
            "{reply}"
        );
        ok(
            "settle after the simulated gap",
            call(json!({"action": "wait", "for": "load", "timeout_ms": 1000})).await,
        )?;
        verify!(f.requests_to("/second-submitted") == 0);

        let mut ended_in_first = 0;
        let mut skipped_in_second = 0;
        for run in 1..=10 {
            ok(
                "navigate to live P1",
                call(json!({"action": "navigate", "url": f.url("/p1-live")})).await,
            )?;
            let live = ok("observe live P1", observe().await)?;
            let done = ok(
                &format!("live gap run {run}"),
                call(json!({"action": "fill", "ref": reference(&live, "First field")?, "text": "x", "submit": true})).await,
            )?;
            // A GET form with no named fields submits an empty query, so the URL ends in "?".
            if url(&done).ends_with("/first-submitted?") {
                ended_in_first += 1;
            } else {
                skipped_in_second += 1;
            }
        }
        println!("observation: live gap ended in P1 {ended_in_first} times and was skipped in P2 {skipped_in_second} times");
        verify!(f.requests_to("/second-submitted") == 0);

        let submitted_before = f.requests_to("/first-submitted");
        ok(
            "navigate to slow P1",
            call(json!({"action": "navigate", "url": f.url("/p1-slow")})).await,
        )?;
        let slow = ok("observe slow P1", observe().await)?;
        let done = ok(
            "fill slow P1 and submit",
            call(json!({"action": "fill", "ref": reference(&slow, "First field")?, "text": "x", "submit": true})).await,
        )?;
        // WebKit may drop a form submission made while a script-started load is still
        // provisional, so either outcome is valid; the Snapshot must report the one that happened.
        let submitted = f.requests_to("/first-submitted") - submitted_before;
        println!("observation: submit during a provisional load sent {submitted} request(s), ended at {}", url(&done));
        verify!(
            (submitted == 1 && url(&done).ends_with("/first-submitted?"))
                || (submitted == 0 && url(&done).ends_with("/slow")),
            "{submitted} request(s), {}",
            url(&done)
        );

        ok(
            "navigate to the select page",
            call(json!({"action": "navigate", "url": f.url("/select")})).await,
        )?;
        let choices = ok("observe the select page", observe().await)?;
        let country = reference(&choices, "Country")?;
        expect_code(
            "select a disabled option",
            call(json!({"action": "select", "ref": country, "value": "mx"})).await,
            "not_interactable",
        )?;
        let unchanged = ok("observe after the disabled option", observe().await)?;
        verify!(
            element(&unchanged, "Canada")?["checked"] == true,
            "{}",
            brief(&unchanged)
        );
        verify!(
            element(&unchanged, "Mexico")?["disabled"] == true,
            "{}",
            brief(&unchanged)
        );
        verify!(
            element(&unchanged, "Germany")?["disabled"] == true,
            "{}",
            brief(&unchanged)
        );
        expect_code(
            "select by the label of an option in a disabled optgroup",
            call(json!({"action": "select", "ref": country, "value": "Germany"})).await,
            "not_interactable",
        )?;
        let still = ok("observe after the disabled optgroup", observe().await)?;
        verify!(
            element(&still, "Canada")?["checked"] == true,
            "{}",
            brief(&still)
        );
        verify!(
            element(&still, "Mexico")?["disabled"] == true,
            "{}",
            brief(&still)
        );
        verify!(
            element(&still, "Germany")?["disabled"] == true,
            "{}",
            brief(&still)
        );
        expect_code(
            "select a value no option has",
            call(json!({"action": "select", "ref": country, "value": "zz"})).await,
            "invalid_request",
        )?;

        ok(
            "navigate to the pane",
            call(json!({"action": "navigate", "url": f.url("/scroll-pane")})).await,
        )?;
        ok(
            "scroll the pane",
            call(json!({"action": "scroll", "direction": "down"})).await,
        )?;
        let pane = ok("observe the pane", observe().await)?;
        verify!(
            position(&pane, "pane=").is_some_and(|offset| offset > 0),
            "{}",
            text(&pane)
        );
        verify!(position(&pane, "doc=") == Some(0), "{}", text(&pane));

        ok(
            "navigate to the document",
            call(json!({"action": "navigate", "url": f.url("/scroll-document")})).await,
        )?;
        let at_top = ok(
            "scroll up at the top",
            call(json!({"action": "scroll", "direction": "up"})).await,
        )?;
        verify!(
            url(&at_top).ends_with("/scroll-document"),
            "{}",
            brief(&at_top)
        );
        verify!(position(&at_top, "doc=") == Some(0), "{}", text(&at_top));
        ok(
            "scroll the document",
            call(json!({"action": "scroll", "direction": "down"})).await,
        )?;
        let document = ok("observe the document", observe().await)?;
        verify!(
            position(&document, "doc=").is_some_and(|offset| offset > 0),
            "{}",
            text(&document)
        );

        ok(
            "navigate to the far link",
            call(json!({"action": "navigate", "url": f.url("/scroll-ref")})).await,
        )?;
        let far = ok("observe the far link", observe().await)?;
        verify!(
            element(&far, "Bottom link")?["inViewport"] == false,
            "precondition: {}",
            brief(&far)
        );
        ok(
            "scroll to the link",
            call(json!({"action": "scroll", "ref": reference(&far, "Bottom link")?})).await,
        )?;
        let near = ok("observe the scrolled link", observe().await)?;
        verify!(
            element(&near, "Bottom link")?["inViewport"] == true,
            "{}",
            brief(&near)
        );

        browser_detach(f.app.clone(), page.id.clone()).await?;
        Ok(())
    }
}
