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
import { call } from './ipc'

export const authApi = {
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
