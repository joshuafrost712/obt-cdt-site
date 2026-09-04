/**
 * The portal's device-local draft primitive. Spec SITE-02 D4.
 *
 * ## What was extracted, and what deliberately was not
 *
 * `writeupDraft.ts` had the right discipline and the wrong type: it is keyed on
 * an assignment uuid and shaped as `{header, units}`, neither of which an
 * evaluation has. SITE-02's finding 8 measured the rest of it: 101 lines
 * containing **no user-facing string**, because the restore prompt's five nodes
 * are rendered in `WriteupForm.tsx`. So what is shared here is the mechanism —
 * the `localStorage` access, the version guard, and the clear-only-on-success
 * rule — and the wording is not shared, which is decision 3 stated as code.
 *
 * ## Two constraints, both inherited and both deliberate
 *
 * **`localStorage`, not IndexedDB.** No spec in either campaign bumps the
 * devfeedback IndexedDB version (`src/devfeedback/db.ts`), and a separate Dexie
 * database is a store version to claim campaign-wide for a form draft. A JSON
 * blob under `<prefix><key>` is enough, and is inspectable in devtools when
 * somebody says they lost something.
 *
 * **It is device-local and every UI built on it says so in those words.**
 * Browser storage is evictable: Safari and iOS cap unvisited-origin storage at
 * seven days. A draft is a convenience and never a record.
 *
 * A draft is cleared ONLY after the write returns successfully — the
 * Web-App-Build-Protocol's first reliability invariant: never report a state
 * change that did not persist. A refused submit keeps the draft.
 */

/**
 * The stored shape is FLAT — `{v, savedAt, ...body}` — and that is a
 * compatibility requirement rather than a taste.
 *
 * `cdt04.draft.*` blobs are already on consultants' devices, written as
 * `{v: 1, savedAt, header, units}`. Nesting the body under a `body` key here
 * would make every one of them fail the version guard and be discarded, which is
 * the guard behaving correctly over a change nobody needed: a consultant mid
 * write-up would lose it and be told nothing. So the envelope stays flat and the
 * existing blobs keep parsing.
 *
 * The one constraint that follows: a draft body may not carry its own `v` or
 * `savedAt` key. Neither store does.
 */
export type DraftEnvelope<T> = T & { v: number; savedAt: string }

export interface DraftStore<T> {
  load: (key: string) => (T & { savedAt: string }) | null
  /** False when the write failed — a full disk, or Safari in private mode. */
  save: (key: string, body: T) => boolean
  clear: (key: string) => void
  has: (key: string) => boolean
  /** The exact localStorage key, so a harness can assert its presence and absence. */
  storageKey: (key: string) => string
}

export function makeDraftStore<T>(prefix: string, version: number): DraftStore<T> {
  const storageKey = (key: string) => `${prefix}${key}`

  const load = (key: string): (T & { savedAt: string }) | null => {
    try {
      const raw = localStorage.getItem(storageKey(key))
      if (!raw) return null
      const parsed = JSON.parse(raw) as DraftEnvelope<T>
      // A draft from a future or unknown shape is discarded rather than half
      // read. Restoring three of seven fields is worse than restoring none,
      // because the person cannot tell which ones came back.
      if (parsed?.v !== version) return null
      return parsed as T & { savedAt: string }
    } catch {
      return null
    }
  }

  return {
    load,
    save(key, body) {
      try {
        const payload: DraftEnvelope<T> = { ...body, v: version, savedAt: new Date().toISOString() }
        localStorage.setItem(storageKey(key), JSON.stringify(payload))
        return true
      } catch {
        return false
      }
    },
    clear(key) {
      try {
        localStorage.removeItem(storageKey(key))
      } catch {
        /* nothing to do: the draft is a convenience and its removal is too */
      }
    },
    has: (key) => load(key) !== null,
    storageKey,
  }
}
