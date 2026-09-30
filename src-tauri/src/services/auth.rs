//! Authentication & authorization.
//!
//! - Passwords: Argon2id (PHC string stored in `users.password_hash`).
//! - Sessions: 192-bit random token; only its SHA-256 hash is stored.
//! - Authorization is enforced HERE at the service layer — commands call
//!   `require_role()` before performing any sensitive operation. The UI may
//!   hide features, but hiding is never the security boundary.

use crate::error::{AppError, AppResult};
use crate::repositories::employees;
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

    // The EMPLOYEE record is the authoritative statement of whether this person
    // may work, so it is consulted directly rather than being inferred from the
    // login's own status. `set_employee_status` suspends both rows in one
    // transaction, so the two normally agree — but authentication is the place
    // where being wrong is unacceptable, and a desynchronised pair (a hand
    // edited row, a restored backup, a future writer that forgets the cascade)
    // must never authenticate an employee the HR record calls INACTIVE.
    match employees::find_by_user(conn, record.user.id)? {
        Some(employee) if employee.status == "ACTIVE" => {}
        _ => return Err(AppError::unauthorized("auth.suspended")),
    }

    let mut raw = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = hex(&raw);

    // Session expiry is an instant, computed from the canonical clock rather
    // than SQLite's `datetime('now', ...)`, so it is stored in the same
    // explicit-UTC form as every other timestamp.
    let expires_at = crate::time::to_db_timestamp(
        crate::time::now_utc() + chrono::Duration::hours(SESSION_TTL_HOURS),
    );

    conn.execute(
        "INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES (?1, ?2, ?3)",
        params![record.user.id, token_hash(&token), expires_at],
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

    // An employee deactivated AFTER signing in must not keep working off the
    // session they already hold. Every protected command resolves its actor
    // through here, so re-checking the authoritative employee status on each
    // validation ends that session at the next request instead of letting it
    // live out its 14-hour TTL. This is the stateless way to do it: the session
    // row is left intact (it is a historical fact) and only its USE is refused.
    let user = users::find_by_id(conn, id)?
        .ok_or_else(|| AppError::unauthorized("auth.invalid_session"))?;
    match employees::find_by_user(conn, user.id)? {
        Some(employee) if employee.status == "ACTIVE" => Ok(user),
        _ => Err(AppError::unauthorized("auth.suspended")),
    }
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

/// Whether a role may read the WHOLE catalog, deactivated items included.
///
/// The single place that answers "may this actor see inactive products?", so the
/// command and any future caller cannot drift apart. Exposed (rather than
/// reusing the numeric `rank`) because the question is not "is this role strong
/// enough" but "is this role a catalog manager".
pub fn may_manage_catalog(role: &str) -> bool {
    rank(role) >= rank("MANAGER")
}

/// Revoke the session (logout).
pub fn logout(conn: &Db, token: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE sessions SET revoked_at = station_now() WHERE token_hash = ?1",
        params![token_hash(token)],
    )?;

    Ok(())
}

/// Current instant in the canonical explicit-UTC storage format.
///
/// This delegates to the one canonical clock (`time::now_db_timestamp`)
/// instead of maintaining a second, hand-rolled calendar conversion. Station is
/// offline: the value comes from the operating system clock and nothing else.
pub fn sqlite_now() -> String {
    crate::time::now_db_timestamp()
}

/// Current BUSINESS date in Station's timezone (`YYYY-MM-DD`).
///
/// Previously this returned the UTC date, which disagreed with the UI between
/// midnight and 03:00 Cairo and could file an expense under the wrong day.
pub fn sqlite_today() -> String {
    crate::time::today_business_date()
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
    use crate::demo_data::seed_for_development as run_if_empty;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();
        conn
    }

    fn as_user(conn: &Connection, name: &str, password: &str) -> User {
        login(
            conn,
            &LoginInput {
                name: name.into(),
                password: password.into(),
            },
        )
        .unwrap()
        .user
    }

    /// The employee record behind a seeded login.
    fn employee_of(conn: &Connection, user: &User) -> i64 {
        employees::find_by_user(conn, user.id)
            .unwrap()
            .expect("a login always has an employee record")
            .id
    }

    fn try_login(conn: &Connection, name: &str, password: &str) -> AppResult<SessionInfo> {
        login(
            conn,
            &LoginInput {
                name: name.into(),
                password: password.into(),
            },
        )
    }

    fn set_employee_status(conn: &Connection, actor: &User, name: &str, status: &str) {
        // Resolve the employee by LOGIN NAME through the database, never by
        // logging in: after a deactivation the login is refused, so a helper
        // that authenticated first could not express the re-activation case.
        let user_id: i64 = conn
            .query_row("SELECT id FROM users WHERE name = ?1", [name], |r| r.get(0))
            .unwrap();
        let id = employees::find_by_user(conn, user_id)
            .unwrap()
            .expect("a login always has an employee record")
            .id;
        crate::services::employees::set_employee_status(conn, actor, id, status).unwrap();
    }

    /// RULE 1: an ACTIVE employee with correct credentials signs in normally.
    #[test]
    fn an_active_employee_with_correct_credentials_signs_in() {
        let conn = fresh();
        let session = try_login(&conn, "cashier", "cashier123").unwrap();
        assert_eq!(session.user.name, "cashier");
        assert_eq!(session.user.role, "STAFF");
        // The session is usable: the employee check must not break the
        // normal path it is meant to protect.
        assert_eq!(
            require_user(&conn, &session.token).unwrap().id,
            session.user.id
        );
    }

    /// RULE 1: an INACTIVE employee cannot sign in even with the CORRECT
    /// password. This is the whole point — correct credentials are not enough.
    #[test]
    fn an_inactive_employee_cannot_sign_in_with_the_correct_password() {
        let conn = fresh();
        let manager = as_user(&conn, "manager", "manager123");
        set_employee_status(&conn, &manager, "cashier", "INACTIVE");

        let err = try_login(&conn, "cashier", "cashier123").unwrap_err();
        assert!(
            matches!(err, AppError::Unauthorized(_)),
            "an inactive employee must be refused, got {err:?}"
        );
    }

    /// RULE 1: the refusal must not depend on guessing the password — a wrong
    /// password is refused too, and an unknown account fails identically, so
    /// the inactive case never reveals that the account exists.
    #[test]
    fn an_inactive_employee_with_wrong_credentials_also_fails() {
        let conn = fresh();
        let manager = as_user(&conn, "manager", "manager123");
        set_employee_status(&conn, &manager, "cashier", "INACTIVE");

        assert!(try_login(&conn, "cashier", "wrong-password").is_err());
        assert!(try_login(&conn, "nobody-at-all", "whatever").is_err());
    }

    /// RULE 1: a deactivated employee cannot create a NEW session, and the
    /// session they ALREADY hold stops being honoured on its next use.
    #[test]
    fn a_deactivated_employee_cannot_create_a_new_session() {
        let conn = fresh();
        let manager = as_user(&conn, "manager", "manager123");

        // A session established BEFORE the deactivation...
        let session = try_login(&conn, "cashier", "cashier123").unwrap();
        assert!(require_user(&conn, &session.token).is_ok());

        set_employee_status(&conn, &manager, "cashier", "INACTIVE");

        // ...is refused on its next use, and no new one can be minted.
        assert!(
            require_user(&conn, &session.token).is_err(),
            "a deactivated employee must not keep using the session they hold"
        );
        assert!(try_login(&conn, "cashier", "cashier123").is_err());
    }

    /// The employee record is the AUTHORITATIVE source, not the login's own
    /// status. If the two ever disagree, the INACTIVE employee is still refused:
    /// authentication must never rest on a second row staying in sync.
    #[test]
    fn an_inactive_employee_is_refused_even_if_the_login_row_says_active() {
        let conn = fresh();
        let cashier = as_user(&conn, "cashier", "cashier123");
        let id = employee_of(&conn, &cashier);

        // Desynchronise the pair behind the service's back.
        conn.execute(
            "UPDATE employees SET status = 'INACTIVE' WHERE id = ?1",
            [id],
        )
        .unwrap();
        let user_status: String = conn
            .query_row(
                "SELECT status FROM users WHERE id = ?1",
                [cashier.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            user_status, "ACTIVE",
            "the login row is deliberately still active"
        );

        assert!(try_login(&conn, "cashier", "cashier123").is_err());
    }

    /// REGRESSION: re-activating an employee restores login, so deactivation
    /// stays reversible and is not a one-way door.
    #[test]
    fn re_activating_an_employee_restores_login() {
        let conn = fresh();
        let manager = as_user(&conn, "manager", "manager123");

        set_employee_status(&conn, &manager, "cashier", "INACTIVE");
        assert!(try_login(&conn, "cashier", "cashier123").is_err());

        set_employee_status(&conn, &manager, "cashier", "ACTIVE");
        let session = try_login(&conn, "cashier", "cashier123").unwrap();
        assert_eq!(session.user.role, "STAFF");
    }

    /// REGRESSION: employee status and role authorization are INDEPENDENT. A
    /// STAFF is refused a MANAGER action while active, a suspended MANAGER is
    /// refused at the door, and neither check masks the other.
    #[test]
    fn employee_status_and_role_authorization_are_independent() {
        let conn = fresh();
        let manager = as_user(&conn, "manager", "manager123");
        let cashier = as_user(&conn, "cashier", "cashier123");

        // While active, the role gate alone decides.
        assert!(require_role(&cashier, "MANAGER").is_err());
        assert!(require_role(&manager, "MANAGER").is_ok());

        // Suspending the manager refuses them at the door entirely.
        let admin = as_user(&conn, "admin", "admin123");
        set_employee_status(&conn, &admin, "manager", "INACTIVE");
        assert!(try_login(&conn, "manager", "manager123").is_err());

        // The untouched cashier is unaffected by a colleague's status.
        assert!(try_login(&conn, "cashier", "cashier123").is_ok());
    }

    /// The catalog-visibility capability is the authorization model the product
    /// command relies on: MANAGER and ADMIN may read deactivated items, STAFF
    /// may not. Pinned here so a future role change cannot silently widen it.
    #[test]
    fn only_a_catalog_manager_may_read_the_whole_catalog() {
        assert!(may_manage_catalog("ADMIN"));
        assert!(may_manage_catalog("MANAGER"));
        assert!(!may_manage_catalog("STAFF"));
        assert!(!may_manage_catalog(""));
        assert!(!may_manage_catalog("SUPER_ADMIN"));
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
