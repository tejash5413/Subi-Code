import { Logo } from "@opencode/ui/logo"
import "./wordmark.css"

export function NewSessionWordmark() {
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      class="pointer-events-none mx-auto w-full max-w-[720px] text-v2-text-text-base"
    >
      <div data-slot="wordmark-reveal" class="relative mx-auto w-4/5">
        <Logo class="block h-auto w-full" />
      </div>
    </div>
  )
}
