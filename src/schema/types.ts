/**
 * Content schema for the OBT-CDT site. ALL user-visible copy lives in
 * src/content/site-content.json as nodes with stable ids; components never
 * hardcode text. That single-sourcing is what makes edit-in-place work and
 * guarantees a heading edited once updates everywhere it appears (page, nav,
 * document title).
 */

export type BlockType =
  | 'hero'
  | 'prose'
  | 'scene'
  | 'timeline'
  | 'timelineItem'
  | 'statRow'
  | 'statCallout'
  | 'quote'
  | 'threadCard'
  | 'cardGrid'
  | 'card'
  | 'imageSlot'
  | 'workshopFacts'
  | 'rubricScale'
  | 'rubricStep'
  | 'ctaGroup'
  | 'cta'
  | 'labelToken'

export interface Block {
  id: string
  type: BlockType
  /** Small overline text above a title. */
  kicker?: string
  /** Heading text. */
  title?: string
  /** Body copy. Paragraphs separated by blank lines; **bold** supported. */
  body?: string
  /** Short label (stat labels, CTA text, thread names, badge tokens). */
  label?: string
  /** Stat value or similar short datum. */
  value?: string
  /** Small print under a stat or card. */
  note?: string
  /** Caption under an image slot. */
  caption?: string
  /** Attribution line for a quote. */
  attribution?: string
  /** Media manifest key for imageSlot / hero art. */
  mediaId?: string
  /** Internal route for a CTA. */
  route?: string
  /** External URL for a CTA (mailto: allowed). */
  href?: string
  /** Rendering variant hint (e.g. 'primary' | 'ghost' for CTAs). */
  variant?: string
  /** Scene index for the home visual essay (drives the roundabout diagram). */
  stage?: number
  /** Child blocks (statRow items, timeline items, thread cards, CTAs...). */
  items?: Block[]
}

export type WorkshopStatus = 'complete' | 'fully-booked' | 'planned'

export interface WorkshopFacts {
  genre: string
  location: string
  /** ISO dates. */
  startDate: string
  endDate: string
  /** Optional display override when exact days shouldn't be shown (e.g. "June 2025"). */
  dateLabel?: string
  status: WorkshopStatus
}

export interface PageDef {
  id: string
  route: string
  navLabel: string
  title: string
  metaDescription: string
  kicker?: string
  blocks: Block[]
}

export interface WorkshopDef extends PageDef {
  facts: WorkshopFacts
}

export interface SiteMeta {
  id: string
  title: string
  tagline: string
  footerNote: string
  /** Site-level label tokens (badges, shared UI strings) as labelToken blocks. */
  items: Block[]
}

export interface SiteContent {
  version: string
  site: SiteMeta
  pages: PageDef[]
  workshops: WorkshopDef[]
}
