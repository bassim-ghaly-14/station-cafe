//! Local network access for Station Cafe.
//!
//! Three deliberately separate concerns, so that neither can silently become a
//! security boundary the other one is trusted to provide:
//!
//! - [`config`] — ONE place holding enabled/bind/port, stored in the existing
//!   `app_settings` JSON store and written only by MANAGER+.
//! - [`server`] — the HTTP listener and its thread lifecycle.
//! - [`api`] — routing, authentication, authorization and the error boundary.
//! - [`bridge`] — the browser's route to the REAL Station commands.
//! - [`web`] — the Station React application itself, served from the SAME
//!   listener as the API. No second port, no second process.
//!
//! [`api`] and [`web`] are separated by ONE prefix test in [`server`], so an
//! unknown `/api/v1/*` path can never fall through to the HTML application and
//! an HTML request can never be answered as JSON.
//!
//! What this module must never become: a second business-logic layer. Handlers
//! here do authorization and translation ONLY; every fact they return comes
//! from the existing `services::` layer, over the application's single shared
//! SQLite connection. There is no SQL in this module, and nothing here bypasses
//! `auth::require_role`.

pub mod address;
pub mod api;
pub mod bridge;
pub mod config;
pub mod mdns;
pub mod qr;
pub mod runtime;
pub mod server;
pub mod web;
