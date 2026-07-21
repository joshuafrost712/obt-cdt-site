# Feedback inbox

In-app feedback collected while reviewing the OBT-CDT site lands here. The
dev-only feedback tools (highlight text → comment → rank → "Send batch to
Claude") write one markdown file per batch into `incoming/`. The system is the
same reusable pattern used in the genre-research-app and documented in Cairn's
`docs/feedback-widget-pattern.md`.

Text edits made through the edit-in-place tool are applied directly to
`src/content/site-content.json` by the dev server and also documented in the
batch (with `applied: true/false`), so nothing is lost if the dev server was
unreachable.

## How Claude should handle a batch

When Josh says **"review the feedback batch"** (or points at a file in `incoming/`):

1. **Read every file in `incoming/` first.** Don't start on the first comment.
2. **Cluster across all of them** by theme and shared root cause. Note the
   importance ranks (high / medium / low) carried in each comment.
3. **Propose ONE consolidated plan** grouped by pattern, not a per-comment
   to-do list. Recurring issues should be fixed once, at the right altitude.
4. **Get approval, implement, then move the processed files** from `incoming/`
   to `processed/` so the inbox reflects only unhandled feedback.

Do **not** act on individual comments in isolation. The whole point of batching
is that overarching issues are easier and safer to handle all at once.

## Folders

- `incoming/` — unhandled batches. Gitignored (transient working artifacts).
- `processed/` — batches already turned into a plan. Gitignored.
- `server/` — the Google Apps Script sink for feedback submitted from the
  deployed site (see the genre-research-app's `feedback/server/README.md` for
  deploy steps; set the web-app URL as the `VITE_FEEDBACK_URL` repo variable).
