#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("plugin") {
        #[cfg(all(windows, not(debug_assertions)))]
        unsafe {
            windows_sys::Win32::System::Console::AttachConsole(
                windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
            );
        }
        let result = match args.get(1).map(String::as_str) {
            Some("install-git") => buzzodz_plugins::Manager::from_env()
                .and_then(|manager| buzzodz_plugins::cli::install_git(&manager, &args[2..])),
            _ => Err("Use plugin install-git REPO REF [PATH] [--enable].".into()),
        };
        if let Err(message) = result {
            eprintln!("Error: {message}");
            std::process::exit(1);
        }
        return;
    }
    buzz_foundation_lib::run();
}
