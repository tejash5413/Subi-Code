import { onCleanup } from "solid-js"
import { useThemes } from "../context/theme"
import { useToast } from "../ui/toast"
import { themeDisplayName } from "../theme"

export function ThemeErrorToast() {
  const themes = useThemes()
  const toast = useToast()

  onCleanup(
    themes.onError(({ name, error }) =>
      toast.show({
        variant: "error",
        title: `Failed to load theme: ${themeDisplayName(name)}`,
        message: error.message,
      }),
    ),
  )

  return null
}
