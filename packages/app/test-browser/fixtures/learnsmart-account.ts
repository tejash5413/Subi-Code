import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { LearnSmartAccount } from "@opencode/schema/learnsmart-account"
import { LearnSmartLinks } from "@opencode/util/learnsmart"
import en from "@/runtime/i18n/en"

// Compile the actual component with Vite's Solid preset; Bun doesn't compile Solid JSX.
const require = createRequire(import.meta.url)
const solid = createRequire(require.resolve("vite-plugin-solid"))
const { transformSync } = solid("@babel/core")
Bun.plugin({
  name: "learnsmart-solid",
  setup(build) {
    build.onLoad({ filter: /[\\/]settings[\\/]providers[\\/]learnsmart-account\.tsx$/ }, async (args) => ({
      contents: transformSync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [solid.resolve("babel-preset-solid"), solid.resolve("@babel/preset-typescript")],
      }).code,
      loader: "js",
    }))
  },
})

const state = {
  value: {
    status: "allowed",
    accountType: "individual",
    quotaMode: "individual_credits",
    models: [],
    monthlyLimit: { configured: true, monthlyTokenLimit: null },
    usage: { status: "ready" },
    subscription: { active: true, renewalDateMs: 1_800_000_000_000 },
    credits: {
      health: "healthy",
      totalAvailableMilli: 75_005,
      monthlyGrantMilli: 100_000,
      monthlyRemainingMilli: 60_000,
      rolloverRemainingMilli: 5,
      purchasedRemainingMilli: 15_000,
      reservedMilli: 1000,
      cycleEndsAtMs: 1_800_000_000_000,
    },
    inferenceAvailable: false,
  } satisfies LearnSmartAccount.Snapshot as LearnSmartAccount.Snapshot,
  calls: [] as AbortSignal[],
  opened: [] as string[],
  syncs: [] as string[],
  listeners: new Set<(event: { data: { integrationID: string } }) => void>(),
  read: undefined as undefined | (() => Promise<LearnSmartAccount.Snapshot>),
}
mock.module("@/runtime/i18n/language", () => ({
  useLanguage: () => ({
    intl: () => "en-US",
    t: (key: keyof typeof en, params?: Record<string, string>) =>
      Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{{${name}}}`, value), en[key]),
  }),
}))
mock.module("@/runtime/platform/platform", () => ({
  usePlatform: () => ({ openExternal: (url: string) => state.opened.push(url) }),
}))
mock.module("@/runtime/server/client", () => ({
  useServerSDK: () => ({
    api: {
      rpc: () => ({
        get: (_input: unknown, options: { signal: AbortSignal }) => {
          state.calls.push(options.signal)
          return state.read ? state.read() : Promise.resolve(structuredClone(state.value))
        },
      }),
    },
    event: {
      on: (_type: string, listener: (event: { data: { integrationID: string } }) => void) => {
        const wrapped = (event: { data: { integrationID: string } }) => listener(event)
        state.listeners.add(wrapped)
        return () => state.listeners.delete(wrapped)
      },
    },
  }),
}))
mock.module("@/runtime/server/current", () => ({
  useData: () => ({
    location: {
      provider: {
        invalidate() {},
        sync: async () => {
          state.syncs.push("provider")
        },
      },
      model: {
        invalidate() {},
        sync: async () => {
          state.syncs.push("model")
        },
      },
    },
  }),
}))
const { LearnSmartAccountCard } = await import("@/settings/providers/learnsmart-account")
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

test("checkout waits for backend confirmation, refreshes catalog once, supports expired renewal, and clears school/logout balances", async () => {
  const [props, setProps] = createStore<{ credentialID?: string; directory: string }>({
    credentialID: "individual",
    directory: "D:/project",
  })
  const root = document.createElement("div")
  document.body.append(root)
  let connected = 0
  const dispose = render(
    () =>
      createComponent(LearnSmartAccountCard, {
        get credentialID() {
          return props.credentialID
        },
        get directory() {
          return props.directory
        },
        onConnect: () => connected++,
      }),
    root,
  )
  const button = (text: string) => {
    const value = [...root.querySelectorAll("button")].find((item) => item.textContent === text)
    expect(value, text).toBeDefined()
    return value!
  }
  try {
    await flush()
    expect(state.calls).toHaveLength(1)
    expect(root.textContent).toContain("75.005")
    expect(root.textContent).toContain("0.005")
    expect(root.textContent).toContain("Purchased credits15")
    button("Top up credits").click()
    expect(state.opened).toEqual([LearnSmartLinks.topup])
    expect(root.textContent).toContain("75.005") // No optimistic paid balance.
    const refreshed = Promise.withResolvers<LearnSmartAccount.Snapshot>()
    state.read = () => refreshed.promise
    window.dispatchEvent(new Event("focus"))
    window.dispatchEvent(new Event("focus"))
    button("Refresh account").click()
    expect(state.calls).toHaveLength(2)
    expect(root.textContent).not.toContain("75.005")
    state.value = {
      ...state.value,
      credits: { ...state.value.credits!, totalAvailableMilli: 175_005, purchasedRemainingMilli: 115_000 },
    }
    refreshed.resolve(structuredClone(state.value))
    await flush()
    state.read = undefined
    expect(root.textContent).toContain("175.005")
    expect(state.syncs).toEqual(["provider", "model", "provider", "model"])
    state.value = {
      ...state.value,
      status: "blocked",
      subscription: { active: false, renewalDateMs: 1_700_000_000_000 },
    }
    button("Refresh account").click()
    await flush()
    expect(root.textContent).toContain("expired or inactive")
    expect(root.textContent).not.toContain("Top up credits")
    expect(root.textContent).not.toContain("175.005")
    button("Purchase or renew subscription").click()
    expect(state.opened.at(-1)).toBe(LearnSmartLinks.subscription)
    state.value = {
      ...state.value,
      status: "allowed",
      subscription: { active: true, renewalDateMs: 1_900_000_000_000 },
    }
    window.dispatchEvent(new Event("focus"))
    await flush()
    expect(root.textContent).toContain("175.005")
    state.read = () => Promise.reject(new Error("account-token-sentinel"))
    button("Refresh account").click()
    await flush()
    expect(root.textContent).toContain("Could not refresh")
    expect(root.textContent).not.toContain("175.005")
    expect(root.textContent).not.toContain("account-token-sentinel")
    state.read = undefined
    button("Refresh account").click()
    await flush()
    expect(root.textContent).toContain("175.005")
    state.value = {
      ...state.value,
      // Login metadata can lag a server-side account migration. Quota authority wins.
      accountType: "individual",
      quotaMode: "school_tokens",
      credits: undefined,
      monthlyLimit: { configured: true, monthlyTokenLimit: 100_000 },
      usage: { status: "ready", remainingTokens: 90_000 },
    }
    setProps("credentialID", "school")
    await flush()
    expect(root.textContent).toContain("Your school manages")
    expect(root.textContent).toContain("90,000")
    expect(root.textContent).not.toContain("Top up credits")
    expect(root.textContent).not.toContain("Renew subscription")
    const late = Promise.withResolvers<LearnSmartAccount.Snapshot>()
    state.read = () => late.promise
    button("Refresh account").click()
    const pending = state.calls.at(-1)!
    setProps("credentialID", undefined)
    state.listeners.forEach((listener) => listener({ data: { integrationID: "learnsmart" } }))
    await flush()
    expect(pending.aborted).toBe(true)
    late.resolve(structuredClone(state.value))
    await flush()
    expect(root.textContent).not.toContain("90,000")
    button("Connect LearnSmart").click()
    expect(connected).toBe(1)
  } finally {
    dispose()
    root.remove()
  }
  expect(state.listeners.size).toBe(0)
})
