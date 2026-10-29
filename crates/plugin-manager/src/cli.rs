use crate::{imports::prepare_git, Manager, Result};

const USAGE: &str = "Usage: plugin install-git REPO REF [PATH] [--enable]";

pub fn install_git(manager: &Manager, args: &[String]) -> Result<()> {
    if matches!(args, [flag] if flag == "--help" || flag == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    let [repository, reference, options @ ..] = args else {
        return Err(USAGE.into());
    };
    let (path, enable) = git_options(options)?;
    let source = {
        #[cfg(unix)]
        let _interrupt = interrupt::Handler::install()?;
        let source = prepare_git(repository, reference, None)?;
        #[cfg(unix)]
        interrupt::check()?;
        source
    };
    let candidate = source
        .preview
        .candidates
        .iter()
        .find(|candidate| candidate.path == path)
        .ok_or("No plugin at this path. Specify a plugin folder from the repository.")?;
    println!(
        "Host access: {}",
        serde_json::to_string_pretty(&candidate.manifest.host).map_err(|e| e.to_string())?
    );
    if enable {
        source.install_enabled(manager, &source.preview.token, path)?;
    } else {
        source.install(manager, &source.preview.token, path)?;
    }
    println!(
        "Installed {} from {repository} ({reference}) in profile {}.",
        candidate.manifest.id, manager.profile
    );
    Ok(())
}

#[cfg(unix)]
pub(crate) mod interrupt {
    use crate::Result;
    use std::sync::atomic::{AtomicBool, Ordering};

    static INTERRUPTED: AtomicBool = AtomicBool::new(false);

    extern "C" fn handle(_: libc::c_int) {
        INTERRUPTED.store(true, Ordering::Relaxed);
    }

    pub fn check() -> Result<()> {
        if INTERRUPTED.load(Ordering::Relaxed) {
            Err("Plugin installation interrupted".into())
        } else {
            Ok(())
        }
    }

    pub struct Handler(libc::sigaction);

    impl Handler {
        pub fn install() -> Result<Self> {
            INTERRUPTED.store(false, Ordering::Relaxed);
            unsafe {
                let mut action: libc::sigaction = std::mem::zeroed();
                let mut previous = std::mem::zeroed();
                action.sa_sigaction = handle as *const () as usize;
                libc::sigemptyset(&mut action.sa_mask);
                if libc::sigaction(libc::SIGINT, &action, &mut previous) != 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                Ok(Self(previous))
            }
        }
    }

    impl Drop for Handler {
        fn drop(&mut self) {
            unsafe { libc::sigaction(libc::SIGINT, &self.0, std::ptr::null_mut()) };
        }
    }
}

fn git_options(options: &[String]) -> Result<(&str, bool)> {
    match options {
        [] => Ok((".", false)),
        [flag] if flag == "--enable" => Ok((".", true)),
        [path] if !path.starts_with('-') => Ok((path, false)),
        [path, flag] if !path.starts_with('-') && flag == "--enable" => Ok((path, true)),
        _ => Err("Usage: plugin install-git REPO REF [PATH] [--enable]".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_install_options_select_the_folder_and_enable_only_when_requested() {
        for (args, expected) in [
            (vec![], (".", false)),
            (vec!["--enable"], (".", true)),
            (vec!["plugins/example"], ("plugins/example", false)),
            (
                vec!["plugins/example", "--enable"],
                ("plugins/example", true),
            ),
        ] {
            let args = args.into_iter().map(String::from).collect::<Vec<_>>();
            assert_eq!(git_options(&args).unwrap(), expected);
        }
        for args in [
            vec!["--unknown"],
            vec![".", "--unknown"],
            vec!["--enable", "."],
        ] {
            assert!(git_options(&args.into_iter().map(String::from).collect::<Vec<_>>()).is_err());
        }
    }
}
