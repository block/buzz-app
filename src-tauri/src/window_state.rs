use tauri_plugin_window_state::{Builder, StateFlags};

pub(crate) fn builder() -> Builder {
    Builder::default()
        // Closing on macOS hides the window. Never persist that hidden state or
        // platform-owned decorations; a fresh launch must remain reachable.
        .with_state_flags(
            StateFlags::SIZE
                | StateFlags::POSITION
                | StateFlags::MAXIMIZED
                | StateFlags::FULLSCREEN,
        )
        .with_filter(|label| label == "main")
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tauri::{
        plugin::Plugin,
        test::{mock_builder, mock_context, noop_assets, MockRuntime},
        Manager,
    };
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};

    fn fixture() -> (tempfile::TempDir, tauri::App<MockRuntime>) {
        let dir = tempfile::tempdir().unwrap();
        let mut context = mock_context(noop_assets());
        // Absolute identifiers keep the plugin's real config-file IO inside the
        // fixture without changing process-global HOME or touching user state.
        context.config_mut().identifier = dir.path().to_string_lossy().into_owned();
        let app = mock_builder().build(context).unwrap();
        assert_eq!(app.path().app_config_dir().unwrap(), dir.path());
        (dir, app)
    }

    #[test]
    fn exit_saves_only_the_main_window() {
        let (dir, app) = fixture();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        for label in ["main", "other"] {
            let window = tauri::WindowBuilder::new(&app, label).build().unwrap();
            plugin.window_created(window);
        }
        plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
        let state: Value = serde_json::from_slice(
            &std::fs::read(dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME)).unwrap(),
        )
        .unwrap();
        assert_eq!(state.as_object().unwrap().len(), 1);
        assert!(state.get("main").is_some());
    }

    #[test]
    fn reload_keeps_geometry_without_restoring_visibility_or_decorations() {
        let (dir, app) = fixture();
        let path = dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME);
        let saved = json!({"main": {
            "width": 960, "height": 640, "x": 100, "y": 120,
            "prev_x": 100, "prev_y": 120, "maximized": true,
            "fullscreen": true, "visible": false, "decorated": false
        }});
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        plugin.window_created(view.as_ref().window().clone());
        app.handle().save_window_state(StateFlags::empty()).unwrap();
        let loaded: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded, saved);

        // MockRuntime reports false modes, true visibility/decorations, zero
        // size/position. Exit must update modes/position, keep the last nonzero
        // size, and leave visibility/decorations alone. Native restore itself
        // needs OS acceptance: MockRuntime's geometry setters are no-ops.
        plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
        let stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["main"]["width"], 960);
        assert_eq!(stored["main"]["height"], 640);
        assert_eq!(stored["main"]["x"], 0);
        assert_eq!(stored["main"]["y"], 0);
        assert_eq!(stored["main"]["maximized"], false);
        assert_eq!(stored["main"]["fullscreen"], false);
        assert_eq!(stored["main"]["visible"], false);
        assert_eq!(stored["main"]["decorated"], false);
    }

    #[test]
    fn missing_or_corrupt_state_does_not_block_window_creation() {
        for contents in [None, Some("not json")] {
            let (dir, app) = fixture();
            let path = dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME);
            if let Some(contents) = contents {
                std::fs::write(&path, contents).unwrap();
            }
            let mut plugin = super::builder().build();
            plugin.initialize(app.handle(), Value::Null).unwrap();
            let window = tauri::WindowBuilder::new(&app, "main").build().unwrap();
            plugin.window_created(window);
            plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
            let state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert!(state.get("main").is_some());
        }
    }
}
