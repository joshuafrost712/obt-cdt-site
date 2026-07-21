/**
 * Live-apply half of edit-in-place (spec 10 WP9): POST the structured edit to
 * the dev server's /__content-edit endpoint, which patches
 * src/content/guide-content.json on disk (git-tracked; Vite hot-reloads).
 * Returns false when the endpoint is unreachable or refuses the edit — the
 * caller then keeps the edit as a pending suggestion in the feedback batch.
 */
export interface ContentEdit {
  nodeId: string
  field: string
  oldText: string
  newText: string
}

export async function applyContentEdit(edit: ContentEdit): Promise<boolean> {
  if (!import.meta.env.DEV) return false
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}__content-edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edit),
    })
    return res.ok
  } catch {
    return false
  }
}
