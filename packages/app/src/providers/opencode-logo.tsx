import { Mark } from "@opencode/ui/logo"

// Preserve the existing component API while rendering Subi's supplied mark.
export function OpenCodeLogo(props: { class?: string }) {
  return <Mark class={props.class} />
}
