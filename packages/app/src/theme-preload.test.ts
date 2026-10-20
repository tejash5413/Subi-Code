import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

const setSystemDark = (matches: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    // SAFETY: the preload reads only matches; no MediaQueryList event methods are used.
    value: () => ({ matches }) as MediaQueryList,
    configurable: true,
  })

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  document.documentElement.style.removeProperty("background-color")
  localStorage.clear()
  setSystemDark(false)
})

describe("theme preload", () => {
  test.each([
    { stored: undefined, systemDark: false, scheme: "light", background: "#fafafa" },
    { stored: "dark", systemDark: false, scheme: "dark", background: "#080808" },
    { stored: "light", systemDark: true, scheme: "light", background: "#fafafa" },
    { stored: "system", systemDark: true, scheme: "dark", background: "#080808" },
  ])(
    "paints the default theme in $scheme for stored scheme $stored (system dark: $systemDark)",
    ({ stored, systemDark, scheme, background }) => {
      setSystemDark(systemDark)

      if (stored) localStorage.setItem("subi-color-scheme", stored)
      run()

      expect(document.documentElement.dataset.theme).toBe("oc-2")
      expect(document.documentElement.dataset.colorScheme).toBe(scheme)
      expect(document.documentElement.style.backgroundColor).toBe(background)
    },
  )

  test.each([
    { scheme: undefined, key: "subi-theme-css-light", css: "--background-base:#fff;", expected: "light" },
    { scheme: "dark", key: "subi-theme-css-dark", css: "--background-base:#010203;", expected: "dark" },
  ])("restores the cached $expected css of a custom theme", ({ scheme, key, css, expected }) => {
    localStorage.setItem("subi-theme-id", "nightowl")

    if (scheme) localStorage.setItem("subi-color-scheme", scheme)
    localStorage.setItem(key, css)
    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.documentElement.dataset.colorScheme).toBe(expected)
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain(css)
  })

  test("keeps upstream theme preferences separate during SUBI startup", () => {
    localStorage.setItem("opencode-theme-id", "upstream-theme")
    localStorage.setItem("opencode-color-scheme", "dark")
    localStorage.setItem("opencode-theme-css-dark", "--upstream-sentinel:1;")
    localStorage.setItem("subi-color-scheme", "light")
    run()

    expect(document.documentElement.dataset.theme).toBe("oc-2")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(document.head.textContent).not.toContain("upstream-sentinel")
    expect(localStorage.getItem("opencode-theme-id")).toBe("upstream-theme")
    expect(localStorage.getItem("opencode-color-scheme")).toBe("dark")
    expect(localStorage.getItem("opencode-theme-css-dark")).toBe("--upstream-sentinel:1;")
  })
})
