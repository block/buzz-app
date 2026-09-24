//! Local configuration and process ownership; never tied to a page or relay session.
//! No legacy desktop dependency, implicit identity creation, or credential projection.
mod bundle;
mod config;
pub mod connection;
mod create;
mod credentials;
mod import;
mod ownership;
pub mod pi;
mod process;
mod runtime;
mod secret;
mod store;
#[cfg(unix)]
mod supervisor;
#[cfg(unix)]
pub use supervisor::dispatch as dispatch_agent_supervisor;

pub use bundle::RuntimeBundle;
pub use config::{AgentEdit, AgentView, ControlSnapshot, HarnessEdit, ProcessStatus};
pub use create::{CreationProfile, NewAgent};
pub use credentials::PlatformCredentials;
pub use import::{CredentialedImport, ImportPreview, Imports, LegacySource, PreparedImport};
pub use runtime::{installed, Action, Controller, GooseModelContext, ModelContext};
pub use secret::{Credentials, Secret};
pub use store::Store;
type Result<T> = std::result::Result<T, String>;
