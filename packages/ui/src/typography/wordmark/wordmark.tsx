import { createUniqueId, type ComponentProps } from "solid-js"
import { brandMark } from "../../components/brand-mark"
import "../../components/logo.css"
import "./wordmark.css"

export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & {
    fade?: boolean
    muted?: boolean
    outline?: boolean
    stacked?: boolean
  },
) {
  const mask = createUniqueId()
  const gradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={props.stacked ? "0 0 480 360" : "0 0 720 129"}
      fill="none"
      class={props.class}
    >
      <g opacity={props.muted === false ? 1 : 0.6} mask={props.fade === false ? undefined : `url(#${mask})`}>
        <image
          data-slot="brand-mark"
          x={props.stacked ? 128 : 0}
          width={props.stacked ? 224 : 129}
          height={props.stacked ? 224 : 129}
          href={brandMark}
        />
        <text
          x={props.stacked ? 240 : 144}
          y={props.stacked ? 330 : 88}
          fill={props.outline ? "none" : "currentColor"}
          stroke={props.outline ? "currentColor" : undefined}
          stroke-width={props.outline ? 1 : undefined}
          text-anchor={props.stacked ? "middle" : undefined}
          font-family={props.stacked ? '"Keania One", sans-serif' : "monospace"}
          font-size={props.stacked ? "72" : "96"}
          font-weight={props.stacked ? "400" : "700"}
        >
          SUBI CODE
        </text>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${gradient})`} />
        </mask>
        <linearGradient id={gradient} x1="360" y1="68" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
