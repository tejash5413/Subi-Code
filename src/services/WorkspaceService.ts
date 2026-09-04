import * as vscode from 'vscode';
import { WorkspaceInfo, ProjectType } from '../types';

export class WorkspaceService {
  private readonly _onDidChangeWorkspace: vscode.EventEmitter<WorkspaceInfo | null> = new vscode.EventEmitter<WorkspaceInfo | null>();
  private readonly workspaceFoldersChangeDisposable: vscode.Disposable;

  constructor() {
    this.workspaceFoldersChangeDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.fireWorkspaceChange();
    });
  }

  public get onDidChangeWorkspace(): vscode.Event<WorkspaceInfo | null> {
    return this._onDidChangeWorkspace.event;
  }

  public async getCurrentWorkspaceInfo(): Promise<WorkspaceInfo | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }

    const primaryFolder = folders[0];
    const projectType = await this.detectProjectType(primaryFolder.uri);

    let flutterPackageName: string | undefined;
    if (projectType === 'flutter') {
      flutterPackageName = await this.extractFlutterPackageName(primaryFolder.uri);
    }

    return {
      name: primaryFolder.name,
      path: primaryFolder.uri.fsPath,
      projectType,
      workspaceFolderCount: folders.length,
      isMultiRoot: folders.length > 1,
    };
  }

  private async detectProjectType(folderUri: vscode.Uri): Promise<ProjectType> {
    const checks: Array<{ file: string; type: ProjectType; validator?: (content: string) => ProjectType | null }> = [
      { file: 'pubspec.yaml', type: 'flutter' },
      { file: 'package.json', type: 'node', validator: this.checkPackageJson.bind(this) },
      { file: 'pyproject.toml', type: 'python' },
      { file: 'requirements.txt', type: 'python' },
      { file: 'setup.py', type: 'python' },
      { file: 'Cargo.toml', type: 'rust' },
      { file: 'go.mod', type: 'go' },
      { file: 'pom.xml', type: 'java' },
      { file: 'build.gradle', type: 'java' },
    ];

    for (const check of checks) {
      const exists = await this.fileExists(vscode.Uri.joinPath(folderUri, check.file));
      if (exists) {
        if (check.validator) {
          const content = await this.readFile(vscode.Uri.joinPath(folderUri, check.file));
          const detectedType = content ? check.validator(content) : null;
          if (detectedType) {
            return detectedType;
          }
        } else {
          return check.type;
        }
      }
    }

    return 'generic';
  }

  private checkPackageJson(content: string): ProjectType {
    try {
      const pkg = JSON.parse(content);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps.next) {
        return 'nextjs';
      }
      if (deps.react) {
        return 'react';
      }
      if (pkg.name === 'vscode' || deps.vscode || deps['@vscode/test-electron']) {
        return 'vscode-extension';
      }
      return 'node';
    } catch {
      return 'node';
    }
  }

  private async extractFlutterPackageName(folderUri: vscode.Uri): Promise<string | undefined> {
    const pubspecUri = vscode.Uri.joinPath(folderUri, 'pubspec.yaml');
    const content = await this.readFile(pubspecUri);
    if (!content) {
      return undefined;
    }

    const match = content.match(/^name:\s*(\S+)/m);
    if (match && match[1]) {
      return match[1].trim();
    }
    return undefined;
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async readFile(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(data).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private async fireWorkspaceChange(): Promise<void> {
    const info = await this.getCurrentWorkspaceInfo();
    this._onDidChangeWorkspace.fire(info);
  }

  public dispose(): void {
    this.workspaceFoldersChangeDisposable.dispose();
    this._onDidChangeWorkspace.dispose();
  }
}