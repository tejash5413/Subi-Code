import * as assert from "node:assert/strict";
import { basename, join, resolve } from "node:path";
import * as vscode from "vscode";

/** Native extension-host qualification; invoke only in a disposable VS Code profile. */
export async function run() {
  console.log("SUBI_EXTENSION_HOST_START");
  const extension = vscode.extensions.getExtension("learnsmart.subicode");
  assert.ok(extension, "Subi Code development extension was not loaded");
  let activationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([extension.activate(), new Promise<never>((_, reject) => {
      activationTimer = setTimeout(() => reject(new Error("Subi extension activation did not finish")), 20_000);
    })]);
  } finally {if (activationTimer) {clearTimeout(activationTimer);}}
  console.log("SUBI_EXTENSION_HOST_ACTIVATED");
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "subicode.openTerminal",
    "subicode.openNewTerminal",
    "subicode.addFilepathToTerminal",
    "subicode.openDocumentation",
  ]) {
    assert.ok(commands.includes(command), `Missing ${command}`);
  }
  const before = new Set(vscode.window.terminals);
  try {
    await vscode.commands.executeCommand("subicode.openNewTerminal");
    const terminal = vscode.window.terminals.find(value => !before.has(value) && value.creationOptions.name === "Subi Code");
    assert.ok(terminal, "Subi terminal was not created");
    const options = terminal.creationOptions;
    assert.ok("shellPath" in options);
    assert.equal(basename(options.shellPath ?? ""), process.platform === "win32" ? "subi.exe" : "subi");
    const expected = resolve(join(extension.extensionPath, "bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "subi.exe" : "subi"));
    const actual = resolve(options.shellPath ?? "");
    assert.equal(process.platform === "win32" ? actual.toLowerCase() : actual, process.platform === "win32" ? expected.toLowerCase() : expected, "Expected the bundled SUBI CLI");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.ok(await Promise.race([terminal.processId, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Subi terminal process did not start")), 20_000);
      })]));
    } finally { if (timer) {clearTimeout(timer);} }
    assert.equal(terminal.exitStatus, undefined, "Bundled CLI must remain running");
    // VS Code treats the API-supplied name as static on POSIX. Exercise an actual
    // user rename instead of assuming an OSC title sequence changes the tab name.
    terminal.show();
    await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name: "Renamed Subi qualification" });
    const renamed = Date.now() + 20_000;
    while (terminal.name !== "Renamed Subi qualification" && Date.now() < renamed) {
      assert.equal(terminal.exitStatus, undefined, "Bundled CLI exited while renaming its terminal");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(terminal.name, "Renamed Subi qualification", "Rename must finish before reuse is tested");
    const count = vscode.window.terminals.length;
    console.log("SUBI_TERMINAL_BEFORE_REUSE", JSON.stringify(vscode.window.terminals.map(value => ({ name: value.name, initialName: value.creationOptions.name, exited: value.exitStatus !== undefined }))));
    await vscode.commands.executeCommand("subicode.openTerminal");
    assert.equal(vscode.window.terminals.length, count, "Open should focus the existing Subi terminal");
    assert.equal(vscode.window.activeTerminal, terminal, "Open should focus the original terminal after its title changes");
    assert.equal(terminal.exitStatus, undefined, "Reused Subi terminal must still be running");
    await vscode.commands.executeCommand("subicode.openNewTerminal");
    assert.equal(vscode.window.terminals.length, count + 1, "New tab should create a separate owned terminal");
    console.log("SUBI_EXTENSION_HOST_PASS: commands, bundled executable, native process and terminal reuse");
  } finally {
    for (const terminal of vscode.window.terminals) {if (!before.has(terminal)) {terminal.dispose();}}
  }
}
