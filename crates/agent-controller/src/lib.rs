//! Local configuration and process ownership; never tied to a page or relay session.
//! No legacy desktop dependency, implicit identity creation, or credential projection.
mod config;
mod credentials;
mod import;
mod process;
mod runtime;
mod secret;
mod store;

pub use config::{AgentEdit, AgentView, ControlSnapshot, HarnessEdit, ProcessStatus};
pub use credentials::PlatformCredentials;
pub use import::{ImportPreview, Imports, LegacySource};
pub use runtime::{Action, Controller, ModelContext, RuntimeBundle};
pub use secret::{Credentials, Secret};
pub use store::Store;
type Result<T> = std::result::Result<T, String>;
