//! Opt-in control of a website guest, never of Buzz's trusted main document.
use super::*;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum Request {
    Observe {},
    Click { selector: String },
    Fill { selector: String, text: String },
    Navigate { url: String },
}

impl Request {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Click { selector } | Self::Fill { selector, .. }
                if selector.is_empty() || selector.len() > 1024 =>
            {
                return Err("Use a CSS selector of 1-1024 bytes".into());
            }
            Self::Fill { text, .. } if text.len() > 8192 => {
                return Err("Text exceeds 8192 bytes".into());
            }
            _ => {}
        }
        Ok(())
    }
}

fn permitted<T>(
    token: &str,
    operation: impl FnOnce(&BrowserSession) -> Result<T, String>,
) -> Result<T, String> {
    BROWSERS.with(|browsers| {
        let browsers = browsers.borrow();
        let browser = browsers
            .iter()
            .find(|browser| browser.control.borrow().as_deref() == Some(token))
            .ok_or(
                "Browser control is off. Ask the owner to allow control and provide a fresh token.",
            )?;
        if !browser.visible.get() {
            return Err("Show the browser before using agent control".into());
        }
        operation(browser)
    })
}

#[derive(Serialize)]
pub struct Grant {
    pub token: String,
    pub revision: u64,
}

#[tauri::command]
pub async fn browser_control_grant(app: AppHandle, session_id: String) -> Result<Grant, String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| {
            if !browser.visible.get() {
                return Err("Show the browser before allowing control".into());
            }
            let token = uuid::Uuid::new_v4().to_string();
            *browser.control.borrow_mut() = Some(token.clone());
            let revision = browser.control_revision.get() + 1;
            browser.control_revision.set(revision);
            Ok(Grant { token, revision })
        })
    })
    .await
}

#[tauri::command]
pub async fn browser_control_revoke(app: AppHandle, session_id: String) -> Result<(), String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| {
            browser.revoke_control();
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn browser_control_execute(
    app: AppHandle,
    token: String,
    request: Request,
) -> Result<Value, String> {
    request.validate()?;
    if token.len() != 36 {
        return Err("Invalid browser control token".into());
    }
    let checked_token = token.clone();
    let receiver = on_main_thread(&app, move || {
        permitted(&token, |browser| {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            if let Request::Navigate { url } = &request {
                browser.navigate(url)?;
                let _ = sender.send(Ok(serde_json::json!({"navigating": true})));
            } else {
                let script = format!(
                    "(() => {{ const operate = {}; return operate({}); }})()",
                    include_str!("control.js"),
                    serde_json::to_string(&request).map_err(|e| e.to_string())?
                );
                let sender = std::sync::Mutex::new(Some(sender));
                browser
                    .guest
                    .evaluate_script_with_callback(&script, move |result| {
                        let value = if result.len() > 131072 {
                            Err("Browser response exceeds 128 KiB".to_string())
                        } else {
                            Ok(result)
                        }
                        .and_then(|result| {
                            serde_json::from_str::<Value>(&result).map_err(|e| e.to_string())
                        })
                        .map_err(|e| e.to_string())
                        .and_then(|value| {
                            if let Some(error) = value.get("error").and_then(Value::as_str) {
                                Err(error.to_string())
                            } else {
                                Ok(value)
                            }
                        });
                        if let Some(sender) = sender.lock().expect("Browser callback lock").take() {
                            let _ = sender.send(value);
                        }
                    })
                    .map_err(|e| e.to_string())?;
            }
            Ok(receiver)
        })
    })
    .await?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "Browser operation timed out; inspect the page before retrying")?
        .map_err(|_| "Browser closed before replying")??;
    // A reply arriving after takeover must not disclose page contents.
    on_main_thread(&app, move || permitted(&checked_token, |_| Ok(result))).await
}

pub fn handle(request: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        browser_control_grant,
        browser_control_revoke,
        browser_control_execute
    ];
    handler(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_oversized_and_unknown_requests() {
        assert!(Request::Click {
            selector: "".into()
        }
        .validate()
        .is_err());
        assert!(Request::Fill {
            selector: "input".into(),
            text: "x".repeat(8193)
        }
        .validate()
        .is_err());
        assert!(
            serde_json::from_str::<Request>(r#"{"action":"observe","script":"evil"}"#).is_err()
        );
    }
}
