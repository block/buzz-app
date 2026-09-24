//! Local configuration and process ownership; never tied to a page or relay session.
//! No legacy desktop dependency, implicit identity creation, or credential projection.
mod bundle;
pub mod codex;
mod config;
pub mod connection;
mod create;
mod credentials;
#[cfg(unix)]
mod diagnostics;
#[cfg(not(unix))]
mod diagnostics {
    pub(crate) struct Diagnostics;
    impl Diagnostics {
        pub(crate) fn capture(_: &mut std::process::Command) -> crate::Result<Self> {
            Err("Agent process containment is not supported on this platform yet".into())
        }
        pub(crate) fn snapshot(&self) -> Vec<String> {
            Vec::new()
        }
    }
}
mod import;
#[cfg(target_os = "macos")]
mod orphans;
mod ownership;
mod process;
mod runtime;
mod secret;
mod store;

pub use bundle::RuntimeBundle;
pub use config::{
    AgentEdit, AgentView, AiConfiguration, ControlSnapshot, EffortSelection, HarnessEdit,
    ProcessStatus,
};
pub use create::{CreationProfile, NewAgent};
pub use credentials::PlatformCredentials;
pub use import::{CredentialedImport, ImportPreview, Imports, LegacySource, PreparedImport};
pub use process::Process as ContainedProcess;
pub use runtime::{Action, Controller, ModelContext};
pub use secret::{Credentials, Secret};
pub use store::Store;
type Result<T> = std::result::Result<T, String>;
