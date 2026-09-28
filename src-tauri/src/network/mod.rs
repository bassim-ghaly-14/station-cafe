//! Local network access for Station Cafe.
//!
//! Three deliberately separate concerns, so that neither can silently become a
//! security boundary the other one is trusted to provide:
//!
//! - [`config`] — ONE place holding enabled/bind/port, stored in the existing
//!   `app_settings` JSON store and written only by MANAGER+.
//! - [`server`] — the HTTP listener and its thread lifecycle.
//! - [`api`] — routing, authentication, authorization and the error boundary.
//!
//! What this module must never become: a second business-logic layer. Handlers
//! here do authorization and translation ONLY; every fact they return comes
//! from the existing `services::` layer, over the application's single shared
//! SQLite connection. There is no SQL in this module, and no endpoint that
//! bypasses `auth::require_role`.

pub mod address;
pub mod api;
pub mod config;
pub mod mdns;
pub mod qr;
pub mod runtime;
pub mod server;
