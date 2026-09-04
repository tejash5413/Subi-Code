import * as vscode from 'vscode';

export class OnboardingView {
  private readonly extensionUri: vscode.Uri;
  private nonce: string;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    this.nonce = this.generateNonce();
  }

  private generateNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  public getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.css'));
    const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'marked.min.js'));
    const purifyUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'purify.min.js'));
    const katexCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'katex.min.css'));
    const katexJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'katex.min.js'));
    const katexAutoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'katex-auto-render.min.js'));
    const hljsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'highlight.min.js'));
    const hljsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'hljs-dark.min.css'));
    const markdownUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'markdown.js'));

    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${this.nonce}'`,
      // KaTeX fonts (woff2) served via the csp source (extension media origin)
      `font-src ${webview.cspSource} data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <link href="${katexCssUri}" rel="stylesheet">
  <link href="${hljsCssUri}" rel="stylesheet">
  <title>Subi</title>
</head>
<body>
  <div class="subi-root">
    <!-- Compact top header (main view only) -->
    <header class="subi-topbar subi-hidden" id="topbar">
      <span class="subi-brand">SUBI</span>
      <span class="subi-project-chip" id="topbar-project" title=""></span>
      <button class="subi-icon-btn" id="btn-settings" type="button" title="Settings" aria-label="Settings">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5a7.6 7.6 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.7 7.7 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </header>

    <!-- Compact AI status row (main view only) -->
    <div class="subi-ai-status-row subi-hidden" id="ai-status-row">
      <button class="subi-ai-status-btn" id="ai-status-btn" type="button" title="AI settings">
        <span class="subi-ai-status-label" id="ai-status-label">Not configured</span>
        <span class="subi-ai-status-chevron" aria-hidden="true">▾</span>
      </button>
    </div>

    <main class="subi-main" id="chat-main">
      <!-- Onboarding flow (unchanged IDs) -->
      <section class="subi-section subi-onboarding-section" id="onboarding-section">
        <div class="subi-onboarding-card subi-hidden" id="onboarding-welcome">
          <div class="subi-onboarding-title">Subi</div>
          <div class="subi-onboarding-subtitle">How would you like to continue?</div>
          <div class="subi-onboarding-buttons">
            <button class="subi-onboarding-btn subi-onboarding-btn-primary" id="btn-learnsmart" type="button">
              <span class="subi-onboarding-btn-icon">🔐</span>
              <span class="subi-onboarding-btn-content">
                <span class="subi-onboarding-btn-label">Sign in with LearnSmart</span>
                <span class="subi-onboarding-btn-desc">Existing LearnSmart students and teachers</span>
              </span>
            </button>
            <button class="subi-onboarding-btn" id="btn-free" type="button">
              <span class="subi-onboarding-btn-icon">🆓</span>
              <span class="subi-onboarding-btn-content">
                <span class="subi-onboarding-btn-label">Continue Free</span>
                <span class="subi-onboarding-btn-desc">No account or API key required</span>
              </span>
            </button>
            <button class="subi-onboarding-btn" id="btn-byok" type="button">
              <span class="subi-onboarding-btn-icon">🔑</span>
              <span class="subi-onboarding-btn-content">
                <span class="subi-onboarding-btn-label">Use My Own API Key</span>
                <span class="subi-onboarding-btn-desc">Connect your own AI provider</span>
              </span>
            </button>
          </div>
        </div>

        <div class="subi-onboarding-card subi-hidden" id="onboarding-learnsmart">
          <button class="subi-back-btn" id="btn-back-learnsmart" type="button" aria-label="Back">
            ← Back
          </button>
          <div class="subi-onboarding-title">Sign in to LearnSmart</div>
          <div class="subi-onboarding-subtitle">Existing LearnSmart students and teachers only.</div>
          <form class="subi-onboarding-form" id="learnsmart-form">
            <div class="subi-form-group">
              <label class="subi-form-label" for="learnsmart-email">Email</label>
              <input
                type="email"
                class="subi-form-input"
                id="learnsmart-email"
                placeholder="you@school.edu"
                autocomplete="email"
                required
              />
            </div>
            <div class="subi-form-group">
              <label class="subi-form-label" for="learnsmart-password">Password</label>
              <input
                type="password"
                class="subi-form-input"
                id="learnsmart-password"
                placeholder="••••••••"
                autocomplete="current-password"
                required
              />
            </div>
            <button class="subi-onboarding-btn subi-onboarding-btn-primary" id="btn-learnsmart-signin" type="submit">
              Sign In
            </button>
          </form>
          <div class="subi-onboarding-message subi-hidden" id="learnsmart-message"></div>
        </div>

        <div class="subi-onboarding-card subi-hidden" id="onboarding-free">
          <button class="subi-back-btn" id="btn-back-free" type="button" aria-label="Back">
            ← Back
          </button>
          <div class="subi-onboarding-title">Continue Free</div>
          <div class="subi-onboarding-subtitle">No LearnSmart account required. No personal API key required.</div>
          <div class="subi-onboarding-info">
            Free AI connection will be enabled in Stage 4A.4.
          </div>
          <div class="subi-onboarding-buttons">
            <button class="subi-onboarding-btn subi-onboarding-btn-primary" id="btn-free-continue" type="button">
              Continue
            </button>
            <button class="subi-onboarding-btn" id="btn-back-free-alt" type="button">
              Back
            </button>
          </div>
        </div>

        <div class="subi-onboarding-card subi-hidden" id="onboarding-byok">
          <button class="subi-back-btn" id="btn-back-byok" type="button" aria-label="Back">
            ← Back
          </button>
          <div class="subi-onboarding-title">Connect your API key</div>
          <div class="subi-onboarding-subtitle">Choose your AI provider</div>
          <div class="subi-form-group">
            <label class="subi-form-label" for="byok-provider-select">AI Provider</label>
            <select class="subi-form-input" id="byok-provider-select">
              <option value="openrouter">OpenRouter</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic / Claude</option>
              <option value="google">Google Gemini</option>
              <option value="deepseek">DeepSeek</option>
            </select>
          </div>
          <div class="subi-onboarding-buttons">
            <button class="subi-onboarding-btn subi-onboarding-btn-primary" id="btn-byok-configure" type="button">
              Configure Provider
            </button>
            <button class="subi-onboarding-btn" id="btn-back-byok-alt" type="button">
              Back
            </button>
          </div>
        </div>

        <div class="subi-onboarding-card subi-hidden" id="onboarding-loading">
          <div class="subi-loading-spinner"></div>
          <div class="subi-onboarding-title">Loading...</div>
          <div class="subi-onboarding-subtitle" id="loading-message"></div>
        </div>

        <div class="subi-onboarding-card subi-hidden" id="onboarding-error">
          <div class="subi-onboarding-title">Error</div>
          <div class="subi-onboarding-error" id="error-message"></div>
          <button class="subi-onboarding-btn" id="btn-error-back" type="button">Back</button>
        </div>
      </section>

      <!-- Main chat-first view -->
      <div class="subi-chat-view subi-hidden" id="main-chat-view">
        <div class="subi-chat-empty subi-hidden" id="chat-empty-state">
          <div class="subi-chat-empty-title" id="chat-empty-title">What are you building?</div>
          <button class="subi-btn-primary subi-hidden" id="btn-empty-configure" type="button">Configure AI</button>
        </div>
        <!-- LearnSmart managed session panel (Phase 6: configuration only) -->
        <div class="subi-managed-panel subi-hidden" id="managed-panel">
          <div class="subi-managed-status" id="managed-status-line"></div>
          <div class="subi-model-row subi-hidden" id="managed-model-row">
            <span class="subi-model-label">Managed Model</span>
            <button class="subi-model-picker-btn" id="managed-model-picker-btn" type="button">
              <span id="managed-model-label">No model selected</span>
              <span aria-hidden="true"> ›</span>
            </button>
          </div>
          <div class="subi-model-row subi-hidden" id="managed-limit-row">
            <span class="subi-model-label">Monthly Token Limit</span>
            <span class="subi-managed-value" id="managed-limit-label">Not Configured</span>
          </div>
          <div class="subi-btn-row subi-hidden" id="managed-actions-row">
            <button class="subi-list-btn" id="managed-retry-btn" type="button">Retry</button>
            <button class="subi-list-btn subi-danger" id="managed-signout-btn" type="button">Sign Out</button>
          </div>
        </div>
        <div class="subi-chat-messages" id="chat-messages" role="log" aria-live="polite"></div>
        <div class="subi-chat-thinking subi-hidden" id="chat-thinking">
          <span class="subi-thinking-spinner"></span>
          <span>Subi is thinking...</span>
        </div>
        <div class="subi-chat-error subi-hidden" id="chat-error"></div>
      </div>

      <!-- Settings overlay: home for all secondary controls -->
      <div class="subi-settings-overlay subi-hidden" id="settings-overlay">
        <div class="subi-settings-panel" role="dialog" aria-label="Settings">
          <div class="subi-settings-header">
            <button class="subi-icon-btn" id="btn-settings-back" type="button" title="Back" aria-label="Back">←</button>
            <span class="subi-settings-title" id="settings-title">Settings</span>
            <button class="subi-icon-btn" id="btn-settings-close" type="button" title="Close" aria-label="Close">✕</button>
          </div>
          <div class="subi-settings-body">
            <!-- Home -->
            <div class="subi-settings-view" id="settings-home">
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">ACCOUNT</div>
                <div class="subi-settings-summary" id="settings-account-summary">Guest</div>
                <button class="subi-list-btn subi-hidden" id="btn-account-signout" type="button">Sign Out</button>
              </div>
              <div class="subi-settings-group" id="settings-group-ai">
                <div class="subi-settings-group-title">AI</div>
                <div class="subi-settings-summary" id="settings-ai-summary">Not configured</div>
                <button class="subi-list-btn" id="btn-nav-ai-settings" type="button" data-nav="aiSettings">Provider &amp; Model →</button>
              </div>
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">PROJECT</div>
                <div class="subi-settings-summary" id="settings-project-summary">No project open</div>
                <button class="subi-list-btn" type="button" data-nav="projectSettings">Project details →</button>
                <button class="subi-list-btn" type="button" data-nav="projectFiles">Project files →</button>
                <button class="subi-list-btn" type="button" data-nav="projectSearch">Search project →</button>
              </div>
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">AGENT</div>
                <div class="subi-settings-summary" id="settings-agent-summary">Ask mode (Read-Only)</div>
                <button class="subi-list-btn" type="button" id="btn-set-agent-mode" title="Switch agent mode">Switch Mode →</button>
              </div>
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">CHAT</div>
                <button class="subi-list-btn" type="button" id="clear-chat-btn">Clear chat</button>
              </div>
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">SUBI</div>
                <button class="subi-list-btn" type="button" data-nav="about">About Subi →</button>
                <button class="subi-list-btn" type="button" id="btn-reset-onboarding">Reset Onboarding</button>
              </div>
              <div class="subi-settings-note">Opening settings never clears chat, history, or project state.</div>
            </div>

            <!-- AI settings: provider + model controls live here -->
            <div class="subi-settings-view subi-hidden" id="view-ai">
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">AI</div>
                <div class="subi-chat-status" id="chat-status">
                  <span class="subi-status-label">Status</span>
                  <span class="subi-status-value" id="chat-status-value">Not configured</span>
                </div>
                <div class="subi-model-row">
                  <span class="subi-model-label">Provider</span>
                  <button class="subi-model-picker-btn" id="btn-open-provider-picker" type="button">
                    <span id="ai-provider-label">OpenRouter</span>
                    <span aria-hidden="true"> ›</span>
                  </button>
                </div>
                <div class="subi-model-row">
                  <span class="subi-model-label">Model</span>
                  <button class="subi-model-picker-btn" id="model-picker-btn" type="button">
                    <span id="ai-model-label">Auto Free</span>
                    <span aria-hidden="true"> ›</span>
                  </button>
                </div>
                <div class="subi-cost-confirm subi-hidden" id="cost-confirm">
                  <div class="subi-onboarding-subtitle" id="cost-confirm-text">This model may use API credits or incur charges from your provider.</div>
                  <div class="subi-search-mode-row">
                    <button class="subi-mode-btn" id="btn-cost-cancel" type="button">Cancel</button>
                    <button class="subi-mode-btn subi-active" id="btn-cost-confirm" type="button">Use This Model</button>
                  </div>
                </div>
                <div class="subi-btn-row">
                  <button class="subi-list-btn" id="btn-configure-provider" type="button">Configure / Change Provider</button>
                  <button class="subi-list-btn subi-danger" id="btn-remove-provider-key" type="button">Remove API Key</button>
                </div>
              </div>
            </div>

            <!-- Provider picker (dedicated compact view) -->
            <div class="subi-settings-view subi-hidden" id="view-provider-picker">
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">SELECT PROVIDER</div>
                <div class="subi-pick-list" id="provider-list"></div>
              </div>
            </div>

            <!-- Model picker (dedicated full-height view with own scroll) -->
            <div class="subi-settings-view subi-hidden" id="view-model-picker">
              <div class="subi-settings-group subi-model-picker-view">
                <div class="subi-settings-group-title">SELECT MODEL</div>
                <input type="text" class="subi-search-input" id="model-search" placeholder="Search models..." spellcheck="false" />
                <div class="subi-search-mode-row">
                  <button class="subi-mode-btn subi-active" id="model-filter-free" type="button">Free</button>
                  <button class="subi-mode-btn" id="model-filter-all" type="button">All</button>
                </div>
                <div class="subi-model-list" id="model-list"></div>
                <button class="subi-list-btn" id="btn-refresh-models" type="button">Refresh Models</button>
                <div class="subi-error-state subi-hidden" id="model-catalog-error"></div>
              </div>
            </div>

            <!-- Project details -->
            <div class="subi-settings-view subi-hidden" id="view-project">
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">PROJECT</div>
                <section class="subi-project-section" id="project-section">
                  <div class="subi-no-project" id="no-project-state">
                    <div class="subi-no-project-title">No project open</div>
                    <div class="subi-no-project-hint">Open a folder to start using Subi.</div>
                  </div>
                  <div class="subi-project-card" id="project-card" style="display: none;">
                    <div class="subi-project-header">
                      <span class="subi-project-label">CURRENT PROJECT</span>
                    </div>
                    <div class="subi-project-name" id="project-name"></div>
                    <div class="subi-project-type" id="project-type"></div>
                    <div class="subi-project-path" id="project-path"></div>
                    <div class="subi-project-multi" id="project-multi" style="display: none;"></div>
                  </div>
                </section>
                <button class="subi-list-btn" type="button" data-nav="projectFiles">Project files →</button>
                <button class="subi-list-btn" type="button" data-nav="projectSearch">Search project →</button>
              </div>
            </div>

            <!-- Project files (Stage 3A UI relocated, same IDs/logic) -->
            <div class="subi-settings-view subi-hidden" id="view-files">
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">PROJECT FILES</div>
                <section class="subi-files-section" id="files-section">
                  <div class="subi-file-list-container">
                    <button class="subi-load-btn" id="load-files-btn" type="button">Load Files</button>
                    <div class="subi-loading" id="files-loading" style="display: none;">Loading files...</div>
                    <ul class="subi-file-list" id="file-list" style="display: none;"></ul>
                    <button class="subi-show-more-btn" id="show-more-btn" type="button" style="display: none;">Show More</button>
                  </div>
                </section>
                <section class="subi-preview-section" id="preview-section" style="display: none;">
                  <div class="subi-section-title">FILE PREVIEW</div>
                  <div class="subi-preview-header">
                    <span class="subi-preview-path" id="preview-path"></span>
                  </div>
                  <div class="subi-preview-content">
                    <pre class="subi-preview-code"><code id="preview-code"></code></pre>
                    <div class="subi-loading" id="preview-loading" style="display: none;">Loading preview...</div>
                  </div>
                </section>
              </div>
            </div>

            <!-- Project search (Stage 3B UI relocated, same IDs/logic) -->
            <div class="subi-settings-view subi-hidden" id="view-search">
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">SEARCH PROJECT</div>
                <section class="subi-search-section" id="search-section">
                  <div class="subi-search-input-row">
                    <input
                      type="text"
                      class="subi-search-input"
                      id="search-input"
                      placeholder="Search files and code..."
                      spellcheck="false"
                    />
                  </div>
                  <div class="subi-search-mode-row">
                    <button class="subi-mode-btn subi-active" id="search-mode-files" type="button" data-mode="files">Files</button>
                    <button class="subi-mode-btn" id="search-mode-content" type="button" data-mode="content">Content</button>
                  </div>
                  <div class="subi-search-action-row">
                    <button class="subi-search-btn" id="search-btn" type="button">Search</button>
                    <div class="subi-loading" id="search-loading" style="display: none;">Searching...</div>
                  </div>
                  <div class="subi-search-results-container" id="search-results-container" style="display: none;">
                    <ul class="subi-search-results" id="search-results"></ul>
                    <div class="subi-empty-state" id="search-no-results" style="display: none;">No results found.</div>
                    <div class="subi-error-state" id="search-error" style="display: none;"></div>
                  </div>
                </section>
                <div class="subi-settings-note">Open a result to preview it in Project files.</div>
              </div>
            </div>

            <!-- About -->
            <div class="subi-settings-view subi-hidden" id="view-about">
              <div class="subi-settings-group">
                <div class="subi-settings-group-title">SUBI</div>
                <div class="subi-onboarding-subtitle">Subi — software development assistant.</div>
                <div class="subi-settings-note">AI chat with your own provider keys. Project files and search stay local and are never sent to AI automatically (Stage 4B remains separate).</div>
                <section class="subi-hidden" id="recent-tasks-section">
                  <ul class="subi-task-list" id="task-list">
                    <li class="subi-empty-state">No recent tasks</li>
                  </ul>
                </section>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Sticky composer -->
    <footer class="subi-footer subi-hidden" id="chat-footer">
      <div class="subi-attach-strip subi-hidden" id="attachment-strip" aria-live="polite"></div>
      <div class="subi-input-row">
        <button
          class="subi-icon-btn subi-plus-btn"
          id="btn-add-context"
          type="button"
          aria-label="Add context"
          title="Add context"
          aria-haspopup="menu"
        >+</button>
        <div class="subi-input-wrapper">
          <textarea
            class="subi-input"
            id="chat-input"
            placeholder="Ask Subi anything..."
            rows="1"
            spellcheck="false"
          ></textarea>
        </div>
        <button
          class="subi-send-btn"
          id="send-btn"
          disabled
          type="button"
          aria-label="Send message"
          title="Send message"
        >↑</button>
      </div>
    <!-- Phase 10A: slash command popup -->
    <div class="subi-slash-popup subi-hidden" id="slash-popup" role="listbox" aria-label="Slash commands">
      <div class="subi-slash-popup-title">Commands</div>
      <div class="subi-slash-popup-list" id="slash-popup-list"></div>
    </div>
    <div class="subi-context-menu subi-hidden" id="context-menu" role="menu" aria-label="Add context">
      <div class="subi-context-title">Add Context</div>
      <button class="subi-context-item" id="btn-attach-file" type="button" role="menuitem">📄 Add Project File</button>
      <button class="subi-context-item" id="btn-attach-image" type="button" role="menuitem">🖼 Add Image</button>
    </div>
  </footer>
  </div>

  <script nonce="${this.nonce}" src="${markedUri}"></script>
  <script nonce="${this.nonce}" src="${purifyUri}"></script>
  <script nonce="${this.nonce}" src="${hljsUri}"></script>
  <script nonce="${this.nonce}" src="${katexJsUri}"></script>
  <script nonce="${this.nonce}" src="${katexAutoUri}"></script>
  <script nonce="${this.nonce}" src="${markdownUri}"></script>
  <script nonce="${this.nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
