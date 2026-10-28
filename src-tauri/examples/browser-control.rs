//! Disposable native acceptance: no Buzz frontend, identity, relay, or Keychain.
//! Run: bin/cargo run --locked -p Buzz --features experimental-browser-control --example browser-control
#[path = "../src/browser/mod.rs"]
#[allow(dead_code)]
mod browser;

#[cfg(not(all(feature = "experimental-browser-control", target_os = "macos")))]
fn main() {
    panic!("This fixture requires macOS and experimental-browser-control");
}

#[cfg(all(feature = "experimental-browser-control", target_os = "macos"))]
fn main() {
    use browser::{control::*, *};
    macro_rules! verify {
        ($condition:expr) => {
            if !$condition {
                return Err(format!("Failed: {}", stringify!($condition)));
            }
        };
    }
    use std::{
        io::{Read, Write},
        net::TcpListener,
        time::Duration,
    };
    use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl, WindowBuilder};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = [0; 2048];
            let _ = stream.read(&mut request);
            let body = r#"<!doctype html><title>Browser control acceptance</title><h1>Disposable website</h1><label>Name<input id="name"></label><input id="password" type="password" value="never-observed"><input id="hidden" hidden><fieldset disabled><input id="fieldset"></fieldset><input id="readonly" readonly><button id="save" onclick="document.getElementById('result').textContent=document.getElementById('name').value">Save</button><p id="result">Not saved</p><button disabled id="disabled">Disabled</button>"#;
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        }
    });
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(move |app| {
            let window = WindowBuilder::new(app, "main")
                .title("Buzz browser control acceptance")
                .inner_size(800.0, 600.0).build()?;
            window.add_child(WebviewBuilder::new("main", WebviewUrl::External(
                url.parse().unwrap()
            )), LogicalPosition::new(0, 0), LogicalSize::new(800, 600))?;
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result: Result<(), String> = async {
                    let bounds = BrowserBounds { x: 10.0, y: 70.0, width: 780.0, height: 500.0 };
                    let id = browser_attach(app.clone(), url.clone(), bounds, None).await?;
                    browser_set_bounds(app.clone(), id.clone(), bounds, true).await?;
                    tokio::time::timeout(Duration::from_secs(15), async {
                        loop {
                            if !browser_status(app.clone(), id.clone()).await?.loading { return Ok::<_, String>(()); }
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    }).await.map_err(|_| "Website never finished loading")??;
                    let token = browser_control_grant(app.clone(), id.clone()).await?.token;
                    let call = |request| browser_control_execute(app.clone(), token.clone(), request);
                    let observation = call(Request::Observe {}).await?;
                    verify!(observation["text"].as_str().unwrap_or("").contains("Disposable website"));
                    verify!(!observation.to_string().contains("never-observed"));
                    call(Request::Fill { selector: "#name".into(), text: "Native \' \\\n control".into() }).await?;
                    call(Request::Click { selector: "#save".into() }).await?;
                    verify!(call(Request::Observe {}).await?["text"].as_str().unwrap_or("").contains("Native"));
                    for request in [
                        Request::Click { selector: "button".into() },
                        Request::Click { selector: "#disabled".into() },
                        Request::Fill { selector: "#password".into(), text: "blocked".into() },
                        Request::Fill { selector: "#hidden".into(), text: "blocked".into() },
                        Request::Fill { selector: "#fieldset".into(), text: "blocked".into() },
                        Request::Fill { selector: "#readonly".into(), text: "blocked".into() },
                        Request::Navigate { url: "file:///etc/passwd".into() },
                    ] { verify!(call(request).await.is_err()); }
                    browser_control_revoke(app.clone(), id.clone()).await?;
                    verify!(call(Request::Observe {}).await.is_err());
                    let next = browser_control_grant(app.clone(), id.clone()).await?.token;
                    browser_set_bounds(app.clone(), id.clone(), bounds, false).await?;
                    verify!(browser_control_execute(app.clone(), next, Request::Observe {}).await.is_err());
                    verify!(browser_control_grant(app.clone(), id.clone()).await.is_err());
                    browser_detach(app.clone(), id.clone()).await?;
                    verify!(browser_control_grant(app.clone(), id).await.is_err());
                    Ok(())
                }.await;
                match result {
                    Ok(()) => { println!("PASS native website observe/fill/click, rejected inputs, takeover, hide, detach"); app.exit(0); }
                    Err(error) => { eprintln!("FAIL native browser control: {error}"); app.exit(1); }
                }
            });
            Ok(())
        })
        .run(context)
        .expect("Disposable browser fixture failed");
}
