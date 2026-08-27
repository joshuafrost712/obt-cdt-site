/**
 * A member page's body, read from the portal database.
 *
 * Spec SITE-03. This is the whole data surface for gated content, and it is
 * small on purpose: two tables, read only, no writes from any client role. The
 * seed writes as `postgres` from the private vault.
 *
 * As in `portalApi.ts`, there is no client-side audience filter and its absence
 * is the design. RLS decides who reads these rows. A `.eq()` here would be a
 * second rule that can disagree with the first and hide the disagreement, and
 * this module could not enforce anything anyway: the same query runs from a
 * console with the same publishable key.
 */
import { supabase } from './client'
import type { Block } from '../../schema/types'

export interface MemberPageBody {
  route: string
  kicker: string | null
  updatedAt: string
  blocks: Block[]
}

/**
 * The page, or `null` when the seed has not run for this route.
 *
 * `null` is a real and reportable state, not an error: a route can be marked
 * `access: 'member'` and routed before its document is seeded, and the page says
 * so rather than spinning. An RLS refusal is NOT this state — it is an empty
 * read, which is the same shape (sibling memory: RLS denial is silent
 * filtering), so the caller must never read "no rows" as "you may not". Nobody
 * unsigned-in reaches this call at all: `AuthGate` renders the sign-in card
 * instead of the children.
 */
export async function getMemberPage(route: string): Promise<MemberPageBody | null> {
  const page = await supabase()
    .from('member_page')
    .select('route, kicker, updated_at')
    .eq('route', route)
    .maybeSingle()
  if (page.error) throw new Error(page.error.message)
  if (!page.data) return null

  const blocks = await supabase()
    .from('member_block')
    .select('block, ordinal, anchor')
    .eq('route', route)
    .order('ordinal', { ascending: true })
  if (blocks.error) throw new Error(blocks.error.message)

  return {
    route: page.data.route as string,
    kicker: (page.data.kicker as string | null) ?? null,
    updatedAt: page.data.updated_at as string,
    // The column is the authority on the anchor, because the seed lifts it from
    // the block and the table's own check keeps the two from disagreeing. Taking
    // it from the row rather than the JSON means a future column-only edit still
    // reaches the DOM.
    blocks: (blocks.data ?? []).map((row) => {
      const block = row.block as Block
      const anchor = (row.anchor as string | null) ?? block.anchor
      return anchor ? { ...block, anchor } : block
    }),
  }
}
