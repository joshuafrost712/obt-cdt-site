import { useEffect, useRef } from 'react'

/**
 * Reveal-on-scroll. Pair with the `reveal` class: CSS hides the element only
 * when JS is present (html.js), this observer flips `data-revealed` the first
 * time it enters the viewport. No-JS visitors and the prerendered HTML always
 * see content; prefers-reduced-motion disables the transition in CSS.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || el.hasAttribute('data-revealed')) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.setAttribute('data-revealed', '')
          io.disconnect()
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return ref
}
