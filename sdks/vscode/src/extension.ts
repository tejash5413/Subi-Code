// This method is called when your extension is deactivated
export function deactivate() {}

import * as vscode from "vscode"
import { existsSync } from "node:fs"
import { join } from "node:path"

const TERMINAL_NAME = "Subi Code"

export function activate(context: vscode.ExtensionContext) {
  const terminals = new Set<vscode.Terminal>()
  context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => terminals.delete(terminal)))
  const openNewTerminalDisposable = vscode.commands.registerCommand("subicode.openNewTerminal", async () => {
    await openTerminal()
  })

  const openTerminalDisposable = vscode.commands.registerCommand("subicode.openTerminal", async () => {
    const existingTerminal = vscode.window.terminals.find((terminal) => terminals.has(terminal))
    if (existingTerminal) {
      existingTerminal.show()
      return
    }

    await openTerminal()
  })

  const addFilepathDisposable = vscode.commands.registerCommand("subicode.addFilepathToTerminal", async () => {
    const fileRef = getActiveFile()
    if (!fileRef) {
      return
    }

    const terminal = vscode.window.activeTerminal
    if (!terminal) {
      return
    }

    if (terminals.has(terminal)) {
      terminal.sendText(fileRef, false)
      terminal.show()
    }
  })

  const documentationDisposable = vscode.commands.registerCommand("subicode.openDocumentation", () =>
    vscode.env.openExternal(vscode.Uri.parse("https://stlearnsmart.in/subi-code/docs")),
  )

  context.subscriptions.push(
    openNewTerminalDisposable,
    openTerminalDisposable,
    addFilepathDisposable,
    documentationDisposable,
  )

  async function openTerminal() {
    const configured = vscode.workspace.getConfiguration("subicode").get<string>("executablePath", "").trim()
    const bundled = join(
      context.extensionPath,
      "bin",
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "subi.exe" : "subi",
    )
    const executable = configured || (existsSync(bundled) ? bundled : "subi")
    const active = vscode.window.activeTextEditor?.document.uri
    const folder =
      (active ? vscode.workspace.getWorkspaceFolder(active) : undefined) ?? vscode.workspace.workspaceFolders?.[0]
    // Create a new terminal in split screen
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      shellPath: executable,
      cwd: folder?.uri,
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
      },
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env: {
        OPENCODE_CALLER: "vscode",
      },
    })

    terminals.add(terminal)
    terminal.show()
  }

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) {
      return
    }

    const document = activeEditor.document
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    if (!workspaceFolder) {
      return
    }

    // Get the relative path from workspace root
    const relativePath = vscode.workspace.asRelativePath(document.uri)
    let filepathWithAt = `@${relativePath}`

    // Check if there's a selection and add line numbers
    const selection = activeEditor.selection
    if (!selection.isEmpty) {
      // Convert to 1-based line numbers
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1

      if (startLine === endLine) {
        // Single line selection
        filepathWithAt += `#L${startLine}`
      } else {
        // Multi-line selection
        filepathWithAt += `#L${startLine}-${endLine}`
      }
    }

    return filepathWithAt
  }
}
