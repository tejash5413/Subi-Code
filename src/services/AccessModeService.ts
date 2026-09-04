import * as vscode from 'vscode';
import { SubiAccessMode } from '../types';

export class AccessModeService {
  private readonly context: vscode.ExtensionContext;
  private static readonly STORAGE_KEY = 'subi.accessMode';

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public getAccessMode(): SubiAccessMode | null {
    return this.context.globalState.get<SubiAccessMode>(AccessModeService.STORAGE_KEY) ?? null;
  }

  public async setAccessMode(mode: SubiAccessMode): Promise<void> {
    await this.context.globalState.update(AccessModeService.STORAGE_KEY, mode);
  }

  public async clearAccessMode(): Promise<void> {
    await this.context.globalState.update(AccessModeService.STORAGE_KEY, undefined);
  }

  public hasCompletedOnboarding(): boolean {
    return this.getAccessMode() !== null;
  }

  public hasByokConfiguration(): boolean {
    return this.getAccessMode() === 'byok';
  }
}