#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref()
        == Some(buzz_foundation_lib::agent_runner::supervisor::ARG)
    {
        buzz_foundation_lib::agent_runner::supervisor::entry();
    }
    if std::env::args().nth(1).as_deref() == Some(buzz_community_compute::worker::WORKER_ARG) {
        buzz_community_compute::worker::entry();
    }
    buzz_foundation_lib::run();
}
