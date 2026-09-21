/**
 * The project's password floor, in one place.
 *
 * Spec SITE-09, contract c3, whose constraint is that the floor is "one exported
 * constant, equal to the live project floor, and never a per-input literal".
 *
 * ## The defect this replaces
 *
 * Program finding 65, measured 2026-09-10. `shared.tsx` carried
 * `minLength={8}` while the live project's `password_min_length` was **12**. So
 * a person typing a nine-character password passed the browser's check, reached
 * GoTrue, and got a raw server error in a form where every other failure has
 * been given words. Re-measured live on 2026-09-15 for this build: still 12.
 *
 * ## Why a constant and not a live read
 *
 * The browser cannot read `password_min_length`: it is in the project's auth
 * config, behind the management API and a token no visitor holds. So this value
 * is necessarily a copy, and a copy can drift. The guard against drift is not in
 * the running site but in `scripts/site09-auth-checks.mjs`, which reads the live
 * floor through the management API and asserts that EVERY password input's
 * `minLength` equals it. Change the project's floor without changing this line
 * and that lane goes red, which is the loud failure the spec asks for.
 *
 * "BOTH inputs" until 2026-09-21: the comment counted the two inputs that
 * existed when SITE-09 wrote it, and the lane itself only ever asserted a floor
 * of three. SITE-15 added a fourth input and made that assertion an exact count
 * derived from the number of `type="password"` inputs in `shared.tsx`, so the
 * number is no longer written down in either place.
 *
 * Keeping it here rather than in `signinErrors.ts` because it is a fact about
 * the project's configuration, not a reading of somebody's error message.
 */
export const PASSWORD_MIN_LENGTH = 12
