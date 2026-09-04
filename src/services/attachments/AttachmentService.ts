import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { randomUUID } from 'crypto';
import { SafeChatAttachment } from '../../types';
import { AIErrorClass } from '../ai/AIError';
import { detectImageBytes } from './ImageAttachmentUtils';

/**
 * Host-side explicit attachment registry (Stage 4A.2.3).
 *
 * All entries are created by trusted host pickers and keyed by opaque IDs.
 * The Webview only ever sees SafeChatAttachment metadata and sends IDs back.
 * Byte/URI truth never leaves the extension host (except bounded image
 * previews, which are non-authoritative display data only).
 */
export const ATTACHMENT_LIMITS = {
  MAX_ATTACHMENTS_PER_MESSAGE: 8,
  MAX_TEXT_ATTACHMENTS_PER_MESSAGE: 6,
  MAX_SINGLE_TEXT_BYTES: 256 * 1024,
  MAX_TOTAL_TEXT_BYTES: 1024 * 1024,
  MAX_IMAGES_PER_MESSAGE: 4,
  MAX_SINGLE_IMAGE_BYTES: 5 * 1024 * 1024,
  MAX_TOTAL_IMAGE_BYTES: 12 * 1024 * 1024,
  /** Preview data URLs are only generated at or below this size. */
  PREVIEW_MAX_BYTES: 512 * 1024,
} as const;

const BINARY_INSPECTION_BYTES = 512;

export interface TextAttachmentRecord {
  id: string;
  kind: 'text';
  uri: vscode.Uri;
  name: string;
  relativePath: string;
}

export interface ImageAttachmentRecord {
  id: string;
  kind: 'image';
  name: string;
  size: number;
  mimeType: string;
  width?: number;
  height?: number;
  /** Authoritative snapshot bytes (host memory only, never sent to Webview raw). */
  data: Uint8Array;
  /** Pick-time source key for duplicate detection only — never authorizes reads. */
  sourceKey: string;
}

export type AttachmentRecord = TextAttachmentRecord | ImageAttachmentRecord;

export interface ResolvedAttachments {
  textBlock: string;
  imageParts: Array<{ mimeType: string; data: Uint8Array }>;
  records: AttachmentRecord[];
}

function toSafe(record: AttachmentRecord): SafeChatAttachment {
  if (record.kind === 'text') {
    return { id: record.id, kind: 'text', name: record.name, size: 0, relativePath: record.relativePath };
  }
  return {
    id: record.id,
    kind: 'image',
    name: record.name,
    size: record.size,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
  };
}

function baseName(fsPath: string): string {
  return path.basename(fsPath);
}

export class AttachmentService implements vscode.Disposable {
  /** Pending composer attachments, insertion-ordered. Cleared only explicitly. */
  private readonly pending = new Map<string, AttachmentRecord>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        // Old pending IDs must no longer authorize reads after roots change.
        this.pending.clear();
      })
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.pending.clear();
  }

  getPending(): SafeChatAttachment[] {
    return [...this.pending.values()].map(toSafe);
  }

  /** Robust workspace containment via symlink-resolved real paths (no prefix hacks). */
  private async resolveInWorkspace(uri: vscode.Uri): Promise<{ relativePath: string } | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    let realFile: string;
    try {
      realFile = await fsp.realpath(uri.fsPath);
    } catch {
      return undefined;
    }
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(folder.uri.fsPath);
    } catch {
      realRoot = folder.uri.fsPath;
    }
    const rel = path.relative(realRoot, realFile);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return undefined;
    }
    return { relativePath: rel.split(path.sep).join('/') };
  }

  async pickProjectFiles(): Promise<{ added: SafeChatAttachment[]; errors: string[] }> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw AIErrorClass.attachment('Open a workspace folder first to attach project files.');
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Attach',
      defaultUri: folders[0].uri,
    });
    const added: SafeChatAttachment[] = [];
    const errors: string[] = [];
    if (!uris) {
      return { added, errors };
    }
    for (const uri of uris) {
      if (this.pending.size >= ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
        errors.push(`Attachment limit reached (${ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} per message).`);
        break;
      }
      const name = baseName(uri.fsPath);
      const contained = await this.resolveInWorkspace(uri);
      if (!contained) {
        errors.push(`"${name}" is outside the current workspace and was not attached.`);
        continue;
      }
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        errors.push(`"${name}" could not be read.`);
        continue;
      }
      if (stat.type !== vscode.FileType.File) {
        errors.push(`"${name}" is not a file and was not attached.`);
        continue;
      }
      const duplicate = [...this.pending.values()].some(
        (r) => r.kind === 'text' && (r as TextAttachmentRecord).uri.fsPath === uri.fsPath
      );
      if (duplicate) {
        continue;
      }
      const id = randomUUID();
      const record: TextAttachmentRecord = { id, kind: 'text', uri, name, relativePath: contained.relativePath };
      this.pending.set(id, record);
      added.push(toSafe(record));
    }
    return { added, errors };
  }

  async pickImages(): Promise<{
    added: SafeChatAttachment[];
    previews: Array<{ attachmentId: string; dataUrl: string }>;
    errors: string[];
  }> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Attach',
      filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
    });
    const added: SafeChatAttachment[] = [];
    const previews: Array<{ attachmentId: string; dataUrl: string }> = [];
    const errors: string[] = [];
    if (!uris) {
      return { added, previews, errors };
    }
    let pendingImageBytes = [...this.pending.values()]
      .filter((r): r is ImageAttachmentRecord => r.kind === 'image')
      .reduce((sum, r) => sum + r.size, 0);
    for (const uri of uris) {
      if (this.pending.size >= ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
        errors.push(`Attachment limit reached (${ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} per message).`);
        break;
      }
      const name = baseName(uri.fsPath);
      const duplicate = [...this.pending.values()].some(
        (r) => r.kind === 'image' && (r as ImageAttachmentRecord).sourceKey === uri.fsPath
      );
      if (duplicate) {
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch {
        errors.push(`"${name}" could not be read.`);
        continue;
      }
      if (bytes.length > ATTACHMENT_LIMITS.MAX_SINGLE_IMAGE_BYTES) {
        errors.push(`"${name}" exceeds the 5 MB per-image limit.`);
        continue;
      }
      if (pendingImageBytes + bytes.length > ATTACHMENT_LIMITS.MAX_TOTAL_IMAGE_BYTES) {
        errors.push(`Total image size would exceed the 12 MB limit.`);
        continue;
      }
      const detected = detectImageBytes(bytes);
      if (!detected) {
        errors.push(`"${name}" is not a supported image (PNG, JPEG, WEBP, GIF). SVG is not supported.`);
        continue;
      }
      const id = randomUUID();
      const record: ImageAttachmentRecord = {
        id,
        kind: 'image',
        name,
        size: bytes.length,
        mimeType: detected.mimeType,
        width: detected.width,
        height: detected.height,
        data: bytes,
        sourceKey: uri.fsPath,
      };
      this.pending.set(id, record);
      pendingImageBytes += bytes.length;
      added.push(toSafe(record));
      if (bytes.length <= ATTACHMENT_LIMITS.PREVIEW_MAX_BYTES) {
        previews.push({ attachmentId: id, dataUrl: `data:${detected.mimeType};base64,${Buffer.from(bytes).toString('base64')}` });
      }
    }
    return { added, previews, errors };
  }

  removeAttachment(id: string): boolean {
    return this.pending.delete(id);
  }

  /** Remove accepted IDs from pending (each send clears exactly its own snapshot). */
  clearResolved(ids: string[]): void {
    for (const id of ids) {
      this.pending.delete(id);
    }
  }

  clearAllPending(): void {
    this.pending.clear();
  }

  /** Read latest text content: dirty editor wins, else filesystem, with validation. */
  private async readTextAttachment(record: TextAttachmentRecord): Promise<{ content: string; bytes: number }> {
    const contained = await this.resolveInWorkspace(record.uri);
    if (!contained) {
      throw AIErrorClass.attachment(`"${record.name}" is no longer available in the workspace. Remove it and pick the file again.`);
    }
    const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === record.uri.fsPath);
    if (openDoc && openDoc.isDirty) {
      const content = openDoc.getText();
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > ATTACHMENT_LIMITS.MAX_SINGLE_TEXT_BYTES) {
        throw AIErrorClass.attachment(`"${record.name}" exceeds the 256 KB per-file limit.`);
      }
      this.assertTextual(new TextEncoder().encode(content.slice(0, 4096)), record.name);
      return { content, bytes };
    }
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(record.uri);
    } catch {
      throw AIErrorClass.attachment(`"${record.name}" is no longer available. Remove it and pick the file again.`);
    }
    if (stat.type !== vscode.FileType.File || stat.size > ATTACHMENT_LIMITS.MAX_SINGLE_TEXT_BYTES) {
      throw AIErrorClass.attachment(`"${record.name}" exceeds the 256 KB per-file limit.`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(record.uri);
    } catch {
      throw AIErrorClass.attachment(`"${record.name}" could not be read.`);
    }
    this.assertTextual(bytes, record.name);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw AIErrorClass.attachment(`"${record.name}" is not valid UTF-8 text and was not attached.`);
    }
    return { content, bytes: bytes.length };
  }

  private assertTextual(bytes: Uint8Array, name: string): void {
    const chunk = bytes.slice(0, BINARY_INSPECTION_BYTES);
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0) {
        throw AIErrorClass.attachment(`"${name}" looks like a binary file and cannot be attached as text.`);
      }
    }
    let control = 0;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (b < 32 && b !== 9 && b !== 10 && b !== 13) {
        control++;
      }
    }
    if (chunk.length > 0 && control / chunk.length > 0.3) {
      throw AIErrorClass.attachment(`"${name}" looks like a binary file and cannot be attached as text.`);
    }
  }

  /**
   * Resolve opaque IDs to send-time content. Throws attachment AIErrorClass
   * on any violation; never truncates source files.
   */
  async resolveForChat(ids: string[]): Promise<ResolvedAttachments> {
    if (ids.length > ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE) {
      throw AIErrorClass.attachment(
        `Too many attachments (maximum ${ATTACHMENT_LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} per message).`
      );
    }
    const records: AttachmentRecord[] = [];
    for (const id of ids) {
      const record = this.pending.get(id);
      if (!record) {
        throw AIErrorClass.attachment('An attachment is no longer available. Pick it again.');
      }
      records.push(record);
    }
    const texts = records.filter((r): r is TextAttachmentRecord => r.kind === 'text');
    const images = records.filter((r): r is ImageAttachmentRecord => r.kind === 'image');
    if (texts.length > ATTACHMENT_LIMITS.MAX_TEXT_ATTACHMENTS_PER_MESSAGE) {
      throw AIErrorClass.attachment(
        `Too many text attachments (maximum ${ATTACHMENT_LIMITS.MAX_TEXT_ATTACHMENTS_PER_MESSAGE} per message).`
      );
    }
    if (images.length > ATTACHMENT_LIMITS.MAX_IMAGES_PER_MESSAGE) {
      throw AIErrorClass.attachment(
        `Too many images (maximum ${ATTACHMENT_LIMITS.MAX_IMAGES_PER_MESSAGE} per message).`
      );
    }
    const imageBytes = images.reduce((sum, r) => sum + r.size, 0);
    if (imageBytes > ATTACHMENT_LIMITS.MAX_TOTAL_IMAGE_BYTES) {
      throw AIErrorClass.attachment('Total image size exceeds the 12 MB limit.');
    }
    let totalText = 0;
    const blocks: string[] = [];
    for (const t of texts) {
      const { content, bytes } = await this.readTextAttachment(t);
      totalText += bytes;
      if (totalText > ATTACHMENT_LIMITS.MAX_TOTAL_TEXT_BYTES) {
        throw AIErrorClass.attachment('Total attached text exceeds the 1 MB limit. Remove some files.');
      }
      blocks.push(`--- BEGIN FILE: ${t.relativePath} ---\n${content}\n--- END FILE: ${t.relativePath} ---`);
    }
    return {
      textBlock: blocks.join('\n\n'),
      imageParts: images.map((r) => ({ mimeType: r.mimeType, data: r.data })),
      records,
    };
  }
}
