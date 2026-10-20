import { expect, test } from "bun:test"
import wsl from "./wsl"
import ssh from "./ssh"
import updater from "./updater"
import { Predicate } from "effect"

for (const definition of [wsl, ssh, updater]) {
  test(`${definition.id} presents Subi Code in English and lazy French copy`, async () => {
    const english = definition.i18n.en
    expect(Object.values(english).join("\n")).not.toContain("OpenCode")
    const french = definition.i18n.fr
    const messages = Predicate.isFunction(french) ? (await french()).default : french
    expect(Object.values(messages).join("\n")).not.toContain("OpenCode")
    // Locales may omit keys: the host fills those from English.
    expect(Object.keys(english)).toEqual(expect.arrayContaining(Object.keys(messages)))
  })
}
