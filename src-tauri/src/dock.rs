//! Dock authorization is separate from the legacy banner delivery backend.
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Permission {
    #[cfg(target_os = "macos")]
    Default,
    #[cfg(target_os = "macos")]
    Enabled,
    #[cfg(target_os = "macos")]
    Disabled,
    #[cfg(target_os = "macos")]
    Denied,
    Unavailable,
}

#[tauri::command]
pub(crate) async fn dock_permission(
    window: tauri::WebviewWindow,
    request: bool,
) -> Result<Permission, String> {
    if window.label() != "main" {
        return Err("Dock badges belong to the main window".into());
    }
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || macos::permission(request))
        .await
        .map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Ok(Permission::Unavailable)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::Permission;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSBundle, NSError};
    use objc2_user_notifications::{
        UNAuthorizationOptions as Options, UNAuthorizationStatus as Authorization,
        UNNotificationSetting as Setting, UNNotificationSettings, UNUserNotificationCenter,
    };
    use std::{
        path::Path,
        ptr::NonNull,
        sync::{mpsc, Mutex},
        time::Duration,
    };

    // One successful initial check per process; failures remain recoverable.
    // Serialization also keeps explicit permission requests from racing repair.
    static CHECK: Mutex<bool> = Mutex::new(false);
    fn bundled() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some()
            && bundle.executablePath().is_some_and(|executable| {
                bundle_layout(
                    Path::new(&bundle.bundlePath().to_string()),
                    Path::new(&executable.to_string()),
                )
            })
    }
    fn bundle_layout(bundle: &Path, executable: &Path) -> bool {
        let Some(macos) = executable.parent() else {
            return false;
        };
        let Some(contents) = macos.parent() else {
            return false;
        };
        bundle.extension().is_some_and(|ext| ext == "app")
            && macos.file_name() == Some("MacOS".as_ref())
            && contents.file_name() == Some("Contents".as_ref())
            && contents.parent() == Some(bundle)
    }
    fn settings() -> Result<(Authorization, Setting), String> {
        // Calling UNUserNotificationCenter outside an app bundle raises an ObjC
        // exception. Check actual identity/layout, including for debug bundles.
        if !bundled() {
            return Err("Dock permission requires a bundled macOS app".into());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: Apple's completion parameter is valid for this callback.
            let settings = unsafe { settings.as_ref() };
            let _ = tx.send((settings.authorizationStatus(), settings.badgeSetting()));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .getNotificationSettingsWithCompletionHandler(&handler);
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Dock settings request timed out".into())
    }
    fn authorize(options: Options) -> Result<(), String> {
        if !bundled() {
            return Err("Dock permission requires a bundled macOS app".into());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let handler = RcBlock::new(move |_: Bool, error: *mut NSError| {
            // SAFETY: Apple's optional error is valid for this callback.
            let error = unsafe { error.as_ref() };
            let _ = tx.send(error.map_or(Ok(()), |error| Err(error.to_string())));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(options, &handler);
        rx.recv_timeout(Duration::from_secs(60))
            .map_err(|_| "Dock authorization request timed out".to_string())?
    }
    fn options(
        authorization: Authorization,
        badge: Setting,
        explicit: bool,
        repair: bool,
    ) -> Option<Options> {
        if explicit && authorization == Authorization::NotDetermined {
            Some(Options::Alert | Options::Sound | Options::Badge)
        } else if repair
            && authorization == Authorization::Authorized
            && badge == Setting::NotSupported
        {
            Some(Options::Badge)
        } else {
            None
        }
    }
    fn project(authorization: Authorization, badge: Setting) -> Permission {
        if authorization == Authorization::NotDetermined {
            Permission::Default
        } else if authorization == Authorization::Denied {
            Permission::Denied
        } else if matches!(
            authorization,
            Authorization::Authorized | Authorization::Provisional | Authorization::Ephemeral
        ) {
            if badge == Setting::Enabled {
                Permission::Enabled
            } else {
                Permission::Disabled
            }
        } else {
            Permission::Unavailable
        }
    }
    pub(super) fn permission(explicit: bool) -> Result<Permission, String> {
        if !bundled() {
            return Ok(Permission::Unavailable);
        }
        let mut repaired = CHECK
            .try_lock()
            .map_err(|_| "Dock permission check already in progress")?;
        check(explicit, &mut repaired, settings, authorize)
    }
    fn check(
        explicit: bool,
        repaired: &mut bool,
        mut settings: impl FnMut() -> Result<(Authorization, Setting), String>,
        mut authorize: impl FnMut(Options) -> Result<(), String>,
    ) -> Result<Permission, String> {
        let (mut authorization, mut badge) = settings()?;
        if let Some(options) = options(authorization, badge, explicit, !*repaired) {
            authorize(options)?;
            (authorization, badge) = settings()?;
        }
        *repaired = true;
        Ok(project(authorization, badge))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn authorization_matrix_preserves_choices_and_only_prompts_on_explicit_action() {
            for auth in [
                Authorization::NotDetermined,
                Authorization::Denied,
                Authorization::Authorized,
                Authorization::Provisional,
                Authorization::Ephemeral,
            ] {
                for badge in [Setting::NotSupported, Setting::Disabled, Setting::Enabled] {
                    for explicit in [false, true] {
                        for repair in [false, true] {
                            let result = options(auth, badge, explicit, repair);
                            if explicit && auth == Authorization::NotDetermined {
                                assert_eq!(
                                    result,
                                    Some(Options::Alert | Options::Sound | Options::Badge)
                                );
                            } else if repair
                                && auth == Authorization::Authorized
                                && badge == Setting::NotSupported
                            {
                                assert_eq!(result, Some(Options::Badge));
                            } else {
                                assert_eq!(result, None);
                            }
                            let mut checked = !repair;
                            let mut reads = 0;
                            let mut requests = Vec::new();
                            let permission = check(
                                explicit,
                                &mut checked,
                                || {
                                    reads += 1;
                                    Ok(if reads == 1 {
                                        (auth, badge)
                                    } else {
                                        (Authorization::Authorized, Setting::Enabled)
                                    })
                                },
                                |options| {
                                    requests.push(options);
                                    Ok(())
                                },
                            )
                            .unwrap();
                            assert_eq!(requests, result.into_iter().collect::<Vec<_>>());
                            assert_eq!(reads, if result.is_some() { 2 } else { 1 });
                            assert!(checked);
                            assert_eq!(
                                permission,
                                if result.is_some() {
                                    Permission::Enabled
                                } else {
                                    project(auth, badge)
                                }
                            );
                            assert_eq!(
                                project(auth, badge) == Permission::Enabled,
                                badge == Setting::Enabled
                                    && matches!(
                                        auth,
                                        Authorization::Authorized
                                            | Authorization::Provisional
                                            | Authorization::Ephemeral
                                    )
                            );
                        }
                    }
                }
            }
        }
        #[test]
        fn failed_repair_remains_recoverable_on_a_later_check() {
            // Fail initial settings, authorization, then post-authorization settings.
            for failure in 0..3 {
                let mut checked = false;
                let mut reads = 0;
                let mut requests = 0;
                assert!(check(
                    false,
                    &mut checked,
                    || {
                        reads += 1;
                        if (failure == 0 && reads == 1) || (failure == 2 && reads == 2) {
                            Err("settings failed".into())
                        } else {
                            Ok((Authorization::Authorized, Setting::NotSupported))
                        }
                    },
                    |_| {
                        requests += 1;
                        if failure == 1 {
                            Err("authorization failed".into())
                        } else {
                            Ok(())
                        }
                    }
                )
                .is_err());
                assert!(!checked);
                assert_eq!(requests, if failure == 0 { 0 } else { 1 });
                let mut reads = 0;
                let mut requested = Vec::new();
                assert_eq!(
                    check(
                        false,
                        &mut checked,
                        || {
                            reads += 1;
                            Ok((
                                Authorization::Authorized,
                                if reads == 1 {
                                    Setting::NotSupported
                                } else {
                                    Setting::Enabled
                                },
                            ))
                        },
                        |options| {
                            requested.push(options);
                            Ok(())
                        }
                    )
                    .unwrap(),
                    Permission::Enabled
                );
                assert_eq!(requested, vec![Options::Badge]);
                assert!(checked);
            }
        }
        #[test]
        fn no_prompt_on_startup_then_explicit_action_uses_fresh_settings() {
            let mut checked = false;
            assert_eq!(
                check(
                    false,
                    &mut checked,
                    || Ok((Authorization::NotDetermined, Setting::NotSupported)),
                    |_| panic!("startup must not request permission")
                )
                .unwrap(),
                Permission::Default
            );
            let mut reads = 0;
            assert_eq!(
                check(
                    true,
                    &mut checked,
                    || {
                        reads += 1;
                        Ok(if reads == 1 {
                            (Authorization::NotDetermined, Setting::NotSupported)
                        } else {
                            (Authorization::Denied, Setting::Disabled)
                        })
                    },
                    |options| {
                        assert_eq!(options, Options::Alert | Options::Sound | Options::Badge);
                        Ok(())
                    }
                )
                .unwrap(),
                Permission::Denied
            );
            assert_eq!(reads, 2);
        }
        #[test]
        fn unbundled_process_never_calls_notification_center() {
            assert!(!bundled());
            assert_eq!(permission(false).unwrap(), Permission::Unavailable);
            assert_eq!(permission(true).unwrap(), Permission::Unavailable);
            assert!(settings().is_err());
            assert!(authorize(Options::Badge).is_err());
        }
        #[test]
        fn bundle_requires_the_real_executable_layout() {
            assert!(bundle_layout(
                Path::new("/Applications/Buzz.app"),
                Path::new("/Applications/Buzz.app/Contents/MacOS/Buzz")
            ));
            for path in [
                "/Applications/Other.app/Contents/MacOS/Buzz",
                "/Applications/Buzz.app/Buzz",
                "/target/debug/Buzz",
            ] {
                assert!(!bundle_layout(
                    Path::new("/Applications/Buzz.app"),
                    Path::new(path)
                ));
            }
        }
    }
}
