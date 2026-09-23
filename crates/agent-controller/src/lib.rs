//! Local configuration and process ownership; never tied to a page or relay session.
//! No legacy desktop dependency, implicit identity creation, or credential projection.
mod bundle;
pub mod codex;
mod config;
pub mod connection;
mod create;
mod credentials;
mod import;
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
