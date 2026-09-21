//! Tauri IPC commands exposed to the frontend.
//! Commands stay thin: session resolution → authorization → delegation.
//! Business logic belongs in services; SQL in repositories.

pub mod auth;
pub mod common;
pub mod status;
