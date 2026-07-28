import { useEffect, useRef, useState } from 'react'

/**
 * Tracks which [data-hb-section] is currently being read, plus how far through
 * the document the reader is. Used by the handbook's sticky rail and progress
 * bar. Same shape as useSceneProgress: plain numbers out, so the rail renders
 * a sensible static state with JS disabled.
 *
 * "Currently being read" is the last section whose top has crossed 30% of the
 * viewport, which tracks intent better than pure intersection when sections
 * differ a lot in length (the handbook's do: section 16 is three lines, 05 is
 * a page and a half).
 */
export function useScrollSpy(ids: string[]) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [activeId, setActiveId] = useState(ids[0] ?? '')
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let raf = 0
    const update = () => {
      raf = 0
      const rect = container.getBoundingClientRect()
      const vh = window.innerHeight
      const total = rect.height - vh
      setProgress(total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 0)

      const sections = container.querySelectorAll<HTMLElement>('[data-hb-section]')
      let current = sections[0]?.dataset.hbSection ?? ''
      sections.forEach((el) => {
        if (el.getBoundingClientRect().top < vh * 0.3) current = el.dataset.hbSection ?? current
      })
      setActiveId(current)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ids.length])

  return { containerRef, activeId, progress }
}
