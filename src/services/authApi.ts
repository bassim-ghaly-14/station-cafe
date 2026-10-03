/**
 * Typed wrappers over the AUTH command surface.
 *
 * Passwords live here and NOWHERE else on the client: the only thing that ever
 * crosses this boundary is a NEW plaintext password on its way to being hashed
 * by `services::auth`. Station never sends a hash or an existing password to the
 * frontend, so this file cannot offer a "show current password" call even by
 * accident — `changePassword` takes the value to SET, not one to read.
 *
 * The command enforces authorization itself (`MANAGER`+ for another person,
 * anyone for their own account); this wrapper is a typed caller, never the
 * boundary.
 */
import { call, callPublic } from './ipc'

/**
 * The employee credential policy, mirrored on the client.
 *
 * This is a mirror of `services::auth::is_valid_password` in Rust, and it exists
 * for two reasons that are both about the person at the till: they get immediate
 * feedback instead of a round-trip rejection, and the input can be shaped so a
 * forbidden character is never even held in the field.
 *
 * It is NOT a second policy, and it cannot become one — the backend re-checks
 * every value in `login` and in `change_password` before anything happens, so a
 * client that disagreed with this file would only produce a confusing error, not
 * a weaker application. The two are pinned to each other by tests on both sides.
 */

/** Shortest accepted PIN. Mirrors `PASSWORD_MIN_DIGITS`. */
export const CREDENTIAL_MIN_DIGITS = 4
/** Longest accepted PIN. Mirrors `PASSWORD_MAX_DIGITS`. */
export const CREDENTIAL_MAX_DIGITS = 5

/**
 * Normalize whatever reached the field into an acceptable PIN prefix.
 *
 * Applied on EVERY value change and on every paste, which is what makes the
 * "no more than five digits" rule structural rather than advisory: a sixth digit
 * is never held in component state at all, so there is nothing to submit and
 * nothing to trim at submit time. It also means a pasted `1234-5678` becomes
 * `12345` rather than being rejected outright, and a pasted password manager
 * entry cannot smuggle a letter or a space into the field.
 *
 * Non-ASCII digits are stripped too: the backend checks ASCII digits, so
 * Arabic-Indic numerals are not a valid credential and silently keeping them
 * would produce an input the server can never accept.
 */
export function normalizeCredentialInput(value: string): string {
  return value.replace(/\D+/g, '').slice(0, CREDENTIAL_MAX_DIGITS)
}

/** Is this a complete, well-formed PIN? The submit-time check. */
export function isValidCredential(value: string): boolean {
  return new RegExp(String.raw`^\d{${CREDENTIAL_MIN_DIGITS},${CREDENTIAL_MAX_DIGITS}}$`).test(value)
}

/**
 * One account the login screen may offer.
 *
 * Mirrors the Rust `LoginAccount` projection exactly — an id for a stable React
 * key, the display name, and the role the avatar is built from. There is no
 * phone, no salary and no credential field here, and there cannot be one: this
 * is the only read in the application that happens BEFORE authentication.
 */
export interface LoginAccount {
  id: number
  name: string
  role: string
}

export const authApi = {
  /**
   * The accounts the login screen offers as cards.
   *
   * Called WITHOUT a session token, exactly like `login`: nobody is signed in
   * yet, and the list has to be on screen before anybody can be. The backend
   * filters it to ACTIVE logins whose EMPLOYEE record is also ACTIVE, so a
   * stopped colleague is never offered as a card that is guaranteed to fail.
   *
   * This grants nothing. The chosen name is carried to the same `auth::login`
   * that a typed username would have reached, and the backend still verifies the
   * Argon2 hash before issuing a session.
   */
  loginAccounts: () => callPublic<LoginAccount[]>('list_login_accounts'),

  /**
   * Replace the login password of `userId`.
   *
   * Used by the employee edit dialog: an ADMIN may set a NEW password for a
   * colleague without ever knowing the old one. `userId` is a LOGIN id, not an
   * employee id — the employee row carries it as `user_id`.
   */
  changePassword: (userId: number, newPassword: string) =>
    call<void>('change_password', { target_id: userId, new_password: newPassword }),
}
