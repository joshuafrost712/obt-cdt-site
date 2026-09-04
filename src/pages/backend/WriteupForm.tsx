import { useEffect, useMemo, useRef, useState } from 'react'
import { ErrorNote, L } from './shared'
// Spec SITE-02 decision 1: these two were module-private here, so the evaluation
// form could not import them. They moved out unchanged; every call site below
// renders exactly as it did.
import { Area, Choice } from './formFields'
import { siteLabel } from '../../lib/content/loader'
import { clearDraft, loadDraft, saveDraft, type DraftUnit } from '../../lib/backend/writeupDraft'
import {
  submitWriteup,
  type AssignmentRow,
  type ScalePoint,
  type SubmissionRatingRow,
  type SubmissionRow,
  type UnitForForm,
  type WriteupRating,
} from '../../lib/backend/assessApi'

/**
 * The write-up form. Spec CDT-04 D4 and D6.
 *
 * ## It is sized against I-1, not against the smallest bundle
 *
 * I-1 is 16 units at seven fields each, over nine header fields: 121 inputs. The
 * spec's first draft sized it at nine units and 58, which is where a dense form
 * quietly beats an automated layout audit while showing a phone reader one
 * unreadable column. So: one card per unit rather than a table, every control
 * full width at 390px, and the unit key and statement as the card's own heading
 * so a consultant can find their place after looking away.
 *
 * ## Every keystroke has a home before the database has anything
 *
 * `submission.consent_recorded` is `not null` with no default and
 * `submission_rating.evidence_sentence` is `not null` per unit, so the schema
 * accepts nothing until everything exists. The draft store is what stands between
 * a two-hour viva and a closed tab. It is device-local, it says so on screen, and
 * it is cleared only after the write returns.
 *
 * ## One call, and the coverage rule is not ours
 *
 * `submitWriteup()` is a single RPC. The completeness check below is a courtesy
 * that keeps the button honest; the rule is `submit_writeup()`'s own coverage
 * gate, which refuses a write-up that rates fewer units than its bundle holds.
 * If these two ever disagree, the database wins and the message says so.
 */
export function WriteupForm({
  assignment,
  units,
  scale,
  existing,
  existingRatings,
  onFiled,
}: {
  assignment: AssignmentRow
  units: UnitForForm[]
  scale: ScalePoint[]
  existing: SubmissionRow | null
  existingRatings: SubmissionRatingRow[]
  onFiled: () => void
}) {
  const draftOnDisk = useMemo(() => loadDraft(assignment.id), [assignment.id])
  const [restorePrompt, setRestorePrompt] = useState(draftOnDisk !== null)
  const [header, setHeader] = useState<Record<string, string | boolean>>(() => seedHeader(existing))
  const [unitState, setUnitState] = useState<Record<string, DraftUnit>>(() => seedUnits(existingRatings))
  const [savedAt, setSavedAt] = useState<string | null>(draftOnDisk?.savedAt ?? null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const firstRender = useRef(true)

  // Autosave on every change. The first render is skipped so that merely opening
  // the page does not write an empty draft over a real one.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const ok = saveDraft(assignment.id, { header, units: unitState })
    setSaveFailed(!ok)
    if (ok) setSavedAt(new Date().toISOString())
  }, [assignment.id, header, unitState])

  const restore = () => {
    const d = loadDraft(assignment.id)
    if (d) {
      setHeader(d.header)
      setUnitState(d.units)
      setSavedAt(d.savedAt)
    }
    setRestorePrompt(false)
  }

  const discard = () => {
    clearDraft(assignment.id)
    setSavedAt(null)
    setRestorePrompt(false)
  }

  const complete = units.filter((u) => unitDone(unitState[u.unit_key])).length
  const canFile = complete === units.length && header.consent_recorded === true

  const file = async () => {
    setWorking(true)
    setError('')
    try {
      const ratings: WriteupRating[] = units.map((u) => {
        const s = unitState[u.unit_key] ?? {}
        return {
          unit_key: u.unit_key,
          observed_level: Number(s.observed_level) as 0 | 1 | 2 | 3,
          recommended_level: Number(s.recommended_level) as 0 | 1 | 2 | 3,
          confidence: (s.confidence ?? 'medium') as 'low' | 'medium' | 'high',
          evidence_sentence: (s.evidence_sentence ?? '').trim(),
          plain_language_check: (s.plain_language_check ?? 'partly') as 'yes' | 'partly' | 'no',
          plain_language_note: s.plain_language_note?.trim() || null,
          escalate: s.escalate === true,
        }
      })
      await submitWriteup({
        assignmentId: assignment.id,
        consentRecorded: header.consent_recorded === true,
        bodyMd: String(header.body_md ?? ''),
        strengthNote: str(header.strength_note),
        growthNote1: str(header.growth_note_1),
        growthNote2: str(header.growth_note_2),
        contextNote: str(header.context_note),
        connectionQuality: (str(header.connection_quality) as 'good' | 'patchy' | 'poor' | null) ?? null,
        transcriptSource: (String(header.transcript_source || 'none') as 'manual-upload' | 'none'),
        ratings,
        sourceUrl: str(header.source_url),
      })
      // Only now. The Web-App-Build-Protocol's first reliability invariant: never
      // report a state change that did not persist.
      clearDraft(assignment.id)
      onFiled()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(false)
    }
  }

  return (
    <section className="mt-8" id="cdt-writeup">
      <L
        as="h2"
        className="font-display text-xl font-semibold text-ink"
        id="portal.assess.consultant.form.heading"
        fallback="Write up the session"
      />
      <L
        as="p"
        className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft"
        id="portal.assess.consultant.form.intro"
        fallback="Rate every unit the occasion covers. The one sentence of evidence per unit is what makes a rating defensible a year from now."
      />

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <L className="font-semibold uppercase tracking-wide text-ink-faint" id="portal.assess.consultant.form.progress.label" fallback="Units rated" />
        <span className="font-medium text-ink" data-cdt-progress={`${complete}/${units.length}`}>
          {complete}/{units.length}
        </span>
        <span className="text-ink-faint" data-cdt-draft-state={savedAt ? 'saved' : 'never'}>
          {savedAt
            ? siteLabel('portal.assess.consultant.form.draft.saved', 'Saved on this device')
            : siteLabel('portal.assess.consultant.form.draft.never', 'Not saved yet')}
        </span>
      </div>
      <L
        as="p"
        className="mt-1 text-xs leading-relaxed text-ink-faint"
        id="portal.assess.consultant.form.draft.device-note"
        fallback="Drafts are held in this browser on this device only. They are not on the server, and clearing your browser data removes them."
      />
      {saveFailed && (
        <L
          as="p"
          className="mt-2 rounded-lg bg-accent-soft/50 px-3 py-2 text-xs text-accent-deep"
          id="portal.assess.consultant.form.draft.failed"
          fallback="This browser refused to save the draft. Finish and file in one sitting, or keep your notes somewhere else as well."
        />
      )}

      {restorePrompt && (
        <div className="mt-4 rounded-2xl border border-brand/30 bg-brand-soft/40 p-4" id="cdt-restore">
          <L
            as="p"
            className="text-sm text-ink"
            id="portal.assess.consultant.form.draft.restore.heading"
            fallback="There is an unfinished write-up for this session on this device."
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" id="cdt-restore-yes" onClick={restore} className="rounded-full bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-accent">
              <L id="portal.assess.consultant.form.draft.restore.cta" fallback="Pick up where I left off" />
            </button>
            <button type="button" id="cdt-restore-no" onClick={discard} className="rounded-full border border-ink/20 px-4 py-2 text-xs font-medium text-ink-soft hover:bg-paper-deep">
              <L id="portal.assess.consultant.form.draft.restore.discard" fallback="Start again" />
            </button>
          </div>
        </div>
      )}

      {scale.length > 0 && (
        <details className="mt-6 rounded-2xl border border-ink/10 bg-white/60 p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink">
            <L id="portal.assess.consultant.form.scale.heading" fallback="What the levels mean" />
          </summary>
          <dl className="mt-3 flex flex-col gap-2">
            {scale.map((s) => (
              <div key={s.level}>
                <dt className="text-xs font-semibold text-ink">{s.level}. {s.label}</dt>
                <dd className="text-xs leading-relaxed text-ink-soft">{s.definition}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {/* ------------------------------------------------- the nine header fields */}
      <div className="mt-6 flex flex-col gap-4 rounded-2xl border border-ink/10 bg-white/60 p-5">
        <label className="flex items-start gap-3">
          <input
            id="cdt-consent"
            type="checkbox"
            checked={header.consent_recorded === true}
            onChange={(e) => setHeader((h) => ({ ...h, consent_recorded: e.target.checked }))}
            className="mt-1 h-4 w-4 shrink-0"
          />
          <span>
            <L as="span" className="text-sm font-medium text-ink" id="portal.assess.consultant.form.consent.label" fallback="The CIT agreed to this session going into the track's record" />
            <L as="span" className="mt-0.5 block text-xs text-ink-faint" id="portal.assess.consultant.form.consent.note" fallback="Required. Ask at the start of the call, then tick it here." />
          </span>
        </label>

        <Area id="cdt-body" labelId="portal.assess.consultant.form.body.label" fallback="How the session went" helpId="portal.assess.consultant.form.body.help" helpFallback="A paragraph or two in your own words." value={String(header.body_md ?? '')} onChange={(v) => setHeader((h) => ({ ...h, body_md: v }))} rows={5} />
        <Area id="cdt-strength" labelId="portal.assess.consultant.form.strength.label" fallback="One thing they did well" value={String(header.strength_note ?? '')} onChange={(v) => setHeader((h) => ({ ...h, strength_note: v }))} />
        <Area id="cdt-growth1" labelId="portal.assess.consultant.form.growth1.label" fallback="First thing to grow" value={String(header.growth_note_1 ?? '')} onChange={(v) => setHeader((h) => ({ ...h, growth_note_1: v }))} />
        <Area id="cdt-growth2" labelId="portal.assess.consultant.form.growth2.label" fallback="Second thing to grow" value={String(header.growth_note_2 ?? '')} onChange={(v) => setHeader((h) => ({ ...h, growth_note_2: v }))} />
        <Area id="cdt-context" labelId="portal.assess.consultant.form.context.label" fallback="Anything that affected the session" helpId="portal.assess.consultant.form.context.help" helpFallback="Illness, a bad line, an interruption. It changes how the rating should be read." value={String(header.context_note ?? '')} onChange={(v) => setHeader((h) => ({ ...h, context_note: v }))} />

        <Choice
          name="cdt-connection"
          labelId="portal.assess.consultant.form.connection.label"
          fallback="Connection quality"
          value={String(header.connection_quality ?? '')}
          onChange={(v) => setHeader((h) => ({ ...h, connection_quality: v }))}
          options={[
            { value: 'good', node: 'portal.assess.consultant.form.connection.good', fallback: 'Good' },
            { value: 'patchy', node: 'portal.assess.consultant.form.connection.patchy', fallback: 'Patchy' },
            { value: 'poor', node: 'portal.assess.consultant.form.connection.poor', fallback: 'Poor' },
          ]}
        />
        <Choice
          name="cdt-transcript"
          labelId="portal.assess.consultant.form.transcript.label"
          fallback="Transcript"
          value={String(header.transcript_source ?? 'none')}
          onChange={(v) => setHeader((h) => ({ ...h, transcript_source: v }))}
          options={[
            { value: 'none', node: 'portal.assess.consultant.form.transcript.none', fallback: 'None' },
            { value: 'manual-upload', node: 'portal.assess.consultant.form.transcript.manual-upload', fallback: 'Uploaded separately' },
          ]}
        />

        {/* Rubric row 7: the manual fallback loses nothing. Wave 1's sessions run
            on paper and a Google Doc, and this field is the migration path. */}
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor="cdt-source-url">
            <L id="portal.assess.consultant.form.source.label" fallback="Link to the document, if you wrote it up elsewhere" />
          </label>
          <L as="p" className="mt-0.5 text-xs text-ink-faint" id="portal.assess.consultant.form.source.help" fallback="A Google Doc link is fine. Paste it here so the record points at it." />
          <input
            id="cdt-source-url"
            type="url"
            value={String(header.source_url ?? '')}
            onChange={(e) => setHeader((h) => ({ ...h, source_url: e.target.value }))}
            className="mt-1 w-full rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-ink outline-none focus:border-accent"
          />
        </div>
      </div>

      {/* ------------------------------------------------------- one card per unit */}
      <div className="mt-6 flex flex-col gap-5">
        {units.map((u) => (
          <UnitCard
            key={u.unit_key}
            unit={u}
            scale={scale}
            value={unitState[u.unit_key] ?? {}}
            onChange={(patch) =>
              setUnitState((s) => ({ ...s, [u.unit_key]: { ...(s[u.unit_key] ?? {}), ...patch } }))
            }
          />
        ))}
      </div>

      <div className="mt-8 flex flex-col gap-3">
        {!canFile && (
          <L
            as="p"
            className="text-xs leading-relaxed text-ink-faint"
            id="portal.assess.consultant.form.submit.incomplete"
            fallback="Every unit needs an observed level, a recommendation, a confidence and a sentence of evidence before this can be filed."
          />
        )}
        <button
          type="button"
          id="cdt-file"
          disabled={working || !canFile}
          onClick={() => void file()}
          className="self-start rounded-full bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-accent disabled:opacity-50"
        >
          <L
            id={working ? 'portal.assess.consultant.form.submit.working' : 'portal.assess.consultant.form.submit.cta'}
            fallback={working ? 'Filing…' : 'File the write-up'}
          />
        </button>
        {error && (
          <div id="cdt-file-error">
            <L
              as="p"
              className="text-sm text-accent-deep"
              id="portal.assess.consultant.form.submit.error"
              fallback="The write-up was not filed. Nothing is lost: your draft is still on this device."
            />
            <ErrorNote error={error} />
          </div>
        )}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ pieces

function UnitCard({
  unit,
  scale,
  value,
  onChange,
}: {
  unit: UnitForForm
  scale: ScalePoint[]
  value: DraftUnit
  onChange: (patch: DraftUnit) => void
}) {
  const levels = scale.length > 0 ? scale.map((s) => s.level) : [0, 1, 2, 3]
  return (
    <div className="rounded-2xl border border-ink/10 bg-white/60 p-5" data-cdt-unit={unit.unit_key}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-display text-base font-semibold text-ink">{unit.unit_key}</span>
        <L
          className="rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft"
          id={unit.is_primary ? 'portal.assess.consultant.form.unit.primary' : 'portal.assess.consultant.form.unit.secondary'}
          fallback={unit.is_primary ? 'Primary' : 'Secondary'}
        />
        {unit.sub_area && <span className="text-xs text-ink-faint">{unit.sub_area}</span>}
      </div>
      <p className="mt-1 text-sm leading-relaxed text-ink">{unit.statement}</p>

      {unit.descriptors.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-ink-faint">
            <L id="portal.assess.consultant.form.unit.descriptors" fallback="What this unit covers" />
          </summary>
          <ul className="mt-1 list-disc pl-5 text-xs leading-relaxed text-ink-soft">
            {unit.descriptors.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-4 flex flex-col gap-4">
        <LevelRow
          name={`obs-${unit.unit_key}`}
          labelId="portal.assess.consultant.form.unit.observed"
          fallback="Observed"
          levels={levels}
          value={value.observed_level ?? ''}
          onChange={(v) => onChange({ observed_level: v })}
        />
        <LevelRow
          name={`rec-${unit.unit_key}`}
          labelId="portal.assess.consultant.form.unit.recommended"
          fallback="Recommend to CBC"
          levels={levels}
          value={value.recommended_level ?? ''}
          onChange={(v) => onChange({ recommended_level: v })}
        />
        <Choice
          name={`conf-${unit.unit_key}`}
          labelId="portal.assess.consultant.form.unit.confidence"
          fallback="Confidence"
          value={value.confidence ?? ''}
          onChange={(v) => onChange({ confidence: v })}
          options={[
            { value: 'low', node: 'portal.assess.consultant.form.confidence.low', fallback: 'Low' },
            { value: 'medium', node: 'portal.assess.consultant.form.confidence.medium', fallback: 'Medium' },
            { value: 'high', node: 'portal.assess.consultant.form.confidence.high', fallback: 'High' },
          ]}
        />
        <Area
          id={`cdt-ev-${unit.unit_key}`}
          labelId="portal.assess.consultant.form.unit.evidence"
          fallback="Evidence, one sentence"
          helpId="portal.assess.consultant.form.unit.evidence.help"
          helpFallback="Name the specific thing said or done."
          value={value.evidence_sentence ?? ''}
          onChange={(v) => onChange({ evidence_sentence: v })}
          rows={2}
        />
        <Choice
          name={`plain-${unit.unit_key}`}
          labelId="portal.assess.consultant.form.unit.plain"
          fallback="Could they explain it in plain language?"
          helpId="portal.assess.consultant.form.unit.plain.help"
          helpFallback="To a mother-tongue translator with six years of school and no theological training."
          value={value.plain_language_check ?? ''}
          onChange={(v) => onChange({ plain_language_check: v })}
          options={[
            { value: 'yes', node: 'portal.assess.consultant.form.unit.plain.yes', fallback: 'Yes' },
            { value: 'partly', node: 'portal.assess.consultant.form.unit.plain.partly', fallback: 'Partly' },
            { value: 'no', node: 'portal.assess.consultant.form.unit.plain.no', fallback: 'No' },
          ]}
        />
        <Area
          id={`cdt-plainnote-${unit.unit_key}`}
          labelId="portal.assess.consultant.form.unit.plainnote"
          fallback="Note on the plain-language check"
          value={value.plain_language_note ?? ''}
          onChange={(v) => onChange({ plain_language_note: v })}
          rows={2}
        />
        <label className="flex items-center gap-2">
          <input
            id={`cdt-esc-${unit.unit_key}`}
            type="checkbox"
            checked={value.escalate === true}
            onChange={(e) => onChange({ escalate: e.target.checked })}
            className="h-4 w-4"
          />
          <L className="text-xs text-ink-soft" id="portal.assess.consultant.form.unit.escalate" fallback="Flag this unit for the head mentor" />
        </label>
      </div>
    </div>
  )
}

function LevelRow({
  name,
  labelId,
  fallback,
  levels,
  value,
  onChange,
}: {
  name: string
  labelId: string
  fallback: string
  levels: number[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <fieldset>
      <legend className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        <L id={labelId} fallback={fallback} />
      </legend>
      <div className="mt-1 flex flex-wrap gap-2">
        {levels.map((n) => (
          <label
            key={n}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${
              value === String(n) ? 'border-brand bg-brand-soft font-semibold text-brand' : 'border-ink/20 text-ink-soft'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={String(n)}
              checked={value === String(n)}
              onChange={() => onChange(String(n))}
              className="sr-only"
            />
            {n}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

// ------------------------------------------------------------------ helpers

function str(v: string | boolean | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

function unitDone(u: DraftUnit | undefined): boolean {
  if (!u) return false
  return (
    u.observed_level !== undefined &&
    u.observed_level !== '' &&
    u.recommended_level !== undefined &&
    u.recommended_level !== '' &&
    !!u.confidence &&
    // btrim'd, because `not null` accepts the '' a form field submits and the
    // check constraint in the migration is what actually refuses it. Matching the
    // database's rule here means the button is disabled rather than the submit
    // being refused after 121 inputs.
    (u.evidence_sentence ?? '').trim().length > 0 &&
    !!u.plain_language_check
  )
}

/** A returned write-up is revised, not retyped, so its own values seed the form. */
function seedHeader(existing: SubmissionRow | null): Record<string, string | boolean> {
  if (!existing) return { transcript_source: 'none' }
  return {
    consent_recorded: existing.consent_recorded,
    body_md: existing.body_md ?? '',
    strength_note: existing.strength_note ?? '',
    growth_note_1: existing.growth_note_1 ?? '',
    growth_note_2: existing.growth_note_2 ?? '',
    context_note: existing.context_note ?? '',
    connection_quality: existing.connection_quality ?? '',
    transcript_source: existing.transcript_source ?? 'none',
  }
}

function seedUnits(rows: SubmissionRatingRow[]): Record<string, DraftUnit> {
  const out: Record<string, DraftUnit> = {}
  for (const r of rows) {
    out[r.unit_key] = {
      observed_level: String(r.observed_level),
      recommended_level: String(r.recommended_level),
      confidence: r.confidence,
      evidence_sentence: r.evidence_sentence,
      plain_language_check: r.plain_language_check,
      plain_language_note: r.plain_language_note ?? '',
      escalate: r.escalate,
    }
  }
  return out
}
