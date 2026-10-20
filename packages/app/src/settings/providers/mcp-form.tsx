import type { McpAddInput } from "@opencode/client/promise"
import { RemoteMcpConnectionForm } from "@opencode/ui/remote-mcp-connection-form"
import { useDialog } from "@opencode/ui/context/dialog"
import { useLanguage } from "@/runtime/i18n/language"

export function McpConnectionForm(props: {
  existing?: { name: string; url: string }
  names: string[]
  save: (name: string, config: McpAddInput["config"]) => Promise<void>
}) {
  const language = useLanguage()
  const dialog = useDialog()

  return <RemoteMcpConnectionForm {...props} translate={language.t} close={() => dialog.close()} />
}
