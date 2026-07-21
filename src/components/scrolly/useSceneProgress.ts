import { useEffect, useRef, useState } from 'react'

/**
 * Drives the home visual essay. Tracks scroll through a container of
 * [data-scene] elements and reports:
 *   - stage: index of the scene currently in focus (crosses 55% viewport)
 *   - progress: 0→1 through the whole container
 * rAF-throttled scroll math; no library. The diagram consumes these as plain
 * props, so with JS disabled the essay renders complete and static.
 */
export function useSceneProgress() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState(0)
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
      const scenes = container.querySelectorAll('[data-scene]')
      let active = 0
      scenes.forEach((el, i) => {
        if (el.getBoundingClientRect().top < vh * 0.55) active = i
      })
      setStage(active)
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
  }, [])

  return { containerRef, stage, progress }
}
