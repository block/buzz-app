//! Dock authorization is separate from the legacy banner delivery backend.
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Permission {
    #[cfg(target_os = "macos")]
    Default,
    #[cfg(target_os = "macos")]
    Setup,
    #[cfg(target_os = "macos")]
    Enabled,
    #[cfg(target_os = "macos")]
    Disabled,
    #[cfg(target_os = "macos")]
    Denied,
    Unavailable,
}

#[tauri::command]
pub(crate) fn unread_indicator_set(
    window: tauri::WebviewWindow,
    unread: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Dock badges belong to the main window".into());
    }
    #[cfg(target_os = "macos")]
    return window
        .set_badge_label(unread.then(|| "•".into()))
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = unread;
        Err("Dock badges are only available on macOS".into())
    }
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
    use std::{path::Path, ptr::NonNull, sync::mpsc, time::Duration};

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
    fn options(authorization: Authorization, badge: Setting, explicit: bool) -> Option<Options> {
        if !explicit {
            None
        } else if authorization == Authorization::NotDetermined {
            Some(Options::Alert | Options::Sound | Options::Badge)
        } else if authorization == Authorization::Authorized && badge == Setting::NotSupported {
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
        } else if authorization == Authorization::Authorized && badge == Setting::NotSupported {
            Permission::Setup
        } else if matches!(
            authorization,
            Authorization::Authorized | Authorization::Provisional | Authorization::Ephemeral
        ) {
            if badge == Setting::Enabled {
                Permission::Enabled
            } else if badge == Setting::Disabled {
                Permission::Disabled
            } else {
                Permission::Unavailable
            }
        } else {
            Permission::Unavailable
        }
    }
    pub(super) fn permission(explicit: bool) -> Result<Permission, String> {
        if !bundled() {
            return Ok(Permission::Unavailable);
        }
        check(explicit, settings, authorize)
    }
    fn check(
        explicit: bool,
        mut settings: impl FnMut() -> Result<(Authorization, Setting), String>,
        mut authorize: impl FnMut(Options) -> Result<(), String>,
    ) -> Result<Permission, String> {
        let (mut authorization, mut badge) = settings()?;
        if let Some(options) = options(authorization, badge, explicit) {
            authorize(options)?;
            (authorization, badge) = settings()?;
        }
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
                        let expected = if explicit && auth == Authorization::NotDetermined {
                            Some(Options::Alert | Options::Sound | Options::Badge)
                        } else if explicit
                            && auth == Authorization::Authorized
                            && badge == Setting::NotSupported
                        {
                            Some(Options::Badge)
                        } else {
                            None
                        };
                        let mut reads = 0;
                        let mut requests = Vec::new();
                        let permission = check(
                            explicit,
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
                        assert_eq!(requests, expected.into_iter().collect::<Vec<_>>());
                        assert_eq!(reads, if expected.is_some() { 2 } else { 1 });
                        assert_eq!(
                            permission,
                            if expected.is_some() {
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
            assert_eq!(
                project(Authorization::Authorized, Setting::NotSupported),
                Permission::Setup
            );
            assert_eq!(
                project(Authorization::Authorized, Setting::Disabled),
                Permission::Disabled
            );
        }
        #[test]
        fn failed_explicit_setup_remains_recoverable_without_startup_mutation() {
            // Fail initial settings, authorization, then post-authorization settings.
            for failure in 0..3 {
                let mut reads = 0;
                let mut requests = 0;
                assert!(check(
                    true,
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
                assert_eq!(requests, if failure == 0 { 0 } else { 1 });
                assert_eq!(
                    check(
                        false,
                        || Ok((Authorization::Authorized, Setting::NotSupported)),
                        |_| panic!("refresh must not repair permission")
                    )
                    .unwrap(),
                    Permission::Setup
                );
                let mut reads = 0;
                assert_eq!(
                    check(
                        true,
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
                            assert_eq!(options, Options::Badge);
                            Ok(())
                        }
                    )
                    .unwrap(),
                    Permission::Enabled
                );
                assert_eq!(reads, 2);
            }
        }
        #[test]
        fn no_prompt_on_startup_then_explicit_action_uses_fresh_settings() {
            assert_eq!(
                check(
                    false,
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
