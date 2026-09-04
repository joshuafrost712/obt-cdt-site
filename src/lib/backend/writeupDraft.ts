/**
 * The write-up draft store. Spec CDT-04 D6.
 *
 * ## Why this exists
 *
 * `submission.consent_recorded` is `boolean not null` with no default and
 * `submission_rating.evidence_sentence` is `text not null`, one row per unit. So
 * the schema accepts nothing until everything exists: there is no half-finished
 * write-up in the database, by design. I-1 is 16 units × 7 fields + 9 header
 * fields = 121 inputs, filled after a two-hour conversation. A closed tab without
 * this file loses the viva.
 *
 * ## Two constraints, both deliberate
 *
 * **`localStorage`, not IndexedDB.** No spec in this campaign bumps the
 * devfeedback IndexedDB version (`src/devfeedback/db.ts`), and a separate Dexie
 * database is a store version to claim campaign-wide for a form draft. A JSON
 * blob under `cdt04.draft.<assignment uuid>` is enough, and is inspectable in
 * devtools when a consultant says they lost something.
 *
 * **It is device-local and the UI says so in those words.** Browser storage is
 * evictable: Safari and iOS cap unvisited-origin storage at seven days. So a
 * draft is a convenience and never a record, and "Saved on this device" is the
 * only honest wording. `docs/ASSESSMENT.md` carries the same line, because a
 * consultant who loses a draft will ask whether the system had it and the answer
 * is no.
 *
 * It is cleared ONLY after the write returns successfully — the
 * Web-App-Build-Protocol's first reliability invariant: never report a state
 * change that did not persist. A refused submit keeps the draft.
 *
 * ## Spec SITE-02 moved the mechanism out and left the shape alone
 *
 * The `localStorage` access, the version guard and the clear-only-on-success
 * rule now live in `localDraft.ts`, because the evaluation form needs the same
 * discipline over a different shape and a second copy of a version guard is a
 * version guard that will drift. Nothing here changes: the key prefix, the
 * version and the STORED BYTES are identical, so a draft already sitting in a
 * consultant's browser still loads.
 */
import { makeDraftStore } from './localDraft'

const PREFIX = 'cdt04.draft.'

export interface DraftUnit {
  observed_level?: string
  recommended_level?: string
  confidence?: string
  evidence_sentence?: string
  plain_language_check?: string
  plain_language_note?: string
  escalate?: boolean
}

export interface WriteupDraft {
  /** Bumped only if the shape changes incompatibly; an old blob is then dropped. */
  v: 1
  savedAt: string
  header: Record<string, string | boolean>
  units: Record<string, DraftUnit>
}

const store = makeDraftStore<Omit<WriteupDraft, 'v' | 'savedAt'>>(PREFIX, 1)

export function loadDraft(assignmentId: string): WriteupDraft | null {
  const d = store.load(assignmentId)
  return d ? { v: 1, savedAt: d.savedAt, header: d.header, units: d.units } : null
}

/**
 * Returns false when the write failed — a full disk, or Safari in private mode.
 * The caller surfaces that rather than showing "Saved on this device" over a
 * store that rejected the write, which is the same invariant as above one level
 * down.
 */
export function saveDraft(
  assignmentId: string,
  draft: Omit<WriteupDraft, 'v' | 'savedAt'>,
): boolean {
  return store.save(assignmentId, draft)
}

export function clearDraft(assignmentId: string): void {
  store.clear(assignmentId)
}

export function hasDraft(assignmentId: string): boolean {
  return store.has(assignmentId)
}
