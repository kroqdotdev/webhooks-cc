//! Agent registration (auth.md v0.6, see `/auth.md`) and the credential
//! file the CLI shares with the MCP server and the SDKs: the anonymous
//! sandbox, the claim that connects an agent to a human's account, and the
//! access tokens both mint.

pub mod credentials;
pub mod pow;
pub mod protocol;
pub mod sandbox;
pub mod session;

pub use credentials::{CredentialStore, Slot, SlotKind};
pub use protocol::AgentError;
pub use session::AgentSession;
