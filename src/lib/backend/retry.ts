/**
 * Retry once, briefly, when PostgREST rejects a token it should accept.
 *
 * Observed in this repo's own walkthrough on 2026-08-21: a consultant signs in
 * and the queue's first read comes back 401 `JWT issued at future`. The token is
 * minted by GoTrue and validated by PostgREST, and the two do not share a clock
 * to the second, so a read fired within a second or two of sign-in can be
 * rejected for being too new. Measured at the time: that machine's clock was
 * about 2.9 seconds behind the database's.
 *
 * It is transient by construction, and without this a real participant's first
 * sight of the portal is the words "JWT issued at future". One retry, one delay,
 * and only for this error class: a blanket retry would paper over refusals that
 * mean something, and every other error in these modules is either a real denial
 * or a real bug and must surface.
 *
 * ## Why it lives here rather than in `assessApi.ts`
 *
 * It was module-private there, and SITE-02's review found that `evalApi.ts` would
 * not inherit it: a new data module does not get another module's private
 * mitigation for free, and the first participant to sign in and open their
 * evaluation is exactly the caller that hits the race. Importing `assessApi.ts`
 * for it would also drag the whole assessment surface into the evaluation page's
 * lazy chunk. So it is its own file, and both modules import it.
 */
export const TOO_NEW = /issued at future|JWT.*not yet valid/i

export async function retryIfTooNew<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!TOO_NEW.test(msg)) throw e
    await new Promise((r) => setTimeout(r, 1500))
    return run()
  }
}
