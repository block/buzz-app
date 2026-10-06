use tauri::{PhysicalPosition, PhysicalRect, PhysicalSize, Runtime, Window};
use tauri_plugin_window_state::{Builder, StateFlags, WindowExt};

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
        // Restore geometry and validate reachability before entering a saved mode.
        .skip_initial_state("main")
}

// Called from app setup, after the configured main window has been created.
pub(crate) fn restore<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    if let Err(error) = restore_geometry(window) {
        eprintln!("Could not restore Buzz window geometry: {error}");
    }
    window.restore_state(StateFlags::MAXIMIZED | StateFlags::FULLSCREEN)
}

fn restore_geometry<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    window.restore_state(StateFlags::SIZE | StateFlags::POSITION)?;
    let monitors = window.available_monitors()?;
    let areas: Vec<_> = monitors
        .iter()
        .map(|monitor| *monitor.work_area())
        .collect();
    let fallback = window
        .primary_monitor()?
        .map(|monitor| *monitor.work_area())
        .or_else(|| areas.first().copied());
    if let Some(fallback) = fallback {
        let frame = PhysicalRect {
            position: window.outer_position()?,
            size: window.outer_size()?,
        };
        // Client bounds exclude Windows' invisible DWM resize borders, which
        // legitimately extend outside the work area for edge-flush windows.
        let client = PhysicalRect {
            position: window.inner_position()?,
            size: window.inner_size()?,
        };
        // AppShell owns a 48 logical-pixel header on all desktop platforms.
        let header_height = (48.0 * window.scale_factor()?).ceil() as u32;
        if let Some(target) = reachable_frame(frame, client, header_height, &areas, fallback) {
            if target.size != frame.size {
                let inner = window.inner_size()?;
                window.set_size(PhysicalSize::new(
                    target
                        .size
                        .width
                        .saturating_sub(frame.size.width.saturating_sub(inner.width)),
                    target
                        .size
                        .height
                        .saturating_sub(frame.size.height.saturating_sub(inner.height)),
                ))?;
            }
            window.set_position(target.position)?;
        }
    }
    Ok(())
}

fn reachable_frame(
    frame: PhysicalRect<i32, u32>,
    client: PhysicalRect<i32, u32>,
    header_height: u32,
    areas: &[PhysicalRect<i32, u32>],
    fallback: PhysicalRect<i32, u32>,
) -> Option<PhysicalRect<i32, u32>> {
    let x = i64::from(client.position.x);
    let y = i64::from(client.position.y);
    let right = x + i64::from(client.size.width.saturating_sub(1));
    let bottom = y + i64::from(header_height.saturating_sub(1));
    // A header may span adjacent monitors. Both control regions must remain
    // reachable, but need not belong to the same monitor.
    let reachable = [(x, y), (right, y), (x, bottom), (right, bottom)]
        .into_iter()
        .all(|(x, y)| {
            areas.iter().any(|area| {
                x >= i64::from(area.position.x)
                    && y >= i64::from(area.position.y)
                    && x < i64::from(area.position.x) + i64::from(area.size.width)
                    && y < i64::from(area.position.y) + i64::from(area.size.height)
            })
        });
    if reachable {
        return None;
    }
    // Unlike any-corner intersection, this keeps the drag strip and both sets
    // of platform controls on-screen, including after removing an upper monitor.
    let size = PhysicalSize::new(
        frame.size.width.min(fallback.size.width),
        frame.size.height.min(fallback.size.height),
    );
    Some(PhysicalRect {
        position: PhysicalPosition::new(
            fallback
                .position
                .x
                .saturating_add(((fallback.size.width - size.width) / 2) as i32),
            fallback.position.y,
        ),
        size,
    })
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

    fn rect(x: i32, y: i32, width: u32, height: u32) -> tauri::PhysicalRect<i32, u32> {
        tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(x, y),
            size: tauri::PhysicalSize::new(width, height),
        }
    }

    fn assert_frame(
        actual: Option<tauri::PhysicalRect<i32, u32>>,
        expected: Option<tauri::PhysicalRect<i32, u32>>,
    ) {
        assert_eq!(
            actual.map(|r| (r.position, r.size)),
            expected.map(|r| (r.position, r.size))
        );
    }

    #[test]
    fn partial_overlap_after_removing_upper_monitor_recovers_entire_header() {
        let laptop = rect(0, 25, 1440, 875);
        let saved = rect(100, -450, 960, 640);
        assert_frame(
            super::reachable_frame(saved, saved, 48, &[laptop], laptop),
            Some(rect(240, 25, 960, 640)),
        );
        let upper = rect(0, -900, 1440, 900);
        assert_frame(
            super::reachable_frame(saved, saved, 48, &[laptop, upper], laptop),
            None,
        );
    }

    #[test]
    fn reachable_geometry_is_unchanged_including_negative_coordinates() {
        let primary = rect(0, 25, 1440, 875);
        let left = rect(-1920, 0, 1920, 1080);
        for saved in [rect(100, 120, 960, 640), rect(-1800, 80, 960, 640)] {
            assert_frame(
                super::reachable_frame(saved, saved, 48, &[primary, left], primary),
                None,
            );
        }
    }

    #[test]
    fn side_overlap_and_menu_bar_occlusion_recover_controls_not_just_a_corner() {
        let area = rect(0, 25, 1440, 875);
        for saved in [
            rect(-600, 100, 960, 640),
            rect(1300, 100, 960, 640),
            rect(100, 0, 960, 640),
            rect(100, 860, 960, 640),
        ] {
            assert_frame(
                super::reachable_frame(saved, saved, 48, &[area], area),
                Some(rect(240, 25, 960, 640)),
            );
        }
    }

    #[test]
    fn oversized_window_fits_remaining_work_area_and_scaled_header_is_checked() {
        let area = rect(0, 50, 1440, 850);
        assert_frame(
            super::reachable_frame(
                rect(0, 50, 2800, 1800),
                rect(0, 50, 2800, 1800),
                96,
                &[area],
                area,
            ),
            Some(area),
        );
        assert_frame(
            super::reachable_frame(
                rect(100, 820, 960, 640),
                rect(100, 820, 960, 640),
                48,
                &[area],
                area,
            ),
            None,
        );
        assert_frame(
            super::reachable_frame(
                rect(100, 820, 960, 640),
                rect(100, 820, 960, 640),
                96,
                &[area],
                area,
            ),
            Some(rect(240, 50, 960, 640)),
        );
    }

    #[test]
    fn invisible_windows_frame_border_does_not_displace_edge_flush_client() {
        let area = rect(0, 0, 1920, 1040);
        assert_frame(
            super::reachable_frame(
                rect(-7, 0, 1934, 1047),
                rect(0, 0, 1920, 1040),
                48,
                &[area],
                area,
            ),
            None,
        );
    }

    #[test]
    fn header_can_span_adjacent_monitors_but_not_extend_above_either() {
        let left = rect(-1920, 0, 1920, 1080);
        let right = rect(0, 0, 1920, 1080);
        let spanning = rect(-480, 100, 960, 640);
        assert_frame(
            super::reachable_frame(spanning, spanning, 48, &[left, right], right),
            None,
        );
        let below = rect(0, 300, 1920, 1080);
        assert_frame(
            super::reachable_frame(spanning, spanning, 48, &[left, below], left),
            Some(rect(-1440, 0, 960, 640)),
        );
    }

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
            plugin.window_created(window.clone());
            if label == "main" {
                super::restore(&window).unwrap();
            }
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
        super::restore(&view.as_ref().window()).unwrap();
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
            plugin.window_created(window.clone());
            super::restore(&window).unwrap();
            plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
            let state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert!(state.get("main").is_some());
        }
    }
}
