import path from "path"
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "fs/promises"

export function readText(filePath: string) {
  return readFile(filePath, "utf8")
}

export async function readJson<T>(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as T
}

export async function writeText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

export async function appendText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, content)
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value)).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
  await replace(temporary, filePath).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}

async function replace(source: string, target: string, attempt = 0): Promise<void> {
  await rename(source, target).catch(async (error: unknown) => {
    // Windows readers and scanners can briefly hold the destination without
    // delete-sharing. Keep the original file intact and retry the same rename.
    if (
      process.platform !== "win32" ||
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "EPERM" && error.code !== "EBUSY") ||
      attempt >= 5
    )
      throw error
    await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    await replace(source, target, attempt + 1)
  })
}
