//! Authentication & authorization.
//!
//! - Passwords: Argon2id (PHC string stored in `users.password_hash`).
//! - Sessions: 192-bit random token; only its SHA-256 hash is stored.
//! - Authorization is enforced HERE at the service layer — commands call
//!   `require_role()` before performing any sensitive operation. The UI may
//!   hide features, but hiding is never the security boundary.

use crate::error::{AppError, AppResult};
pub use crate::repositories::users::User;
use crate::repositories::users::{self};
use crate::repositories::Db;
use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use rand::RngCore;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// All staff roles, ordered weakest → strongest.
pub const ROLES: [&str; 3] = ["STAFF", "MANAGER", "ADMIN"];

/// Session lifetime: one business day (re-login each morning).
const SESSION_TTL_HOURS: i64 = 14;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub token: String,
    pub user: User,
}

#[derive(Debug, Deserialize)]
pub struct LoginInput {
    pub name: String,
    pub password: String,
}

pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::internal(format!("password hashing failed: {e}")))
}

pub fn verify_password(password: &str, phc: &str) -> bool {
    PasswordHash::new(phc)
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

fn token_hash(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Authenticate + create a session. Returns the raw token (client stores it;
/// only the hash is persisted).
pub fn login(conn: &Db, input: &LoginInput) -> AppResult<SessionInfo> {
    let record = users::find_by_name(conn, &input.name)?
        .ok_or_else(|| AppError::unauthorized("auth.bad_credentials"))?;

    // Constant-shape failure: same error for unknown user and wrong password.
    if !verify_password(&input.password, &record.password_hash) {
        return Err(AppError::unauthorized("auth.bad_credentials"));
    }

    if record.user.status != "ACTIVE" {
        return Err(AppError::unauthorized("auth.suspended"));
    }

    let mut raw = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = hex(&raw);

    conn.execute(
        "INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES (?1, ?2, datetime('now', ?3))",
        params![
            record.user.id,
            token_hash(&token),
            format!("+{SESSION_TTL_HOURS} hours")
        ],
    )?;

    crate::services::audit::record(
        conn,
        Some(record.user.id),
        Some(&record.user.role),
        "auth.login",
        "user",
        Some(&record.user.id.to_string()),
        None,
        None,
    )?;

    Ok(SessionInfo {
        token,
        user: record.user,
    })
}

/// Validate a session token; returns the active user or an error.
pub fn require_user(conn: &Db, token: &str) -> AppResult<User> {
    let (id, expires, revoked): (i64, String, Option<String>) = conn
        .query_row(
            "SELECT s.user_id, s.expires_at, s.revoked_at
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND u.status = 'ACTIVE'",
            params![token_hash(token)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| AppError::unauthorized("auth.invalid_session"))?;

    if revoked.is_some() || expires < sqlite_now() {
        return Err(AppError::unauthorized("auth.session_expired"));
    }

    users::find_by_id(conn, id)?.ok_or_else(|| AppError::unauthorized("auth.invalid_session"))
}

/// Authorization gate: the actor's role must satisfy the requirement.
pub fn require_role(actor: &User, min: &str) -> AppResult<()> {
    if rank(&actor.role) >= rank(min) {
        Ok(())
    } else {
        Err(AppError::unauthorized("auth.forbidden"))
    }
}

fn rank(role: &str) -> u8 {
    match role {
        "ADMIN" => 3,
        "MANAGER" => 2,
        "STAFF" => 1,
        _ => 0,
    }
}

/// Revoke the session (logout).
pub fn logout(conn: &Db, token: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?1",
        params![token_hash(token)],
    )?;

    Ok(())
}

/// Current time in SQLite `datetime('now')` format (UTC), offline-safe.
pub fn sqlite_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| {
            let secs = d.as_secs() as i64;
            let days = secs.div_euclid(86_400);
            let rem = secs.rem_euclid(86_400);
            let (y, m, dd) = civil_from_days(days);
            format!(
                "{y:04}-{m:02}-{dd:02} {:02}:{:02}:{:02}",
                rem / 3600,
                (rem % 3600) / 60,
                rem % 60
            )
        })
        .unwrap_or_default()
}

/// Current UTC date in SQLite `date('now')` format (YYYY-MM-DD).
pub fn sqlite_today() -> String {
    sqlite_now()[..10].to_string()
}

/// Days since epoch → (year, month, day). Howard Hinnant's civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;

    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn change_password(
    conn: &Db,
    actor: &User,
    target_id: i64,
    new_password: &str,
) -> AppResult<()> {
    // Staff may change their own password; managers/admins any.
    if actor.id != target_id {
        require_role(actor, "MANAGER")?;
    }

    validate_password(new_password)?;

    let hash = hash_password(new_password)?;
    users::set_password(conn, target_id, &hash)?;

    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "user.password_changed",
        "user",
        Some(&target_id.to_string()),
        None,
        None,
    )
}

/// Minimum password length for Station accounts.
///
/// Five characters allows staff passwords/PIN-style credentials such as
/// `20192` while still preventing empty or trivially short values.
pub fn validate_password(p: &str) -> AppResult<()> {
    if p.len() < 5 {
        return Err(AppError::validation("user.password_too_short"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use crate::seed::run_if_empty;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();
        conn
    }

    #[test]
    fn login_logout_session_flow() {
        let conn = fresh();

        // Seeded admin account works
        let s = login(
            &conn,
            &LoginInput {
                name: "admin".into(),
                password: "admin123".into(),
            },
        )
        .unwrap();

        assert_eq!(s.user.role, "ADMIN");

        let u = require_user(&conn, &s.token).unwrap();
        assert_eq!(u.id, s.user.id);

        // Wrong password rejected with the same error shape
        let err = login(
            &conn,
            &LoginInput {
                name: "admin".into(),
                password: "nope".into(),
            },
        )
        .unwrap_err();

        assert!(matches!(err, AppError::Unauthorized(_)));

        logout(&conn, &s.token).unwrap();
        assert!(require_user(&conn, &s.token).is_err());
    }

    #[test]
    fn seeded_accounts_roles() {
        let conn = fresh();

        for (name, role) in [("manager", "MANAGER"), ("cashier", "STAFF")] {
            let s = login(
                &conn,
                &LoginInput {
                    name: name.into(),
                    password: format!("{name}123"),
                },
            )
            .unwrap();

            assert_eq!(s.user.role, role);
        }
    }

    #[test]
    fn password_hash_roundtrip() {
        let h = hash_password("s3cret").unwrap();

        assert!(verify_password("s3cret", &h));
        assert!(!verify_password("wrong", &h));
    }

    #[test]
    fn password_validation_accepts_five_characters() {
        assert!(validate_password("20192").is_ok());
    }

    #[test]
    fn password_validation_rejects_less_than_five_characters() {
        assert!(validate_password("1234").is_err());
    }

    #[test]
    fn role_ranking() {
        let admin = User {
            id: 1,
            name: "a".into(),
            phone: None,
            role: "ADMIN".into(),
            status: "ACTIVE".into(),
            created_at: String::new(),
            updated_at: String::new(),
        };

        assert!(require_role(&admin, "STAFF").is_ok());
        assert!(require_role(&admin, "MANAGER").is_ok());
        assert!(require_role(&admin, "ADMIN").is_ok());

        let staff = User {
            role: "STAFF".into(),
            ..admin
        };

        assert!(require_role(&staff, "MANAGER").is_err());
    }
}
