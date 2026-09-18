use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewBuilder, WebviewUrl, WindowBuilder,
};

fn invoke(
    webview: &tauri::Webview<MockRuntime>,
    command: &str,
    origin: &str,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    struct BorrowedWebview<'a>(&'a tauri::Webview<MockRuntime>);
    impl AsRef<tauri::Webview<MockRuntime>> for BorrowedWebview<'_> {
        fn as_ref(&self) -> &tauri::Webview<MockRuntime> {
            self.0
        }
    }
    get_ipc_response(
        &BorrowedWebview(webview),
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: origin.parse().unwrap(),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
}

#[test]
fn native_command_permissions_separate_main_controls_and_guest() {
    let app = mock_builder()
        // A marker handler proves which requests pass the real generated ACL,
        // without starting terminals, importing plugins or showing notifications.
        .invoke_handler(|request| {
            request.resolver.resolve("authorized");
            true
        })
        .build(super::app_context())
        .unwrap();
    let main_window = WindowBuilder::new(&app, "main").build().unwrap();
    let main = main_window
        .add_child(
            WebviewBuilder::new("main", WebviewUrl::default()),
            tauri::LogicalPosition::new(0, 0),
            tauri::LogicalSize::new(800, 600),
        )
        .unwrap();
    let browser_window = WindowBuilder::new(&app, "browser").build().unwrap();
    let controls = browser_window
        .add_child(
            WebviewBuilder::new("browser-controls", WebviewUrl::default()),
            tauri::LogicalPosition::new(0, 0),
            tauri::LogicalSize::new(800, 56),
        )
        .unwrap();
    // Production uses a raw Wry guest with no IPC. This simulated Tauri sibling
    // additionally catches window-wide grants accidentally added to the toolbar.
    let guest = browser_window
        .add_child(
            WebviewBuilder::new("browser-content", WebviewUrl::default()),
            tauri::LogicalPosition::new(0, 56),
            tauri::LogicalSize::new(800, 544),
        )
        .unwrap();

    let application_commands = [
        "notification_show",
        "terminal_create_owner",
        "terminal_spawn",
        "terminal_read",
        "terminal_write",
        "terminal_resize",
        "terminal_close",
        "terminal_close_owner",
        "plugin_import_folder",
        "plugin_import_git",
        "plugin_import_install",
        "plugin_import_discard",
        "plugin_catalog",
        "plugin_change",
        "plugin_module",
        "plugin_recover",
        "browser_open",
    ];
    let control_commands = ["browser_navigate", "browser_action", "browser_status"];
    let local_origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    for command in application_commands {
        assert!(invoke(&main, command, local_origin).is_ok(), "{command}");
        assert!(
            invoke(&controls, command, local_origin).is_err(),
            "controls must reject {command}"
        );
    }
    for command in control_commands {
        assert!(
            invoke(&controls, command, local_origin).is_ok(),
            "{command}"
        );
        assert!(
            invoke(&main, command, local_origin).is_err(),
            "main must use browser_open, not {command}"
        );
    }
    for command in application_commands.into_iter().chain(control_commands) {
        for origin in [local_origin, "https://example.org", "http://localhost:1430"] {
            assert!(
                invoke(&guest, command, origin).is_err(),
                "guest must reject {command} from {origin}"
            );
        }
        assert!(
            invoke(&controls, command, "https://example.org").is_err(),
            "remote content must not use toolbar grants: {command}"
        );
    }
}
