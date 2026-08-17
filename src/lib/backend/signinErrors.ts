/**
 * What a failed sign-in or sign-up actually means, as far as the browser can
 * tell.
 *
 * Ported from Honest Eval's `src/lib/signupErrors.ts`, which exists because of a
 * measured fact about somebody else's service: `handle_new_portal_user` raises
 * `insufficient_privilege` with a sentence written to be read, and **none of
 * that sentence reaches the browser.** Supabase Auth catches any trigger
 * exception and answers
 *
 *     {"code":500,"error_code":"unexpected_failure","msg":"Database error saving new user"}
 *
 * So a person who is not on the OBT-CDT list would otherwise stare at "Database
 * error saving new user" with no idea what to do. The string is pinned in a test
 * for the same reason it is pinned there: it is a fact about an external service,
 * and it needs to break loudly if it changes.
 *
 * `email-rate-limit` is separated on purpose. It is not an authorization problem
 * at all — it is the project's outbound email quota, which a cohort signing up
 * the same evening will meet — and telling somebody they are not on the list
 * when they are is worse than telling them nothing.
 */

export type SignInFailure =
  | 'not-on-list'
  | 'email-rate-limit'
  | 'bad-credentials'
  | 'unconfirmed'
  | 'other'

export function classifySignInError(message: string): SignInFailure {
  if (/rate limit/i.test(message)) return 'email-rate-limit'
  if (/invalid login credentials/i.test(message)) return 'bad-credentials'
  if (/email not confirmed/i.test(message)) return 'unconfirmed'
  if (/database error saving new user|unexpected_failure/i.test(message)) return 'not-on-list'
  // Kept even though the auth service currently swallows it: if a future version
  // stops wrapping the trigger's message, this recognizes the real one.
  if (/not on the obt-cdt participant list|insufficient_privilege/i.test(message)) return 'not-on-list'
  return 'other'
}

/**
 * Content node id for each failure the form can explain in its own words.
 * `other` falls back to the server's message, because inventing a diagnosis the
 * browser cannot make is worse than quoting the one fact available.
 */
export const SIGNIN_ERROR_NODE: Record<Exclude<SignInFailure, 'other'>, string> = {
  'not-on-list': 'portal.signin.error.not-on-list',
  'email-rate-limit': 'portal.signin.error.rate-limit',
  'bad-credentials': 'portal.signin.error.bad-credentials',
  unconfirmed: 'portal.signin.error.unconfirmed',
}
