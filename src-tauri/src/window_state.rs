use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime, Window};
use tauri_plugin_window_state::{AppHandleExt, Builder, StateFlags, WindowExt};

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
const INTRO_GEOMETRY: &str = "onboarding-window-restore.json";
// The plugin saves physical pixels without the scales they were measured at.
// Buzz records them beside each save, as
// {"main": {"scale": 2.0, "position": 1.0, "prev": 2.0, "geometry": [...]}}
// (see `SavedScale`). `geometry` names the save the scales belong to, so a
// geometry file written without them (by an older build, or before an exit
// finished) never takes a stale scale.
const SCALE: &str = ".window-scale.json";
const INTRO_SCALE: &str = "onboarding-window-scale.json";

/// Preserve normal geometry for the next launch, without resizing this session.
#[tauri::command]
pub(crate) fn onboarding_preserve_window<R: Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Main window required".into());
    }
    // MockRuntime has no NSView to receive AppKit messages.
    #[cfg(all(target_os = "macos", not(test)))]
    {
        let native = window.ns_window().map_err(|error| error.to_string())?;
        let native: &objc2_app_kit::NSWindow = unsafe { &*native.cast() };
        native.setAnimationBehavior(objc2_app_kit::NSWindowAnimationBehavior::None);
        // Undo `opaque_background` while still hidden: the intro shows the desktop.
        native.setBackgroundColor(Some(&objc2_app_kit::NSColor::clearColor()));
    }
    let app = window.app_handle();
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let target = dir.join(INTRO_GEOMETRY);
    if target.exists() {
        return Ok(());
    }
    app.save_window_state(
        StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN,
    )
    .map_err(|e| e.to_string())?;
    save_scale(app);
    let bytes = std::fs::read(dir.join(app.filename())).map_err(|e| e.to_string())?;
    preserve_intro_geometry(&target, &bytes)?;
    // The snapshot copies the plugin's file, so it takes the scale paired with it.
    if let Err(error) = std::fs::copy(dir.join(SCALE), dir.join(INTRO_SCALE)) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("Could not save Buzz window scale: {error}");
        }
    }
    Ok(())
}

/// The scales of the plugin's cached frame: its size, its position, and the
/// position before that (`prev_x`/`prev_y`, used for a maximized window). The
/// plugin updates size and position on different events, so each keeps its own.
/// They start from the scale file, as the plugin's cache starts from its file.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Kept {
    size: Option<f64>,
    position: Option<f64>,
    prev: Option<f64>,
}

/// `restoring` mirrors the plugin's restore lock, held while `restore_state`
/// runs: the plugin ignores Moved and Resized meanwhile.
#[derive(Default)]
struct KeptScale {
    kept: std::sync::Mutex<Kept>,
    restoring: std::sync::atomic::AtomicBool,
}

fn kept_scale<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::State<'_, KeptScale> {
    if app.try_state::<KeptScale>().is_none() {
        let file = app
            .path()
            .app_config_dir()
            .ok()
            .and_then(|dir| restore_input(&dir, &app.filename(), "main", false)?.1);
        let kept = file.map_or_else(Kept::default, |saved| Kept {
            size: Some(saved.scale),
            position: Some(saved.position()),
            prev: Some(saved.prev()),
        });
        app.manage(KeptScale {
            kept: std::sync::Mutex::new(kept),
            ..Default::default()
        });
    }
    app.state::<KeptScale>()
}

/// An update of the plugin's cached frame (window-state 2.5.0).
#[derive(Clone, Copy, Debug)]
enum Update {
    /// `Moved`: position, unless minimized; the old position becomes `prev`.
    Moved,
    /// `Resized`: size, unless minimized or maximized.
    Resized,
    /// `CloseRequested` and the save at Exit: size and position, unless
    /// minimized or maximized.
    Saved,
}

/// What the plugin reads from the window for an update.
#[derive(Clone, Copy, Debug)]
struct Frame {
    maximized: bool,
    minimized: bool,
    scale: f64,
}

impl Kept {
    fn apply(&mut self, update: Update, frame: Frame) {
        let reads_frame = !frame.maximized && !frame.minimized;
        match update {
            Update::Moved if !frame.minimized => {
                self.prev = self.position;
                self.position = Some(frame.scale);
            }
            Update::Resized if reads_frame => self.size = Some(frame.scale),
            Update::Saved if reads_frame => {
                self.size = Some(frame.scale);
                self.position = Some(frame.scale);
            }
            _ => {}
        }
    }
}

/// Follows the plugin's cache: call it for each main-window event.
pub(crate) fn window_event<R: Runtime>(window: &Window<R>, event: &tauri::WindowEvent) {
    let update = match event {
        tauri::WindowEvent::Moved(_) => Update::Moved,
        tauri::WindowEvent::Resized(_) => Update::Resized,
        tauri::WindowEvent::CloseRequested { .. } => Update::Saved,
        _ => return,
    };
    follow(window, update);
}

fn follow<R: Runtime>(window: &Window<R>, update: Update) {
    let read = || -> tauri::Result<Frame> {
        // tauri#5812: on Resized, the plugin treats an undecorated or fixed-size
        // macOS window as never maximized.
        let quirk = matches!(update, Update::Resized)
            && cfg!(target_os = "macos")
            && (!window.is_decorated()? || !window.is_resizable()?);
        Ok(Frame {
            maximized: !quirk && window.is_maximized()?,
            minimized: window.is_minimized()?,
            scale: window.scale_factor()?,
        })
    };
    if window.label() != "main" {
        return;
    }
    let kept = kept_scale(window.app_handle());
    let restoring = kept.restoring.load(std::sync::atomic::Ordering::SeqCst);
    if restoring && matches!(update, Update::Moved | Update::Resized) {
        return;
    }
    if let Ok(frame) = read() {
        kept.kept.lock().unwrap().apply(update, frame);
    }
}

/// Record the scales beside a save of the plugin's file (Exit or onboarding),
/// after the plugin's save has updated its cache.
pub(crate) fn save_scale<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        follow(&window.as_ref().window(), Update::Saved);
    }
    write_kept_scale(app);
}

fn write_kept_scale<R: Runtime>(app: &tauri::AppHandle<R>) {
    let kept = *kept_scale(app).kept.lock().unwrap();
    let Some(scale) = kept.size else {
        return;
    };
    let result = app.path().app_config_dir().and_then(|dir| {
        // Name the save these scales belong to: the plugin's file, just written.
        let Some(saved) = std::fs::read(dir.join(app.filename()))
            .ok()
            .and_then(|bytes| saved_geometry(&bytes, "main"))
        else {
            return Ok(());
        };
        let saved = SavedScale {
            scale,
            position: kept.position,
            prev: kept.prev,
            geometry: Some(saved.pairing()),
        };
        let scale = HashMap::from([("main", saved)]);
        std::fs::write(dir.join(SCALE), serde_json::to_vec(&scale)?)?;
        Ok(())
    });
    if let Err(error) = result {
        eprintln!("Could not save Buzz window scale: {error}");
    }
}

/// `scale` is the size's. A missing `position` is at the size's scale, and a
/// missing `prev` at the position's.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
struct SavedScale {
    scale: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    position: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prev: Option<f64>,
    /// The saved geometry these scales belong to (`SavedGeometry::pairing`).
    #[serde(default)]
    geometry: Option<[i64; 6]>,
}

impl SavedScale {
    fn position(&self) -> f64 {
        self.position.unwrap_or(self.scale)
    }

    fn prev(&self) -> f64 {
        self.prev.unwrap_or(self.position())
    }
}

fn saved_scale(bytes: &[u8], label: &str) -> Option<SavedScale> {
    let valid = |scale: f64| scale.is_finite() && scale > 0.0;
    serde_json::from_slice::<HashMap<String, SavedScale>>(bytes)
        .ok()?
        .remove(label)
        .filter(|saved| valid(saved.scale) && valid(saved.position()) && valid(saved.prev()))
}

/// The Mac window shows `--bg-app` (tokens.css) under the page instead of the
/// desktop, so it is solid before first paint and if WebKit never paints. Only
/// the first-welcome intro is see-through: `onboarding_preserve_window` clears
/// this again before the intro shows the window.
#[cfg(target_os = "macos")]
pub(crate) fn opaque_background<R: Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    use objc2_app_kit::{NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSColor};
    let native: &objc2_app_kit::NSWindow = unsafe { &*window.ns_window()?.cast() };
    let srgb = |r: f64, g: f64, b: f64| {
        NSColor::colorWithSRGBRed_green_blue_alpha(r / 255.0, g / 255.0, b / 255.0, 1.0)
    };
    // Resolved by the system appearance: Buzz's own light/dark choice is page
    // state, so it can differ until the page paints.
    let (light, dark) = (srgb(241.0, 241.0, 242.0), srgb(16.0, 16.0, 16.0));
    let provider = block2::RcBlock::new(move |appearance: std::ptr::NonNull<NSAppearance>| {
        let names = unsafe { [NSAppearanceNameAqua, NSAppearanceNameDarkAqua] };
        let best = unsafe { appearance.as_ref() }
            .bestMatchFromAppearancesWithNames(&objc2_foundation::NSArray::from_slice(&names));
        let color = if best.as_deref() == Some(names[1]) {
            &dark
        } else {
            &light
        };
        // The block owns both colours, and the dynamic colour retains the block.
        std::ptr::NonNull::from(&**color)
    });
    let color = unsafe { NSColor::colorWithName_dynamicProvider(None, &provider) };
    native.setBackgroundColor(Some(&color));
    Ok(())
}

fn preserve_intro_geometry(target: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if target.exists() {
        return Ok(());
    }
    if saved_geometry(bytes, "main").is_none() {
        return Err("Window geometry unavailable".into());
    }
    std::fs::write(target, bytes).map_err(|e| e.to_string())
}

pub(crate) fn restore<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    // Read the scale file before restore's own resizes update the kept scales.
    kept_scale(window.app_handle());
    let dir = window.app_handle().path().app_config_dir()?;
    let filename = window.app_handle().filename();
    if let Some((saved, scales)) = restore_input(&dir, &filename, window.label(), true) {
        let (fullscreen, maximized) = (saved.fullscreen, saved.maximized);
        window.set_fullscreen(false)?;
        window.unmaximize()?;
        restore_geometry(window, saved, scales)?;
        window.set_fullscreen(fullscreen)?;
        if maximized {
            window.maximize()?;
        }
        std::fs::remove_file(dir.join(INTRO_GEOMETRY))?;
        let _ = std::fs::remove_file(dir.join(INTRO_SCALE));
        return Ok(());
    }
    if let Some((saved, scales)) = restore_input(&dir, &filename, window.label(), false) {
        if let Err(error) = restore_geometry(window, saved, scales) {
            eprintln!("Could not restore Buzz window geometry: {error}");
        }
    }
    let kept = kept_scale(window.app_handle());
    kept.restoring
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let result = window.restore_state(StateFlags::MAXIMIZED | StateFlags::FULLSCREEN);
    kept.restoring
        .store(false, std::sync::atomic::Ordering::SeqCst);
    result
}

/// The geometry to restore and the scales recorded with it: the onboarding
/// snapshot (`intro`) and its scale copy, or the plugin's file and Buzz's.
fn restore_input(
    dir: &std::path::Path,
    filename: &str,
    label: &str,
    intro: bool,
) -> Option<(SavedGeometry, Option<SavedScale>)> {
    let (geometry, scale) = if intro {
        (INTRO_GEOMETRY, INTRO_SCALE)
    } else {
        (filename, SCALE)
    };
    let saved = saved_geometry(&std::fs::read(dir.join(geometry)).ok()?, label)?;
    // Scales recorded for another save are stale: restore as without them.
    let scales = std::fs::read(dir.join(scale))
        .ok()
        .and_then(|bytes| saved_scale(&bytes, label))
        .filter(|scales| scales.geometry == Some(saved.pairing()));
    Some((saved, scales))
}

// Read-only adapter for window-state 2.4.1's format: position is the outer
// origin, size is the client size, and maximized windows use prev_x/prev_y.
// Keep all required fields typed so corrupt state falls back just as it does
// in the plugin. The plugin remains the only writer and mode/lifecycle owner.
#[derive(Deserialize)]
struct SavedGeometry {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    prev_x: i32,
    prev_y: i32,
    maximized: bool,
    #[serde(rename = "visible")]
    _visible: bool,
    #[serde(rename = "decorated")]
    _decorated: bool,
    #[serde(rename = "fullscreen")]
    fullscreen: bool,
}

impl SavedGeometry {
    /// The numbers a restore converts, which name this save in the scale file.
    fn pairing(&self) -> [i64; 6] {
        [
            self.width.into(),
            self.height.into(),
            self.x.into(),
            self.y.into(),
            self.prev_x.into(),
            self.prev_y.into(),
        ]
    }
}

fn saved_geometry(bytes: &[u8], label: &str) -> Option<SavedGeometry> {
    serde_json::from_slice::<HashMap<String, SavedGeometry>>(bytes)
        .ok()?
        .remove(label)
        .filter(|state| state.width > 0 && state.height > 0)
}

fn restore_geometry<R: Runtime>(
    window: &Window<R>,
    saved: SavedGeometry,
    scales: Option<SavedScale>,
) -> tauri::Result<()> {
    let monitors = window.available_monitors()?;
    let areas: Vec<_> = monitors
        .iter()
        .map(|monitor| (*monitor.work_area(), monitor.scale_factor()))
        .collect();
    let fallback = window
        .primary_monitor()?
        .or_else(|| monitors.first().cloned())
        .map(|monitor| (*monitor.work_area(), monitor.scale_factor()));
    if let Some(fallback) = fallback {
        // Only the client-to-frame origin offset is needed. Linux's initial
        // outer_size is not reliable until its first configure event.
        let outer = window.outer_position()?;
        let inner = window.inner_position()?;
        let offset = PhysicalPosition::new(
            inner.x.saturating_sub(outer.x),
            inner.y.saturating_sub(outer.y),
        );
        let windows = &window.config().app.windows;
        let config = windows.first().cloned().unwrap_or_default();
        let startup = window.scale_factor()?;
        let (position, size, logical) =
            restore_plan(saved, scales, offset, startup, &areas, fallback, &config);
        // Validate the requested geometry BEFORE sending it. Native setters
        // may apply asynchronously (Linux/macOS); getters can still report the
        // startup frame.
        // Move first: Windows rescales on DPI change. macOS/GTK convert at the startup scale.
        if let Some(scale) = logical.filter(|_| cfg!(not(windows))) {
            window.set_position(position.to_logical::<f64>(scale))?;
            return window.set_size(size.to_logical::<f64>(scale));
        }
        window.set_position(position)?;
        window.set_size(size)?;
    }
    Ok(())
}

/// The restore request for saved geometry and the scales recorded with it.
fn restore_plan(
    saved: SavedGeometry,
    scales: Option<SavedScale>,
    client_offset: PhysicalPosition<i32>,
    startup: f64,
    monitors: &[(PhysicalRect<i32, u32>, f64)],
    fallback: (PhysicalRect<i32, u32>, f64),
    config: &tauri::utils::config::WindowConfig,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>, Option<f64>) {
    // Windows rescales on DPI change, so it keeps sending physical pixels.
    let scales = scales.filter(|_| cfg!(not(windows)));
    let saved = at_size_scale(saved, scales);
    let recorded = scales.map(|scales| scales.scale);
    restore_request(
        &saved,
        recorded,
        client_offset,
        startup,
        monitors,
        fallback,
        config,
    )
}

/// Expresses the saved positions in the size's pixels, each from its own scale.
fn at_size_scale(mut saved: SavedGeometry, scales: Option<SavedScale>) -> SavedGeometry {
    if let Some(scales) = scales {
        let rescale = |x: i32, y: i32, from: f64| {
            let position = PhysicalPosition::new(x, y)
                .to_logical::<f64>(from)
                .to_physical::<i32>(scales.scale);
            (position.x, position.y)
        };
        (saved.x, saved.y) = rescale(saved.x, saved.y, scales.position());
        (saved.prev_x, saved.prev_y) = rescale(saved.prev_x, saved.prev_y, scales.prev());
    }
    saved
}

/// Plans the restore in the saved rect's pixels. With the recorded save-time
/// scale, monitors are measured in those pixels too, and the result is sent as
/// logical units at that scale. Without it, the plan is in mixed units, as before.
fn restore_request(
    saved: &SavedGeometry,
    recorded: Option<f64>,
    client_offset: PhysicalPosition<i32>,
    startup: f64,
    monitors: &[(PhysicalRect<i32, u32>, f64)],
    (fallback, scale): (PhysicalRect<i32, u32>, f64),
    config: &tauri::utils::config::WindowConfig,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>, Option<f64>) {
    let rebase = |(area, from): (PhysicalRect<i32, u32>, f64)| match recorded {
        Some(to) => PhysicalRect {
            position: area.position.to_logical::<f64>(from).to_physical(to),
            size: area.size.to_logical::<f64>(from).to_physical(to),
        },
        None => area,
    };
    let areas: Vec<_> = monitors.iter().copied().map(rebase).collect();
    let fallback = rebase((fallback, scale));
    let client_offset = match recorded {
        Some(to) => client_offset.to_logical::<f64>(startup).to_physical(to),
        None => client_offset,
    };
    // AppShell owns a 48 logical-pixel header on all desktop platforms.
    let header_height = (48.0 * recorded.unwrap_or(startup)).ceil() as u32;
    let position = if saved.maximized {
        PhysicalPosition::new(saved.prev_x, saved.prev_y)
    } else {
        PhysicalPosition::new(saved.x, saved.y)
    };
    let client = PhysicalRect {
        position: PhysicalPosition::new(
            position.x.saturating_add(client_offset.x),
            position.y.saturating_add(client_offset.y),
        ),
        size: PhysicalSize::new(saved.width, saved.height),
    };
    // Without a recorded scale, a size below the minimum at the fallback's scale (rounded
    // as tao rounds it) was saved at a lower scale and would reopen below it. Windows
    // applies the minimum to the frame: take off tao's shadow insets (default metrics,
    // Windows 11 top).
    let win = u32::from(cfg!(windows));
    let side = win * (4 * (scale * 96.0).round() as u32 + 48) / 96 * 2;
    let top = win * scale.round() as u32;
    let px = |logical: Option<f64>| (logical.unwrap_or(0.0) * scale).round() as u32;
    let below = recorded.is_none()
        && (saved.width < px(config.min_width).saturating_sub(2 * side)
            || saved.height < px(config.min_height).saturating_sub(side + top));
    let default = below.then(|| LogicalSize::new(config.width, config.height).to_physical(scale));
    let relocated = reachable_client(client, header_height, &areas, fallback, default);
    let target = relocated.unwrap_or(client);
    (
        PhysicalPosition::new(
            target.position.x.saturating_sub(client_offset.x),
            target.position.y.saturating_sub(client_offset.y),
        ),
        target.size,
        recorded.or(relocated.map(|_| scale)),
    )
}

fn reachable_client(
    mut client: PhysicalRect<i32, u32>,
    header_height: u32,
    areas: &[PhysicalRect<i32, u32>],
    fallback: PhysicalRect<i32, u32>,
    default: Option<PhysicalSize<u32>>,
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
    // A lone monitor's scale is known, so a sub-minimum size is replaced even there.
    if reachable && !(default.is_some() && areas.len() == 1) {
        return None;
    }
    client.size = default.unwrap_or(client.size);
    // Unlike any-corner intersection, this keeps the drag strip and both sets
    // of platform controls on-screen, including after removing an upper monitor.
    let size = PhysicalSize::new(
        client.size.width.min(fallback.size.width),
        client.size.height.min(fallback.size.height),
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

    // Mirrors the main window in tauri.conf.json.
    fn config() -> tauri::utils::config::WindowConfig {
        tauri::utils::config::WindowConfig {
            width: 1200.0,
            height: 800.0,
            min_width: Some(480.0),
            min_height: Some(400.0),
            ..Default::default()
        }
    }

    #[test]
    fn saved_size_is_kept_with_monitors_attached_and_recovered_on_a_lone_monitor() {
        let external = rect(1512, 0, 1920, 1080);
        let laptop = rect(0, 50, 3024, 1840);
        let saved = decode(&saved_state(1600, 100, 602, 470));
        let offset = tauri::PhysicalPosition::new(0, 0);
        let request = |areas: &[(tauri::PhysicalRect<i32, u32>, f64)]| {
            super::restore_request(&saved, None, offset, 2.0, areas, (laptop, 2.0), &config())
        };
        // The 1x external overlaps the 2x laptop's physical rect, so the scale
        // this rect was saved at is ambiguous. Keep it as saved.
        assert_eq!(
            request(&[(laptop, 2.0), (external, 1.0)]),
            (
                tauri::PhysicalPosition::new(1600, 100),
                tauri::PhysicalSize::new(602, 470),
                None
            ),
        );
        // Unplugged: the laptop's physical rect still contains the saved rect,
        // but 301x235 points is below the minimum at its known scale. Send the
        // default in the laptop's logical units.
        assert_eq!(
            request(&[(laptop, 2.0)]),
            (
                tauri::PhysicalPosition::new(312, 50),
                tauri::PhysicalSize::new(2400, 1600),
                Some(2.0)
            ),
        );
    }

    // The issue #3083 layout: a 2x laptop (1512x982 points) with a 1x external
    // to its right. Their physical rects overlap from x 1512 to 3024.
    fn mixed_scale_monitors() -> [(tauri::PhysicalRect<i32, u32>, f64); 2] {
        [
            (rect(0, 66, 3024, 1898), 2.0),
            (rect(1512, -317, 3440, 1415), 1.0),
        ]
    }

    fn logical_request(
        saved: &super::SavedGeometry,
        recorded: Option<f64>,
        startup: f64,
        monitors: &[(tauri::PhysicalRect<i32, u32>, f64)],
    ) -> (tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>) {
        let offset = tauri::PhysicalPosition::new(0, 0);
        let (position, size, scale) = super::restore_request(
            saved,
            recorded,
            offset,
            startup,
            monitors,
            monitors[0],
            &config(),
        );
        let scale = scale.expect("sent in logical units");
        (position.to_logical(scale), size.to_logical(scale))
    }

    #[test]
    fn recorded_scale_restores_logical_frame_whichever_screen_starts_the_window() {
        let monitors = mixed_scale_monitors();
        // Saved on the 2x laptop at 1200x750 points, relaunched on the 1x external.
        let laptop = decode(&saved_state(200, 66, 2400, 1500));
        assert_eq!(
            logical_request(&laptop, Some(2.0), 1.0, &monitors),
            (
                tauri::LogicalPosition::new(100.0, 33.0),
                tauri::LogicalSize::new(1200.0, 750.0)
            ),
        );
        // Saved on the 1x external, relaunched on the 2x laptop.
        let external = decode(&saved_state(2212, -317, 2323, 1089));
        assert_eq!(
            logical_request(&external, Some(1.0), 2.0, &monitors),
            (
                tauri::LogicalPosition::new(2212.0, -317.0),
                tauri::LogicalSize::new(2323.0, 1089.0)
            ),
        );
        // A 1x save below the minimum at 2x is kept: its points are known.
        let small = decode(&saved_state(2212, 100, 602, 470));
        assert_eq!(
            logical_request(&small, Some(1.0), 2.0, &monitors).1,
            tauri::LogicalSize::new(602.0, 470.0),
        );
    }

    #[test]
    fn recorded_scale_measures_reachability_in_points_after_unplugging() {
        // Saved on the 1x external, which is gone. Its pixels still fall in the
        // laptop's physical rect, but its points are right of the laptop.
        let saved = decode(&saved_state(2212, 100, 1000, 600));
        let laptop = &mixed_scale_monitors()[..1];
        assert_eq!(
            logical_request(&saved, Some(1.0), 2.0, laptop),
            (
                tauri::LogicalPosition::new(256.0, 33.0),
                tauri::LogicalSize::new(1000.0, 600.0)
            ),
        );
    }

    #[test]
    fn without_a_recorded_scale_the_request_is_unchanged() {
        let monitors = mixed_scale_monitors();
        let offset = tauri::PhysicalPosition::new(0, 0);
        let saved = decode(&saved_state(200, 66, 2400, 1500));
        // Reachable: sent as physical pixels, which macOS converts at the startup scale.
        assert_eq!(
            super::restore_request(&saved, None, offset, 1.0, &monitors, monitors[0], &config()),
            (
                tauri::PhysicalPosition::new(200, 66),
                tauri::PhysicalSize::new(2400, 1500),
                None
            ),
        );
    }

    #[test]
    fn fallback_uses_default_size_when_saved_size_is_below_minimum_at_its_scale() {
        let laptop = rect(0, 50, 3024, 1840);
        let left = rect(-3024, 0, 3024, 1964);
        let fallback = |width, height, area| {
            let saved = decode(&saved_state(5530, 100, width, height));
            let offset = tauri::PhysicalPosition::new(0, 0);
            let (position, size, scale) = super::restore_request(
                &saved,
                None,
                offset,
                2.0,
                &[(area, 2.0), (left, 2.0)],
                (area, 2.0),
                &config(),
            );
            assert_eq!(scale, Some(2.0));
            Some(tauri::PhysicalRect { position, size })
        };
        // Saved on a 1x monitor that is gone: 301x235 points on a 2x laptop.
        assert_frame(fallback(602, 470, laptop), Some(rect(312, 50, 2400, 1600)));
        // One axis below the minimum is enough (781 is under the Windows client too).
        assert_frame(fallback(960, 781, laptop), Some(rect(312, 50, 2400, 1600)));
        // At or above the minimum at the fallback's scale, the saved size stays.
        assert_frame(fallback(960, 800, laptop), Some(rect(1032, 50, 960, 800)));
        // The default still fits inside a small fallback work area.
        let small = rect(0, 25, 1440, 875);
        assert_frame(fallback(602, 470, small), Some(small));
    }

    #[test]
    fn minimum_allows_windows_shadow_insets_but_a_lower_scale_size_is_replaced() {
        let area = rect(0, 0, 3840, 2160);
        let offset = tauri::PhysicalPosition::new(0, 0);
        let relocated = |scale, width, height| {
            let saved = decode(&saved_state(100, 100, width, height));
            super::restore_request(
                &saved,
                None,
                offset,
                2.0,
                &[(area, scale)],
                (area, scale),
                &config(),
            )
            .2
            .is_some()
        };
        // tao applies the 480x400 minimum to an undecorated Windows frame. The
        // shadow insets (size frame plus padded border on the sides and bottom,
        // one scaled pixel on top on Windows 11) come off the saved client.
        for (scale, width, height) in [(1.0, 464, 391), (1.25, 580, 489), (2.0, 928, 782)] {
            assert_eq!(relocated(scale, width, height), !cfg!(windows));
        }
        // One pixel under that client is replaced everywhere.
        assert!(relocated(1.0, 463, 391));
        assert!(relocated(1.0, 464, 390));
        assert!(relocated(2.0, 927, 782));
        // Neither tao on Windows nor macOS clamps a programmatic resize, so a 1x
        // save of 900x750 would open at 450x375 points on a 2x laptop.
        assert!(relocated(2.0, 900, 750));
        // At 110 DPI the minimum rounds to 550x458, and the Windows client to 530x447.
        let scale = 110.0 / 96.0;
        assert!(!relocated(scale, 550, 458));
        assert_eq!(relocated(scale, 550, 457), !cfg!(windows));
        assert_eq!(relocated(scale, 530, 447), !cfg!(windows));
        assert!(relocated(scale, 529, 447));
        // At 100 DPI the height rounds up (416.67 to 417; 408 on Windows).
        let scale = 100.0 / 96.0;
        assert_eq!(relocated(scale, 500, 416), !cfg!(windows));
        assert!(relocated(scale, 484, 407));
        // A client saved at the minimum one scale step lower is replaced
        // everywhere, including across the smallest step, 225% to 250%.
        assert!(relocated(1.25, 464, 391));
        assert!(relocated(2.5, 1044, 880));
        assert!(relocated(2.5, 1080, 900));
        assert!(!relocated(2.0, 960, 800));
    }

    #[test]
    fn partial_overlap_after_removing_upper_monitor_recovers_entire_header() {
        let laptop = rect(0, 25, 1440, 875);
        let saved = rect(100, -450, 960, 640);
        assert_frame(
            super::reachable_client(saved, 48, &[laptop], laptop, None),
            Some(rect(240, 25, 960, 640)),
        );
        let upper = rect(0, -900, 1440, 900);
        assert_frame(
            super::reachable_client(saved, 48, &[laptop, upper], laptop, None),
            None,
        );
    }

    #[test]
    fn reachable_geometry_is_unchanged_including_negative_coordinates() {
        let primary = rect(0, 25, 1440, 875);
        let left = rect(-1920, 0, 1920, 1080);
        for saved in [rect(100, 120, 960, 640), rect(-1800, 80, 960, 640)] {
            assert_frame(
                super::reachable_client(saved, 48, &[primary, left], primary, None),
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
                super::reachable_client(saved, 48, &[area], area, None),
                Some(rect(240, 25, 960, 640)),
            );
        }
    }

    #[test]
    fn oversized_window_fits_remaining_work_area_and_scaled_header_is_checked() {
        let area = rect(0, 50, 1440, 850);
        assert_frame(
            super::reachable_client(rect(0, 50, 2800, 1800), 96, &[area], area, None),
            Some(area),
        );
        assert_frame(
            super::reachable_client(rect(100, 820, 960, 640), 48, &[area], area, None),
            None,
        );
        assert_frame(
            super::reachable_client(rect(100, 820, 960, 640), 96, &[area], area, None),
            Some(rect(240, 50, 960, 640)),
        );
    }

    #[test]
    fn invisible_windows_frame_border_does_not_displace_edge_flush_client() {
        let area = rect(0, 0, 1920, 1040);
        let saved = decode(&saved_state(-7, 0, 1920, 1040));
        assert_eq!(
            super::restore_request(
                &saved,
                None,
                tauri::PhysicalPosition::new(7, 0),
                1.0,
                &[(area, 1.0)],
                (area, 1.0),
                &config()
            ),
            (tauri::PhysicalPosition::new(-7, 0), area.size, None),
        );
    }

    #[test]
    fn header_can_span_adjacent_monitors_but_not_extend_above_either() {
        let left = rect(-1920, 0, 1920, 1080);
        let right = rect(0, 0, 1920, 1080);
        let spanning = rect(-480, 100, 960, 640);
        assert_frame(
            super::reachable_client(spanning, 48, &[left, right], right, None),
            None,
        );
        let below = rect(0, 300, 1920, 1080);
        assert_frame(
            super::reachable_client(spanning, 48, &[left, below], left, None),
            Some(rect(-1440, 0, 960, 640)),
        );
    }

    fn saved_state(x: i32, y: i32, width: u32, height: u32) -> Value {
        json!({"main": {
            "width": width, "height": height, "x": x, "y": y,
            "prev_x": x, "prev_y": y, "maximized": false,
            "fullscreen": false, "visible": false, "decorated": false
        }})
    }

    fn decode(state: &Value) -> super::SavedGeometry {
        super::saved_geometry(&serde_json::to_vec(state).unwrap(), "main").unwrap()
    }

    /// A scale file with `fields`, recorded for the save `state`.
    fn bound(state: &Value, mut fields: Value) -> Vec<u8> {
        fields["geometry"] = json!(decode(state).pairing());
        serde_json::to_vec(&json!({ "main": fields })).unwrap()
    }

    #[test]
    fn requested_geometry_is_safe_even_while_getters_still_report_startup_bounds() {
        let area = rect(0, 25, 1440, 875);
        let startup = rect(100, 120, 1200, 800);
        let completed = rect(100, -450, 960, 640);
        let saved = decode(&saved_state(100, -450, 960, 640));
        // The old post-set guard approves this stale, reachable startup frame.
        assert_frame(
            super::reachable_client(startup, 48, &[area], area, None),
            None,
        );
        // The planner accepts no current bounds: they can be either startup or
        // completed bounds. Only the frame-to-client offset (zero for this
        // undecorated window) is used. The unsafe origin is never sent to GTK.
        let expected = (
            tauri::PhysicalPosition::new(240, 25),
            tauri::PhysicalSize::new(960, 640),
            Some(1.0),
        );
        assert_frame(
            super::reachable_client(completed, 48, &[area], area, None),
            Some(rect(240, 25, 960, 640)),
        );
        let offset = tauri::PhysicalPosition::new(0, 0);
        assert_eq!(
            super::restore_request(
                &saved,
                None,
                offset,
                1.0,
                &[(area, 1.0)],
                (area, 1.0),
                &config()
            ),
            expected
        );
        // Resize is asynchronous too: validating only startup width misses
        // the right-hand controls of a wider saved client.
        let saved = decode(&saved_state(100, 120, 1800, 800));
        assert_eq!(
            super::restore_request(
                &saved,
                None,
                offset,
                1.0,
                &[(area, 1.0)],
                (area, 1.0),
                &config()
            ),
            (
                area.position,
                tauri::PhysicalSize::new(1440, 800),
                Some(1.0)
            ),
        );
    }

    #[test]
    fn requested_geometry_uses_client_size_and_normal_origin_for_saved_modes() {
        let area = rect(0, 0, 1920, 1040);
        let offset = tauri::PhysicalPosition::new(7, 0);
        let saved = decode(&saved_state(-7, 0, 1920, 1000));
        assert_eq!(
            super::restore_request(
                &saved,
                None,
                offset,
                1.0,
                &[(area, 1.0)],
                (area, 1.0),
                &config()
            ),
            (
                tauri::PhysicalPosition::new(-7, 0),
                tauri::PhysicalSize::new(1920, 1000),
                None
            ),
        );
        let mut state = saved_state(0, 0, 960, 640);
        state["main"]["maximized"] = json!(true);
        state["main"]["prev_x"] = json!(100);
        state["main"]["prev_y"] = json!(-450);
        assert_eq!(
            super::restore_request(
                &decode(&state),
                None,
                offset,
                1.0,
                &[(area, 1.0)],
                (area, 1.0),
                &config()
            ),
            (
                tauri::PhysicalPosition::new(473, 0),
                tauri::PhysicalSize::new(960, 640),
                Some(1.0)
            ),
        );
        // Fullscreen uses x/y, not prev_x/prev_y, matching the plugin format.
        state["main"]["maximized"] = json!(false);
        state["main"]["fullscreen"] = json!(true);
        assert_eq!(
            super::restore_request(
                &decode(&state),
                None,
                offset,
                1.0,
                &[(area, 1.0)],
                (area, 1.0),
                &config()
            ),
            (
                tauri::PhysicalPosition::new(0, 0),
                tauri::PhysicalSize::new(960, 640),
                None
            ),
        );
    }

    #[test]
    fn saved_geometry_matches_plugin_schema_and_rejects_invalid_snapshots() {
        let valid = saved_state(100, 120, 960, 640);
        let mut missing_mode = valid.clone();
        missing_mode["main"]
            .as_object_mut()
            .unwrap()
            .remove("fullscreen");
        let mut invalid_other_window = valid.clone();
        invalid_other_window["other"] = json!({"width": 960});
        let mut wrong_type = valid.clone();
        wrong_type["main"]["maximized"] = json!("false");
        for state in [
            json!({}),
            json!(null),
            missing_mode,
            invalid_other_window,
            wrong_type,
            saved_state(0, 0, 0, 0),
        ] {
            assert!(super::saved_geometry(&serde_json::to_vec(&state).unwrap(), "main").is_none());
        }
        assert!(super::saved_geometry(b"not json", "main").is_none());
        assert!(super::saved_geometry(&serde_json::to_vec(&valid).unwrap(), "other").is_none());
        assert!(super::saved_geometry(&serde_json::to_vec(&valid).unwrap(), "main").is_some());
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
    fn onboarding_snapshot_is_kept_until_next_launch_restore() {
        let (dir, app) = fixture();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let window = webview.as_ref().window();
        plugin.window_created(window.clone());
        let path = dir.path().join(super::INTRO_GEOMETRY);
        let bytes = serde_json::to_vec(&saved_state(100, 120, 960, 640)).unwrap();
        super::preserve_intro_geometry(&path, &bytes).unwrap();
        let original = std::fs::read(&path).unwrap();
        super::onboarding_preserve_window(webview).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        super::restore(&window).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn onboarding_records_scale_beside_both_saves_and_restore_clears_its_copy() {
        let (dir, app) = fixture();
        let state = dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME);
        std::fs::write(
            &state,
            serde_json::to_vec(&saved_state(100, 120, 960, 640)).unwrap(),
        )
        .unwrap();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let window = webview.as_ref().window();
        plugin.window_created(window.clone());
        super::onboarding_preserve_window(webview).unwrap();
        let scale = window.scale_factor().unwrap();
        for name in [super::SCALE, super::INTRO_SCALE] {
            let bytes = std::fs::read(dir.path().join(name)).unwrap();
            let saved = super::saved_scale(&bytes, "main").unwrap();
            assert_eq!((saved.scale, saved.position), (scale, Some(scale)));
            assert!(saved.geometry.is_some());
            assert_eq!(super::saved_scale(&bytes, "other"), None);
        }
        assert_eq!(super::saved_scale(br#"{"main":{"scale":0}}"#, "main"), None);
        // Each scale file names the geometry file it was copied beside.
        for intro in [true, false] {
            let (_, scales) =
                super::restore_input(dir.path(), &app.handle().filename(), "main", intro).unwrap();
            assert_eq!(scales.map(|scales| scales.scale), Some(scale));
        }
        super::restore(&window).unwrap();
        assert!(!dir.path().join(super::INTRO_GEOMETRY).exists());
        assert!(!dir.path().join(super::INTRO_SCALE).exists());
        assert!(dir.path().join(super::SCALE).exists());
    }

    fn kept(size: f64, position: f64, prev: f64) -> super::Kept {
        super::Kept {
            size: Some(size),
            position: Some(position),
            prev: Some(prev),
        }
    }

    fn frame(maximized: bool, minimized: bool, scale: f64) -> super::Frame {
        super::Frame {
            maximized,
            minimized,
            scale,
        }
    }

    #[test]
    fn kept_scales_follow_the_plugins_cache_rules() {
        use super::Update::{Moved, Resized, Saved};
        let normal = |scale| frame(false, false, scale);
        // Dragged from a 2x screen to a 1x screen without a Resized, then
        // minimized and quit: the plugin keeps 2x size and 1x position.
        let mut scales = kept(2.0, 2.0, 2.0);
        scales.apply(Moved, normal(1.0));
        assert_eq!(scales, kept(2.0, 1.0, 2.0));
        scales.apply(Moved, frame(false, true, 2.0));
        scales.apply(Resized, frame(false, true, 2.0));
        scales.apply(Saved, frame(false, true, 2.0));
        assert_eq!(scales, kept(2.0, 1.0, 2.0));
        // Maximizing moves the window: the normal origin becomes prev. A
        // maximized window keeps its cached size, through Resized and saves.
        scales.apply(Moved, frame(true, false, 2.0));
        assert_eq!(scales, kept(2.0, 2.0, 1.0));
        scales.apply(Resized, frame(true, false, 1.0));
        scales.apply(Saved, frame(true, false, 1.0));
        assert_eq!(scales, kept(2.0, 2.0, 1.0));
        // A normal window's save reads both size and position, never prev.
        scales.apply(Resized, normal(1.0));
        assert_eq!(scales, kept(1.0, 2.0, 1.0));
        scales.apply(Saved, normal(2.0));
        assert_eq!(scales, kept(2.0, 2.0, 1.0));
    }

    /// Reads `state` and `scale` from disk as restore does, then plans the
    /// restore as restore does, in logical units. Windows plans in physical
    /// pixels, without recorded scales.
    #[cfg(not(windows))]
    fn planned(
        state: &Value,
        scale: Value,
        startup: f64,
        monitors: &[(tauri::PhysicalRect<i32, u32>, f64)],
    ) -> (tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>) {
        let dir = tempfile::tempdir().unwrap();
        let live = tauri_plugin_window_state::DEFAULT_FILENAME;
        std::fs::write(dir.path().join(live), serde_json::to_vec(state).unwrap()).unwrap();
        std::fs::write(dir.path().join(super::SCALE), bound(state, scale)).unwrap();
        let (saved, scales) = super::restore_input(dir.path(), live, "main", false).unwrap();
        let offset = tauri::PhysicalPosition::new(0, 0);
        let (position, size, logical) = super::restore_plan(
            saved,
            scales,
            offset,
            startup,
            monitors,
            monitors[0],
            &config(),
        );
        let logical = logical.expect("sent in logical units");
        (position.to_logical(logical), size.to_logical(logical))
    }

    #[test]
    #[cfg(not(windows))]
    fn position_and_size_restore_each_at_its_own_scale() {
        let monitors = mixed_scale_monitors();
        // 1200x750 points cached on the 2x laptop, then moved to (2212, -200)
        // points on the 1x external without a Resized.
        let state = saved_state(2212, -200, 2400, 1500);
        let split = json!({"scale": 2.0, "position": 1.0, "prev": 1.0});
        assert_eq!(
            planned(&state, split, 2.0, &monitors),
            (
                tauri::LogicalPosition::new(2212.0, -200.0),
                tauri::LogicalSize::new(1200.0, 750.0)
            ),
        );
        // Maximized: the normal origin is prev, at prev's scale.
        let mut state = saved_state(0, 66, 2400, 1500);
        state["main"]["maximized"] = json!(true);
        state["main"]["prev_x"] = json!(2212);
        state["main"]["prev_y"] = json!(-200);
        let prev = json!({"scale": 2.0, "position": 2.0, "prev": 1.0});
        assert_eq!(
            planned(&state, prev, 2.0, &monitors).0,
            tauri::LogicalPosition::new(2212.0, -200.0),
        );
        // An older file without position scales reads them as the size's.
        let state = saved_state(200, 66, 2400, 1500);
        assert_eq!(
            planned(&state, json!({"scale": 2.0}), 1.0, &monitors),
            (
                tauri::LogicalPosition::new(100.0, 33.0),
                tauri::LogicalSize::new(1200.0, 750.0)
            ),
        );
        assert_eq!(
            super::saved_scale(br#"{"main":{"scale":2.0,"prev":0}}"#, "main"),
            None
        );
    }

    #[test]
    fn restore_reads_the_snapshot_pair_while_pending_else_the_live_pair() {
        let dir = tempfile::tempdir().unwrap();
        let write =
            |name: &str, bytes: &[u8]| std::fs::write(dir.path().join(name), bytes).unwrap();
        let live = tauri_plugin_window_state::DEFAULT_FILENAME;
        let input = |intro| super::restore_input(dir.path(), live, "main", intro);
        assert!(input(true).is_none() && input(false).is_none());
        let (state, intro) = (
            saved_state(100, 120, 960, 640),
            saved_state(300, 320, 1200, 800),
        );
        write(live, &serde_json::to_vec(&state).unwrap());
        // A plugin file without a scale file restores as on main.
        assert!(input(false).unwrap().1.is_none());
        write(super::SCALE, &bound(&state, json!({"scale": 2.0})));
        write(super::INTRO_GEOMETRY, &serde_json::to_vec(&intro).unwrap());
        write(
            super::INTRO_SCALE,
            &bound(&intro, json!({"scale": 1.0, "position": 2.0})),
        );
        let (saved, scales) = input(true).unwrap();
        assert_eq!((saved.x, saved.width), (300, 1200));
        assert_eq!(
            scales,
            Some(super::SavedScale {
                scale: 1.0,
                position: Some(2.0),
                prev: None,
                geometry: Some(decode(&intro).pairing()),
            })
        );
        let (saved, scales) = input(false).unwrap();
        assert_eq!((saved.x, saved.width), (100, 960));
        assert_eq!(scales.map(|scales| scales.scale), Some(2.0));
        assert!(super::restore_input(dir.path(), live, "other", false).is_none());
    }

    #[test]
    fn window_events_update_the_kept_scales_and_only_saves_write_them() {
        let (dir, app) = fixture();
        let path = dir.path().join(super::SCALE);
        let live = dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME);
        let state = saved_state(200, 66, 2400, 1500);
        std::fs::write(&live, serde_json::to_vec(&state).unwrap()).unwrap();
        let disk = bound(&state, json!({"scale": 2.0}));
        std::fs::write(&path, &disk).unwrap();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        let mut window = |label| {
            let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap()
                .as_ref()
                .window();
            plugin.window_created(window.clone());
            window
        };
        let (main, other) = (window("main"), window("other"));
        let scales = || *app.state::<super::KeptScale>().kept.lock().unwrap();
        // The kept scales start from the file, as the plugin's cache does.
        super::restore(&main).unwrap();
        assert_eq!(scales(), kept(2.0, 2.0, 2.0));
        // MockRuntime's windows are normal, at 1x.
        let moved = tauri::WindowEvent::Moved(tauri::PhysicalPosition::new(2212, -200));
        let resized = tauri::WindowEvent::Resized(tauri::PhysicalSize::new(2400, 1500));
        super::window_event(&other, &moved);
        super::window_event(&main, &tauri::WindowEvent::Focused(true));
        assert_eq!(scales(), kept(2.0, 2.0, 2.0));
        super::window_event(&main, &moved);
        assert_eq!(scales(), kept(2.0, 1.0, 2.0));
        super::window_event(&main, &resized);
        assert_eq!(scales(), kept(1.0, 1.0, 2.0));
        // While the plugin's restore holds its lock, it ignores Moved and
        // Resized, and so does Buzz.
        let restoring = &app.state::<super::KeptScale>().restoring;
        restoring.store(true, std::sync::atomic::Ordering::SeqCst);
        super::window_event(&main, &moved);
        super::window_event(&main, &resized);
        restoring.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(scales(), kept(1.0, 1.0, 2.0));
        // Events only update the cache, like the plugin's: a crash or Force
        // Quit before Exit leaves the old geometry on disk, and the old scale.
        assert_eq!(std::fs::read(&path).unwrap(), disk);
        // Exit: the plugin saves, then Buzz writes the scales of that save.
        plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
        super::save_scale(app.handle());
        let saved = super::saved_geometry(&std::fs::read(&live).unwrap(), "main").unwrap();
        assert_eq!(
            super::saved_scale(&std::fs::read(&path).unwrap(), "main"),
            Some(super::SavedScale {
                scale: 1.0,
                position: Some(1.0),
                prev: Some(2.0),
                geometry: Some(saved.pairing()),
            })
        );
    }

    #[test]
    fn a_geometry_save_without_its_scales_restores_as_before() {
        let monitors = mixed_scale_monitors();
        let (dir, app) = fixture();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        let live = dir.path().join(tauri_plugin_window_state::DEFAULT_FILENAME);
        let path = dir.path().join(super::SCALE);
        // This build quit on the 2x laptop: a 1200x750-point window.
        let laptop = saved_state(200, 66, 2400, 1500);
        std::fs::write(&live, serde_json::to_vec(&laptop).unwrap()).unwrap();
        std::fs::write(&path, bound(&laptop, json!({"scale": 2.0}))).unwrap();
        // Then an older build, or an exit cut short between the two writes,
        // saved 1200x750 pixels on the 1x external and left the 2x scale.
        let external = saved_state(2212, -317, 1200, 750);
        std::fs::write(&live, serde_json::to_vec(&external).unwrap()).unwrap();
        let (saved, scales) =
            super::restore_input(dir.path(), &app.handle().filename(), "main", false).unwrap();
        assert_eq!(scales, None);
        // Restored as on main, in physical pixels, not halved to 600x375 points.
        let offset = tauri::PhysicalPosition::new(0, 0);
        assert_eq!(
            super::restore_plan(
                saved,
                scales,
                offset,
                1.0,
                &monitors,
                monitors[0],
                &config()
            ),
            (
                tauri::PhysicalPosition::new(2212, -317),
                tauri::PhysicalSize::new(1200, 750),
                None
            ),
        );
        // The kept scales don't start from the stale file either, so the next
        // Exit can't pair them with this save's cached frame.
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
            .as_ref()
            .window();
        plugin.window_created(window.clone());
        super::restore(&window).unwrap();
        assert_eq!(
            *app.state::<super::KeptScale>().kept.lock().unwrap(),
            super::Kept::default()
        );
    }

    #[test]
    fn nothing_is_written_without_a_kept_scale() {
        let (dir, app) = fixture();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        super::write_kept_scale(app.handle());
        assert!(!dir.path().join(super::SCALE).exists());
    }

    #[test]
    fn exit_saves_only_the_main_window() {
        let (dir, app) = fixture();
        let mut plugin = super::builder().build();
        plugin.initialize(app.handle(), Value::Null).unwrap();
        for label in ["main", "other"] {
            let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap()
                .as_ref()
                .window();
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
        // Parse an actual plugin-produced snapshot, not just our handwritten fixture.
        let geometry = super::saved_geometry(&std::fs::read(&path).unwrap(), "main").unwrap();
        assert_eq!(
            (geometry.width, geometry.height, geometry.x, geometry.y),
            (960, 640, 0, 0)
        );
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
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap()
                .as_ref()
                .window();
            plugin.window_created(window.clone());
            super::restore(&window).unwrap();
            plugin.on_event(app.handle(), &tauri::RunEvent::Exit);
            let state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert!(state.get("main").is_some());
        }
    }
}
