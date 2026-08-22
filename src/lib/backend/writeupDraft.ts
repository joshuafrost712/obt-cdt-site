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
 */

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

function key(assignmentId: string): string {
  return `${PREFIX}${assignmentId}`
}

export function loadDraft(assignmentId: string): WriteupDraft | null {
  try {
    const raw = localStorage.getItem(key(assignmentId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as WriteupDraft
    // A draft from a future or unknown shape is discarded rather than half read.
    // Restoring three of seven fields per unit is worse than restoring none,
    // because the consultant cannot tell which ones came back.
    if (parsed?.v !== 1) return null
    return parsed
  } catch {
    return null
  }
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
  try {
    const payload: WriteupDraft = { v: 1, savedAt: new Date().toISOString(), ...draft }
    localStorage.setItem(key(assignmentId), JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export function clearDraft(assignmentId: string): void {
  try {
    localStorage.removeItem(key(assignmentId))
  } catch {
    /* nothing to do: the draft is a convenience and its removal is too */
  }
}

export function hasDraft(assignmentId: string): boolean {
  return loadDraft(assignmentId) !== null
}
