import type { ReactNode } from 'react'
import { L } from './shared'

/**
 * The portal's shared form controls. Spec SITE-02 decision 1.
 *
 * ## Why this file exists at all
 *
 * `Choice`, `Area` and the card shell were declared `function` with no `export`
 * inside `WriteupForm.tsx`, so the evaluation form's Reuse section rested on four
 * symbols that could not be imported. SITE-02's review found it (its finding 1).
 * There is no third option that does not duplicate them, and a duplicated radio
 * group is a duplicated `data-dfb-node` contract: Joshua edits one copy in
 * `npm run dev` and the other keeps its old wording forever.
 *
 * `UnitCard` did NOT move. It is typed to `UnitForForm` and renders
 * `portal.assess.consultant.form.unit.*` nodes, so its visual shape is reusable
 * and the component is not. What moved is that shape, as `FieldCard`.
 *
 * ## Two props are new, and both default to CDT-04's behaviour
 *
 * Every existing call site renders byte-identically, which is what makes this an
 * extraction rather than a redesign.
 *
 * **`layout` on `Choice`.** CDT-04's options are one-word pills ("Low", "Yes")
 * and wrap fine. SITE-02's are the evaluation scale, and "Somewhat below average"
 * in a pill wraps mid-phrase at 390px; six of those wrapping is worse to use than
 * the Google Form's radio column, not better, which is the whole of D2a's ask.
 * So `layout="rows"` renders full-width rows with a visible radio. `pills` is the
 * default and is what every CDT-04 call site gets.
 *
 * **`required` on `Choice` and `Area`.** `Area` had no such prop, so a 44-input
 * form could be refused by the database after it was filled (SITE-02 finding 5).
 * The marker is visual only: `evalComplete()` mirrors the RPC's refusals and the
 * database remains the rule.
 */

/**
 * An option's label is EITHER a content node or a plain string, and the union is
 * load-bearing rather than a convenience.
 *
 * `siteLabel(id, fallback)` returns the node's text whenever the node exists, so
 * an option that names a node it does not own renders that node's text and not
 * its own. SITE-02's audience options are the case: their labels live in
 * `evaluation_respondent_group`, seeded from `Question-Set.md`, so they are
 * already contract-driven and there is no node to point at. Giving them one
 * would put the same sentence in two places, which is the drift the content
 * layer exists to prevent.
 */
export type ChoiceOption =
  | { value: string; node: string; fallback: string; text?: undefined }
  | { value: string; text: string; node?: undefined; fallback?: undefined }

export function RequiredMark() {
  return (
    <L
      className="ml-1 text-accent-deep"
      id="portal.field.required"
      fallback="(required)"
    />
  )
}

export function Choice({
  name,
  labelId,
  fallback,
  helpId,
  helpFallback,
  value,
  onChange,
  options,
  layout = 'pills',
  required = false,
  testId,
}: {
  name: string
  labelId: string
  fallback: string
  helpId?: string
  helpFallback?: string
  value: string
  onChange: (v: string) => void
  options: ChoiceOption[]
  layout?: 'pills' | 'rows'
  required?: boolean
  testId?: string
}) {
  const rows = layout === 'rows'
  return (
    <fieldset data-field={testId}>
      <legend className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        <L id={labelId} fallback={fallback} />
        {required && <RequiredMark />}
      </legend>
      {helpId && <L as="p" className="mt-0.5 text-xs text-ink-faint" id={helpId} fallback={helpFallback ?? ''} />}
      <div className={rows ? 'mt-1 flex flex-col gap-1.5' : 'mt-1 flex flex-wrap gap-2'}>
        {options.map((o) => (
          <label
            key={o.value}
            data-choice={o.value}
            className={
              (rows
                ? 'flex w-full cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm '
                : 'cursor-pointer rounded-lg border px-3 py-1.5 text-sm ') +
              (value === o.value
                ? 'border-brand bg-brand-soft font-semibold text-brand'
                : 'border-ink/20 text-ink-soft')
            }
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              /* In rows the radio is visible: a full-width row with no control
                 reads as a button, and a participant who has answered wants to
                 see six answers at once with one of them marked. */
              className={rows ? 'h-4 w-4 shrink-0 accent-current' : 'sr-only'}
            />
            {o.node ? <L id={o.node} fallback={o.fallback} /> : <span>{o.text}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function Area({
  id,
  labelId,
  fallback,
  helpId,
  helpFallback,
  value,
  onChange,
  rows = 3,
  required = false,
  placeholder,
}: {
  id: string
  labelId: string
  fallback: string
  helpId?: string
  helpFallback?: string
  value: string
  onChange: (v: string) => void
  rows?: number
  required?: boolean
  /**
   * Already-resolved text. A placeholder cannot carry `data-dfb-node`, so it is
   * one of `L`'s three documented exceptions and the CALLER resolves it through
   * `siteLabel()`, which is where pass A can see the literal.
   */
  placeholder?: string
}) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor={id}>
        <L id={labelId} fallback={fallback} />
        {required && <RequiredMark />}
      </label>
      {helpId && <L as="p" className="mt-0.5 text-xs text-ink-faint" id={helpId} fallback={helpFallback ?? ''} />}
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ink/20 bg-white px-3 py-2.5 text-ink outline-none focus:border-accent"
      />
    </div>
  )
}

/**
 * `UnitCard`'s visual shape without its assessment typing: a bordered card with a
 * heading row, optional sub-label, and the controls beneath.
 */
export function FieldCard({
  anchor,
  heading,
  meta,
  children,
}: {
  anchor?: string
  heading: ReactNode
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-ink/10 bg-white/60 p-5" data-card={anchor}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">{heading}</div>
      {meta}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </div>
  )
}
