import { type ComponentProps } from "solid-js"
import { brandMark } from "./brand-mark"

// The same five-row block lettering used by the terminal welcome screen.
const wordmark = [
  " ████ █   █ ████  █████   ████  ███  ████  █████",
  "█     █   █ █   █   █    █     █   █ █   █ █    ",
  " ███  █   █ ████    █    █     █   █ █   █ ████ ",
  "    █ █   █ █   █   █    █     █   █ █   █ █    ",
  "████   ███  ████  █████   ████  ███  ████  █████",
]
const wordmarkPath = wordmark
  .flatMap((row, y) =>
    Array.from(row).flatMap((cell, x) => (cell === "█" ? [`M${x} ${y * 2}h1v2h-1z`] : [])),
  )
  .join("")

export const Mark = (props: Pick<ComponentProps<"svg">, "class" | "role" | "aria-label" | "aria-hidden">) => {
  return (
    <svg
      data-component="logo-mark"
      role={props.role}
      aria-label={props["aria-label"]}
      aria-hidden={props["aria-hidden"]}
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <BrandMark />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <BrandMark />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Subi Code"
      viewBox="0 0 62 10"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g transform="scale(0.416666667)">
        <BrandMark />
      </g>
      <path transform="translate(14 0)" d={wordmarkPath} fill="var(--icon-strong-base)" />
    </svg>
  )
}

function BrandMark() {
  return <image data-slot="brand-mark" width="24" height="24" href={brandMark} />
}
