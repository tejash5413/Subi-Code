import * as vscode from 'vscode';
import { OnboardingView } from '../ui/onboarding/OnboardingView';
import { ExtensionToWebviewMessage } from '../types';

export class SidebarView {
  private readonly onboardingView: OnboardingView;

  constructor(extensionUri: vscode.Uri) {
    this.onboardingView = new OnboardingView(extensionUri);
  }

  public getHtml(webview: vscode.Webview): string {
    return this.onboardingView.getHtml(webview);
  }
}