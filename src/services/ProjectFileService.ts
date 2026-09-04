import * as vscode from 'vscode';
import { FileReadResult, FileReadError, ProjectFileItem } from '../types';

interface RegisteredProjectFile {
  uri: vscode.Uri;
  displayPath: string;
  workspaceFolderName: string;
}

export class ProjectFileService {
  private readonly fileIdMap = new Map<string, RegisteredProjectFile>();
  private static readonly MAX_FILES = 2000;
  private static readonly MAX_FILE_SIZE = 1024 * 1024; // 1 MB
  private static readonly BINARY_INSPECTION_CHUNK = 512;
  private static readonly EXCLUDE_PATTERNS = [
    '**/.git/**',
    '**/node_modules/**',
    '**/out/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/.venv/**',
    '**/venv/**',
    '__pycache__/**',
    '**/target/**',
    '**/.gradle/**',
    '**/vendor/**',
  ];

  public clear(): void {
    this.fileIdMap.clear();
  }

  public dispose(): void {
    this.fileIdMap.clear();
  }

  public hasRegisteredFiles(): boolean {
    return this.fileIdMap.size > 0;
  }

  public getRegisteredFiles(): ReadonlyArray<ProjectFileItem> {
    const items: ProjectFileItem[] = [];
    for (const [id, registered] of this.fileIdMap) {
      items.push({
        id,
        workspaceFolderName: registered.workspaceFolderName,
        displayPath: registered.displayPath,
      });
    }
    return items;
  }

  public getRegisteredFileForSearch(fileId: string): RegisteredProjectFile | undefined {
    return this.fileIdMap.get(fileId);
  }

  /**
   * Resolve a relative path to a registered file (Phase 10A: read_file tool).
   * Security-equivalent to the rest of this service: the registry is populated
   * by vscode.workspace.findFiles with the same exclude patterns, so any
   * match is, by construction, inside a workspace folder and not in
   * .git / node_modules / out / dist / build / .venv / target / .gradle /
   * vendor / __pycache__ / coverage. 1MB + binary + UTF-8 checks then apply
   * via the existing read path.
   *
   * Returns the fileId on success, or undefined when no registered file
   * matches the given relative path.
   */
  public async resolveRegisteredFileIdByPath(relativePath: string): Promise<string | undefined> {
    if (typeof relativePath !== 'string') {
      return undefined;
    }
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (normalized.length === 0) {
      return undefined;
    }
    if (normalized.includes('..')) {
      return undefined;
    }
    if (!this.hasRegisteredFiles()) {
      await this.listFiles();
    }
    let fallback: { id: string; len: number } | undefined;
    const lower = normalized.toLowerCase();
    for (const [id, entry] of this.fileIdMap) {
      if (entry.displayPath === normalized) {
        return id;
      }
      if (!fallback && entry.displayPath.toLowerCase() === lower) {
        fallback = { id, len: entry.displayPath.length };
        continue;
      }
      if (fallback && entry.displayPath.toLowerCase() === lower && entry.displayPath.length < fallback.len) {
        fallback = { id, len: entry.displayPath.length };
      }
    }
    return fallback?.id;
  }

  public async ensureFilesListed(): Promise<ProjectFileItem[]> {
    if (!this.hasRegisteredFiles()) {
      return this.listFiles();
    }
    return [...this.getRegisteredFiles()];
  }

  private generateFileId(): string {
    // Use crypto.randomUUID if available (Node 14.17+)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback: cryptographically secure random ID
    const array = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(array);
    } else {
      // Node.js fallback
      const cryptoNode = require('crypto');
      cryptoNode.randomFillSync(array);
    }
    return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  public async listFiles(): Promise<ProjectFileItem[]> {
    // Clear registry before every new list to prevent stale IDs
    this.fileIdMap.clear();

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return [];
    }

    const items: ProjectFileItem[] = [];
    let remainingCapacity = ProjectFileService.MAX_FILES;

    for (const folder of folders) {
      if (remainingCapacity <= 0) {
        break;
      }

      const pattern = new vscode.RelativePattern(folder, '**/*');
      const excludePattern = `{${ProjectFileService.EXCLUDE_PATTERNS.join(',')}}`;

      const uris = await vscode.workspace.findFiles(pattern, excludePattern, remainingCapacity);

      for (const uri of uris) {
        const relative = vscode.workspace.asRelativePath(uri, false);
        const id = this.generateFileId();

        this.fileIdMap.set(id, {
          uri,
          displayPath: folders.length > 1 ? `${folder.name}/${relative}` : relative,
          workspaceFolderName: folder.name,
        });

        items.push({
          id,
          workspaceFolderName: folder.name,
          displayPath: folders.length > 1 ? `${folder.name}/${relative}` : relative,
        });

        remainingCapacity--;

        if (remainingCapacity <= 0) {
          break;
        }
      }
    }

    // Sort case-insensitive alphabetical by displayPath
    items.sort((a, b) => a.displayPath.localeCompare(b.displayPath, undefined, { sensitivity: 'base' }));

    return items;
  }

  // Internal helper for binary/text detection and reading
  private async readAndValidateText(uri: vscode.Uri): Promise<{ content: string; size: number } | { reason: 'notFound' | 'tooLarge' | 'binary' | 'encoding' | 'invalid' }> {
    try {
      // Check file size
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > ProjectFileService.MAX_FILE_SIZE) {
        return { reason: 'tooLarge' };
      }

      // Read file bytes
      const bytes = await vscode.workspace.fs.readFile(uri);

      // Binary detection: check first 512 bytes for null bytes
      const chunk = bytes.slice(0, ProjectFileService.BINARY_INSPECTION_CHUNK);
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0) {
          return { reason: 'binary' };
        }
      }

      // Optional: high ratio of control characters (excluding tab, newline, carriage return)
      let controlChars = 0;
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        if (b < 32 && b !== 9 && b !== 10 && b !== 13) {
          controlChars++;
        }
      }
      if (chunk.length > 0 && controlChars / chunk.length > 0.3) {
        return { reason: 'binary' };
      }

      // Strict UTF-8 decoding
      let content: string;
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        content = decoder.decode(bytes);
      } catch {
        return { reason: 'encoding' };
      }

      return { content, size: stat.size };
    } catch (error) {
      if (error instanceof vscode.FileSystemError) {
        if (error.code === 'FileNotFound') {
          return { reason: 'notFound' };
        }
      }
      return { reason: 'invalid' };
    }
  }

  public async readFile(fileId: string): Promise<FileReadResult | FileReadError> {
    const registered = this.fileIdMap.get(fileId);
    if (!registered) {
      return { type: 'validation', message: 'Unknown or invalid file ID.' };
    }

    const { uri, displayPath } = registered;
    const result = await this.readAndValidateText(uri);

    if ('reason' in result) {
      switch (result.reason) {
        case 'tooLarge':
          return { type: 'tooLarge', message: 'File too large to preview.', size: 0 };
        case 'binary':
          return { type: 'binary', message: 'Binary files cannot be previewed.' };
        case 'encoding':
          return { type: 'encoding', message: 'This file cannot be previewed as UTF-8 text.' };
        case 'notFound':
          return { type: 'notFound', message: 'File not found.' };
        default:
          return { type: 'unknown', message: 'Failed to read file.' };
      }
    }

    return {
      fileId,
      displayPath,
      content: result.content,
      size: result.size,
    };
  }

  // For content search - returns text or skip reason without user-facing errors
  public async readTextForSearch(fileId: string): Promise<
    | { ok: true; content: string; displayPath: string; size: number }
    | { ok: false; reason: 'notFound' | 'tooLarge' | 'binary' | 'encoding' | 'invalid' }
  > {
    const registered = this.fileIdMap.get(fileId);
    if (!registered) {
      return { ok: false, reason: 'notFound' };
    }

    const { uri, displayPath } = registered;
    const result = await this.readAndValidateText(uri);

    if ('reason' in result) {
      return { ok: false, reason: result.reason };
    }

    return {
      ok: true,
      content: result.content,
      displayPath,
      size: result.size,
    };
  }
}