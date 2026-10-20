// @ts-nocheck
import * as mod from "./logo"

const docs = `### Overview
Subi Code logo assets: mark, splash, and wordmark.

Use Mark for compact spaces, Logo for headers, Splash for hero sections.

### API
- \`Mark\`, \`Splash\`, and \`Logo\` components accept standard SVG props.

### Variants and states
- Multiple logo variants for different contexts.

### Behavior
- SVG containers use the supplied transparent Subi Code image.

### Accessibility
- Provide title/aria-label when logos convey meaning.

### Theming/tokens
- The white/silver mark has a transparent background; the CLI-style wordmark follows theme tokens.

`

export default {
  title: "UI/Logo",
  id: "components-logo",
  component: mod.Logo,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = {
  render: () => (
    <div style={{ display: "grid", gap: "16px", "align-items": "start" }}>
      <div>
        <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>Mark</div>
        <mod.Mark />
      </div>
      <div>
        <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>Splash</div>
        <mod.Splash style={{ width: "80px", height: "100px" }} />
      </div>
      <div>
        <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>Logo</div>
        <mod.Logo style={{ width: "200px" }} />
      </div>
    </div>
  ),
}
