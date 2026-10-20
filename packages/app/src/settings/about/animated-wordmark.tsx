import { createEffect, For, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

const target = ["S", "U", "B", "I", " ", "C", "O", "D", "E"] as const

const choices = ["S", "U", "B", "I", "C", "O", "D", "E"] as const

export function AnimatedWordmark(props: { active: boolean }) {
  const [state, setState] = createStore({ letters: [...target] })
  const timers = new Set<ReturnType<typeof setTimeout>>()

  createEffect(
    on(
      () => props.active,
      (active) => {
        timers.forEach(clearTimeout)
        timers.clear()

        if (!active || matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setState("letters", [...target])

          return
        }

        const starts = target.map(() => choices[Math.floor(Math.random() * choices.length)])
        const settles = target.map(() => 6 + Math.floor(Math.random() * 8))
        const last = Math.max(...settles)
        setState("letters", starts)

        Array.from({ length: last }, (_, index) => index + 1).forEach((tick) => {
          const timer = setTimeout(() => {
            setState(
              "letters",
              target.map((letter, index) =>
                tick >= settles[index] ? letter : choices[Math.floor(Math.random() * choices.length)],
              ),
            )
            timers.delete(timer)
          }, tick * 75)

          timers.add(timer)
        })
      },
    ),
  )

  onCleanup(() => timers.forEach(clearTimeout))

  return (
    <svg class="settings-about-wordmark" viewBox="0 0 234 42" aria-hidden="true">
      <For each={state.letters}>
        {(letter, index) => (
          <text x={index() * 26} y="31" fill="currentColor" font-family="monospace" font-size="30" font-weight="700">
            {letter}
          </text>
        )}
      </For>
    </svg>
  )
}
