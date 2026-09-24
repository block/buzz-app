//! Local configuration and process ownership; never tied to a page or relay session.
//! No legacy desktop dependency, implicit identity creation, or credential projection.
mod bundle;
mod config;
pub mod connection;
mod create;
mod credentials;
mod defaults;
mod import;
mod ownership;
mod process;
mod runtime;
mod secret;
mod store;

pub use bundle::RuntimeBundle;
pub use config::{AgentEdit, AgentView, ControlSnapshot, HarnessEdit, ProcessStatus};
pub use create::{CreationProfile, NewAgent};
pub use credentials::PlatformCredentials;
pub use defaults::{build_defaults, BuildDefaults};
pub use import::{CredentialedImport, ImportPreview, Imports, LegacySource, PreparedImport};
pub use runtime::{Action, Controller, GooseModelContext, ModelContext};
pub use secret::{Credentials, Secret};
pub use store::Store;
type Result<T> = std::result::Result<T, String>;
