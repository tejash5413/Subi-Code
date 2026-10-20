// functions-subi/src/services/managedAgentTools.js
// Backend-owned managed-agent tool schemas (read_v1, legacy file_v1, file_v2).
//
// The backend owns tool definitions. The client must NOT submit arbitrary
// tool schemas.
//
// CRITICAL (Phase 13 stability hotfix): parameter names/required-ness MUST
// match the extension host ToolRegistry EXACTLY (host validation rejects
// unknown or missing arguments with TOOL_INVALID_ARGUMENTS, which counts
// toward consecutive-error limits). Canonical host contract:
//
//   get_workspace_info  {}
//   find_files          { filter? }
//   search_text         { query, mode? }
//   read_file           { path }
//
// Capability versioning: file_v1 is retained for deployed clients using the
// JSON-string patch envelope; file_v2 advertises the flat exact-edit contract.
// Phase 17: inspect_v1 serves ASK 8 / PLAN 9 (search + diagnostics + propose);
// verify_v1 serves BUILD 18 (inspect tools + patch tools + terminal tools +
// run_typecheck/run_lint/run_build/run_tests).
// The backend advertises schemas only; it never reads or modifies the workspace.
// BOUNDARY: pure data. No store, no secrets, no network, no Firestore.

const TERMINAL_TOOL_CAPABILITY_VERSION = 'terminal_v1';
const TERMINAL_TOOL_NAMES = ['run_command','terminal_status','cancel_command'];
// Phase 17: inspect_v1 (ASK 8 / PLAN 9) and verify_v1 (BUILD 18) schemas below.
const INSPECT_TOOL_CAPABILITY_VERSION = 'inspect_v1';
const VERIFY_TOOL_CAPABILITY_VERSION = 'verify_v1';
const INSPECT_TOOL_NAMES = ['list_directory','glob','grep','get_diagnostics'];
const VERIFY_TOOL_NAMES = ['run_typecheck','run_lint','run_build','run_tests'];
// Phase 18 additive bundle (old versions frozen): agent_v2 (includes structured Git; backend authorizes schemas only, host executes).
const AGENT_V2_CAPABILITY_VERSION = 'agent_v2';
const AGENT_V2_ASK_NAMES = ['get_workspace_info','list_directory','find_files','glob','search_text','grep','read_file','get_diagnostics','git_status','git_diff','git_log','lsp','todo_read','ask_user','load_skill','list_skills','web_fetch','web_search','batch_tools','external_read'];
const AGENT_V2_PLAN_NAMES = [...AGENT_V2_ASK_NAMES,'propose_patch','todo_write','delegate_task'];
const AGENT_V2_BUILD_NAMES = [...AGENT_V2_PLAN_NAMES,'apply_patch','undo_change','create_directory','git_stage','git_unstage','git_commit','run_command','run_shell_command','terminal_status','cancel_command','external_write','external_shell','run_typecheck','run_lint','run_build','run_tests'];
// Phase 19C additive bundle (agent_v2 and all older versions frozen):
// agent_v3 = agent_v2 + five read-only project-intelligence tools.
// Counts: ASK 25, PLAN 28, BUILD 44. The backend advertises schemas only;
// local execution stays on the VS Code extension host. No index upload.
const AGENT_V3_CAPABILITY_VERSION = 'agent_v3';
const AGENT_SKILLS_CAPABILITY_VERSION = 'agent_skills_v1';
const AGENT_V3_PROJECT_NAMES = ['project_overview','project_symbols','project_dependencies','project_impact','project_context'];
const AGENT_V3_ASK_NAMES = [...AGENT_V2_ASK_NAMES,...AGENT_V3_PROJECT_NAMES];
const AGENT_V3_PLAN_NAMES = [...AGENT_V2_PLAN_NAMES,...AGENT_V3_PROJECT_NAMES];
const AGENT_V3_BUILD_NAMES = [...AGENT_V2_BUILD_NAMES,...AGENT_V3_PROJECT_NAMES];
function terminalTools() {
  // Host: Subi/src/tools/terminal/buildTerminalTools.ts. timeoutMs is capped
  // host-side at 600000; executionMode admits exactly foreground|background.
  return [{ type: 'function', function: { name: 'run_command', description: 'Execute a developer command locally in the user’s VS Code workspace through SUBI’s host-controlled permission system. Structured executable and args only: for example executable "node" with args ["--version"]. Never replay commands. No shell command strings, terminal emulation, backend execution, raw shell, env, stdin, secrets, elevation or Git.', parameters: { type: 'object', additionalProperties: false, required: ['executable'], properties: {
    executable: {type:'string',maxLength:1000}, args:{type:'array',items:{type:'string',maxLength:4096},maxItems:128}, cwd:{type:'string',maxLength:1000}, timeoutMs:{type:'integer',minimum:1,maximum:600000}, executionMode:{type:'string',enum:['foreground','background'],maxLength:10}
  } } } }, ...['terminal_status','cancel_command'].map(name=>({type:'function',function:{name,description: name==='terminal_status'?'Read bounded status of an owned process.':'Cancel an owned process. No OS PID.',parameters:{type:'object',additionalProperties:false,required:['processId'],properties:{processId:{type:'string',maxLength:36,description:'Opaque host-issued processId returned by run_command.'}}}}}))];
}

// Phase 17 search/diagnostic tools. Provider-safe subset only (type,
// properties, required, description, enum, additionalProperties:false).
// The backend advertises schemas only; the host resolves and executes.
function inspectTools() {
  return [
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List a workspace directory (files and folders, one level by default). Prefer this for structural navigation over broad searches.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", maxLength: 1000, description: "Workspace-relative directory (default \".\")." },
            depth: { type: "integer", minimum: 1, maximum: 3, description: "Levels deep, 1 to 3 (default 1)." },
            maxEntries: { type: "integer", minimum: 1, maximum: 500, description: "Maximum entries, up to 500 (default 200)." },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "Find workspace files by glob pattern, e.g. src/**/*.ts. Prefer this for pattern discovery.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", maxLength: 200, description: "Glob pattern, e.g. **/*.ts." },
            basePath: { type: "string", maxLength: 1000, description: "Workspace-relative directory to search under." },
            maxResults: { type: "integer", minimum: 1, maximum: 500, description: "Maximum results, up to 500 (default 200)." },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search workspace text using bounded literal or regex matching.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", maxLength: 500, description: "Literal text or regex pattern." },
            path: { type: "string", maxLength: 1000, description: "Workspace-relative file or directory scope." },
            includeGlob: { type: "string", maxLength: 200, description: "Only search matching paths." },
            excludeGlob: { type: "string", maxLength: 200, description: "Skip matching paths." },
            regex: { type: "boolean", description: "Treat pattern as a regular expression (default false)." },
            caseSensitive: { type: "boolean", description: "Case-sensitive match (default false)." },
            contextLines: { type: "integer", minimum: 0, maximum: 5, description: "Context lines before/after (default 0)." },
            maxResults: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches, up to 200 (default 100)." },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_diagnostics",
        description: "Read the current VS Code diagnostic snapshot.",
        parameters: {
          type: "object",
          properties: {
            paths: { type: "array", items: { type: "string", maxLength: 1000 }, maxItems: 50, description: "Workspace-relative files or directories." },
            severities: { type: "array", items: { type: "string", enum: ["error", "warning", "information", "hint"] }, maxItems: 4, description: "Severity subset (default error)." },
            maxResults: { type: "integer", minimum: 1, maximum: 200, description: "Maximum diagnostics, up to 200 (default 100)." },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
  ];
}

// Phase 17 verification tools. The host resolves the configured project
// script and executes it through SUBI's permission-controlled local
// execution engine; the backend never runs commands.
function verifyTools() {
  const scripted = (name, description) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          projectPath: { type: "string", maxLength: 1000, description: "Workspace-relative project directory (default \".\")." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  });
  return [
    scripted("run_typecheck", "Run the configured project typecheck script through SUBI's permission-controlled local execution engine."),
    scripted("run_lint", "Run the configured project lint script (check-only) through SUBI's permission-controlled local execution engine."),
    scripted("run_build", "Run the configured project build script through SUBI's permission-controlled local execution engine."),
    {
      type: "function",
      function: {
        name: "run_tests",
        description: "Run the configured project test command through SUBI's permission-controlled local execution engine.",
        parameters: {
          type: "object",
          properties: {
            projectPath: { type: "string", maxLength: 1000, description: "Workspace-relative project directory (default \".\")." },
            scope: { type: "string", enum: ["workspace", "related", "file", "pattern"], description: "Test scope (only workspace is supported; default workspace)." },
            paths: { type: "array", items: { type: "string", maxLength: 1000 }, maxItems: 20, description: "Focused test paths (unsupported; omit)." },
            pattern: { type: "string", maxLength: 200, description: "Focused test pattern (unsupported; omit)." },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
  ];
}
// Phase 18 repair: agent_v2 verification tools. verify_v1 above stays FROZEN.
// The host (Subi/src/tools/verification/buildVerificationTools.ts) accepts
// scope/paths/pattern structurally but honestly refuses every focused run
// with VERIFICATION_NOT_CONFIGURED — workspace scope only in this release.
// agent_v2 therefore advertises ONLY the executable contract (projectPath +
// workspace scope) so the model can never be led into a guaranteed refusal.
// verify_v1 keeps its historical broad advertisement for backward compat.
function agentV2VerifyTools() {
  const scripted = (name, description) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          projectPath: { type: "string", maxLength: 1000, description: "Workspace-relative project directory (default \".\")." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  });
  return [
    scripted("run_typecheck", "Run the configured project typecheck script through SUBI's permission-controlled local execution engine."),
    scripted("run_lint", "Run the configured project lint script (check-only) through SUBI's permission-controlled local execution engine."),
    scripted("run_build", "Run the configured project build script through SUBI's permission-controlled local execution engine."),
    {
      type: "function",
      function: {
        name: "run_tests",
        description: "Run the configured project test suite for the whole workspace through SUBI's permission-controlled local execution engine. Focused scopes are not supported in this release.",
        parameters: {
          type: "object",
          properties: {
            projectPath: { type: "string", maxLength: 1000, description: "Workspace-relative project directory (default \".\")." },
            scope: { type: "string", enum: ["workspace"], description: "Test scope; only workspace is supported (default workspace)." },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
  ];
}
const TOOL_CAPABILITY_VERSION = "read_v1";const LEGACY_FILE_TOOL_CAPABILITY_VERSION = "file_v1";
const FILE_TOOL_CAPABILITY_VERSION = "file_v2";

const MANAGED_AGENT_TOOL_NAMES = [
  "get_workspace_info",
  "find_files",
  "search_text",
  "read_file",
];

const MANAGED_AGENT_FILE_TOOL_NAMES = [
  "propose_patch",
  "apply_patch",
  "undo_change",
];

function agentV2GitTools() {
  // Phase 18 repair: backend schemas mirror the host ToolRegistry contracts
  // EXACTLY (host is execution authority; host rejects unknown/missing args
  // with TOOL_INVALID_ARGUMENTS). Host source:
  //   Subi/src/tools/git/buildGit{Status,Diff,Log,Stage,Unstage,Commit}Tool.ts
  //   Subi/src/services/git/GitEngine.ts + GitTypes.ts (GIT_LIMITS)
  const rootId = { workspaceRootId: { type: 'string', maxLength: 200, description: 'Host workspace root name; omit for single-root workspaces.' } };
  return [
    { type: 'function', function: { name: 'git_status', description: 'Local Git status (host-executed, secret-masked).', parameters: { type: 'object', additionalProperties: false, required: [], properties: { ...rootId } } } },
    { type: 'function', function: { name: 'git_diff', description: 'Local Git diff (two-pass secret-safe).', parameters: { type: 'object', additionalProperties: false, required: ['scope'], properties: { scope: { type: 'string', enum: ['working', 'staged'], maxLength: 20, description: 'Diff scope: "working" (worktree vs index) or "staged" (index vs HEAD).' }, path: { type: 'string', maxLength: 1000, description: 'Optional workspace-relative file path to limit the diff to.' }, ...rootId } } } },
    { type: 'function', function: { name: 'git_log', description: 'Recent local commits.', parameters: { type: 'object', additionalProperties: false, required: [], properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many recent commits to return (1-50, default 20).' }, ...rootId } } } },
    { type: 'function', function: { name: 'git_stage', description: 'Stage explicitly selected files (approval).', parameters: { type: 'object', additionalProperties: false, required: ['paths'], properties: { paths: { type: 'array', items: { type: 'string', maxLength: 1000 }, minItems: 1, maxItems: 50, description: 'Explicit workspace-relative file paths to stage (1-50, no directories, globs, or revisions).' }, ...rootId } } } },
    { type: 'function', function: { name: 'git_unstage', description: 'Unstage explicitly selected files (approval).', parameters: { type: 'object', additionalProperties: false, required: ['paths'], properties: { paths: { type: 'array', items: { type: 'string', maxLength: 1000 }, minItems: 1, maxItems: 50, description: 'Explicit workspace-relative file paths to unstage (1-50, staged changes only).' }, ...rootId } } } },
    { type: 'function', function: { name: 'git_commit', description: 'One local commit from staged snapshot (approval, no push).', parameters: { type: 'object', additionalProperties: false, required: ['subject'], properties: { subject: { type: 'string', maxLength: 120, description: 'Commit subject: single plain-text line, 1-120 characters.' }, body: { type: 'string', maxLength: 2000, description: 'Optional commit body: plain text, at most 2000 characters.' }, ...rootId } } } },
  ];
}

function agentV2Tools(agentMode) {
  // Host sources: Subi/src/tools/terminal/buildShellTool.ts (shell enum is
  // the pinned interpreter set; command bounded 8000), edit/buildMkdirTool.ts,
  // lsp/buildLspTool.ts (7 actions; line/character integers),
  // todo/buildTodoTools.ts, task/buildTaskTool.ts, question/buildQuestionTool.ts,
  // skills/buildSkillTool.ts, web/buildWebTools.ts (url 2000, query 2-500),
  // batch/buildBatchTool.ts (calls JSON, max 8), external/buildExternalTools.ts.
  const shell = { type: 'function', function: { name: 'run_shell_command', description: 'Run a controlled shell command (powershell, pwsh, cmd, bash, sh, zsh) with pinned interpreter and approval. Git via shell is blocked.', parameters: { type: 'object', additionalProperties: false, required: ['shell','command'], properties: { shell: { type: 'string', enum: ['powershell','pwsh','cmd','bash','sh','zsh'], maxLength: 20 }, command: { type: 'string', maxLength: 8000 }, cwd: { type: 'string', maxLength: 1000 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 } } } } };
  const mkdir = { type: 'function', function: { name: 'create_directory', description: 'Create a workspace directory through the file engine.', parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', maxLength: 1000 } } } } };
  const lsp = { type: 'function', function: { name: 'lsp', description: 'Read-only code intelligence: symbols, definition, references, implementation, hover, call hierarchy.', parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['document_symbols','workspace_symbols','definition','references','implementation','hover','call_hierarchy'], maxLength: 32 }, path: { type: 'string', maxLength: 1000 }, query: { type: 'string', maxLength: 500 }, line: { type: 'integer' }, character: { type: 'integer' } } } } };
  const todoRead = { type: 'function', function: { name: 'todo_read', description: 'Read session todos.', parameters: { type: 'object', additionalProperties: false, properties: {} } } };
  const todoWrite = { type: 'function', function: { name: 'todo_write', description: 'Replace session todo list (JSON string).', parameters: { type: 'object', additionalProperties: false, required: ['todos'], properties: { todos: { type: 'string', maxLength: 20000 } } } } };
  const task = { type: 'function', function: { name: 'delegate_task', description: 'Delegate a bounded read-heavy subtask.', parameters: { type: 'object', additionalProperties: false, required: ['task'], properties: { task: { type: 'string', maxLength: 2000 }, scope: { type: 'string', maxLength: 2000 } } } } };
  const question = { type: 'function', function: { name: 'ask_user', description: 'Ask a structured user question (never secrets).', parameters: { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'string', maxLength: 8000 } } } } };
  const loadSkill = { type: 'function', function: { name: 'load_skill', description: 'Load a SUBI skill (instructions only).', parameters: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', maxLength: 100 } } } } };
  const listSkills = { type: 'function', function: { name: 'list_skills', description: 'List SUBI skills.', parameters: { type: 'object', additionalProperties: false, properties: {} } } };
  const fetch = { type: 'function', function: { name: 'web_fetch', description: 'Fetch a public docs URL (bounded, SSRF-safe).', parameters: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', maxLength: 2000 } } } } };
  const search = { type: 'function', function: { name: 'web_search', description: 'Web search for docs/recovery (bounded).', parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', maxLength: 500 } } } } };
  const batch = { type: 'function', function: { name: 'batch_tools', description: 'Batch up to 8 independent read calls.', parameters: { type: 'object', additionalProperties: false, required: ['calls'], properties: { calls: { type: 'string', maxLength: 32000 } } } } };
  const ext = { type: 'function', function: { name: 'external_read', description: 'Read outside workspace with approval (narrow).', parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', maxLength: 2000 } } } } };
  const extWrite = { type: 'function', function: { name: 'external_write', description: 'Write a bounded file outside workspace with approval (narrow).', parameters: { type: 'object', additionalProperties: false, required: ['path','content'], properties: { path: { type: 'string', maxLength: 2000 }, content: { type: 'string', maxLength: 262144 } } } } };
  const extShell = { type: 'function', function: { name: 'external_shell', description: 'Approve an outside-workspace working directory (commands still need own approval).', parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', maxLength: 2000 } } } } };
  const byName = { run_shell_command: shell, create_directory: mkdir, lsp, todo_read: todoRead, todo_write: todoWrite, delegate_task: task, ask_user: question, load_skill: loadSkill, list_skills: listSkills, web_fetch: fetch, web_search: search, batch_tools: batch, external_read: ext, external_write: extWrite, external_shell: extShell };
  for (const g of agentV2GitTools()) byName[g.function.name] = g;
  const names = agentMode === 'ask' ? AGENT_V2_ASK_NAMES : agentMode === 'plan' ? AGENT_V2_PLAN_NAMES : AGENT_V2_BUILD_NAMES;
  // Core schemas (read/inspect/patch/terminal/verify) come from the frozen builders; extras appended here.
  return { byName, names };
}

// Phase 19C: read-only project-intelligence tools. Host sources:
// Subi/src/tools/project/buildProjectTools.ts (closed schemas, bounded
// arrays/strings/integers, workspace containment, secret guards). Mirror
// those contracts EXACTLY: required fields, enums, string lengths, array
// counts, integer ranges, additionalProperties:false.
function agentV3ProjectTools() {
  const overview = { type: 'function', function: { name: 'project_overview', description: 'Bounded overview of local project intelligence: types, roots, entry points, modules, index state. No source dump.', parameters: { type: 'object', additionalProperties: false, required: [], properties: { workspaceRootId: { type: 'string', maxLength: 64, description: 'Opaque root id to scope to one root.' }, projectId: { type: 'string', maxLength: 500, description: 'Project anchor to scope to one project.' } } } } };
  const symbols = { type: 'function', function: { name: 'project_symbols', description: 'Query indexed structural symbols by name substring or file, with LSP-vs-lexical provenance. Complements live lsp.', parameters: { type: 'object', additionalProperties: false, required: [], properties: { query: { type: 'string', maxLength: 200, description: 'Symbol name substring.' }, file: { type: 'string', maxLength: 1000, description: 'Workspace-relative file.' }, workspaceRootId: { type: 'string', maxLength: 64 }, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results, up to 100 (default 50).' } } } } };
  const deps = { type: 'function', function: { name: 'project_dependencies', description: 'Query indexed file/module dependency edges, optionally transitive (bounded). Read only.', parameters: { type: 'object', additionalProperties: false, required: [], properties: { file: { type: 'string', maxLength: 1000, description: 'Workspace-relative file.' }, moduleId: { type: 'string', maxLength: 200, description: 'Architecture module id.' }, direction: { type: 'string', enum: ['outgoing', 'incoming', 'both'], maxLength: 16, description: 'Edge direction (default both).' }, transitive: { type: 'boolean', description: 'Bounded transitive walk (default false).' }, depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Transitive depth (default 3).' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max edges, up to 200 (default 100).' }, workspaceRootId: { type: 'string', maxLength: 64 } } } } };
  const impact = { type: 'function', function: { name: 'project_impact', description: 'Bounded change-impact analysis: dependents, tests, configs, entry points, verification hints. Read only; never mutates.', parameters: { type: 'object', additionalProperties: false, required: ['files'], properties: { files: { type: 'array', items: { type: 'string', maxLength: 1000 }, minItems: 1, maxItems: 20, description: 'Workspace-relative files to analyze (1-20).' }, workspaceRootId: { type: 'string', maxLength: 64 }, includeVerification: { type: 'boolean', description: 'Include verification recommendations (default true).' } } } } };
  const context = { type: 'function', function: { name: 'project_context', description: 'Task-oriented bounded retrieval over local project intelligence with reasons and optional capped excerpts. Never dumps the workspace.', parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', maxLength: 2000, description: 'Task query, 2+ characters (transient).' }, workspaceRootId: { type: 'string', maxLength: 64 }, maxFiles: { type: 'integer', minimum: 1, maximum: 60, description: 'Max files (default 20).' }, includeContent: { type: 'boolean', description: 'Include bounded redacted excerpts (default false).' } } } } };
  return { project_overview: overview, project_symbols: symbols, project_dependencies: deps, project_impact: impact, project_context: context };
}

const AGENT_JOBS_CAPABILITY_VERSION = 'agent_jobs_v1';
const COORDINATION_BASES = Object.freeze({ agent_jobs_coordination_v1: 'agent_jobs_v1', agent_mcp_coordination_v1: 'agent_mcp_v1', agent_pty_coordination_v1: 'agent_pty_v1' });
const COORDINATION_TOOL_NAMES = ['coordination_submit', 'coordination_get', 'coordination_review', 'coordination_retry'];
function isCoordinationCapability(version) { return Object.prototype.hasOwnProperty.call(COORDINATION_BASES, version); }
function coordinationBase(version) { return COORDINATION_BASES[version]; }
const JOB_TOOL_NAMES = ['job_list', 'job_get', 'job_wait', 'job_update', 'job_resume', 'job_retry', 'job_cancel', 'job_promote'];
function isAgentJobsCapability(version) { return version === AGENT_JOBS_CAPABILITY_VERSION || version === 'agent_mcp_v1' || version === 'agent_pty_v1' || isCoordinationCapability(version); }
function managedJobTools(agentMode) {
  if (agentMode === 'ask') return [];
  return JOB_TOOL_NAMES.filter(name => name !== 'job_promote' || agentMode === 'build').map(name => {
    const properties = name === 'job_list' ? {} : { jobId: { type: 'string', minLength: 1, maxLength: 160 } };
    const required = name === 'job_list' ? [] : ['jobId'];
    if (name === 'job_wait') properties.timeoutMs = { type: 'integer', minimum: 0, maximum: 60000 };
    if (['job_update', 'job_resume', 'job_retry', 'job_cancel', 'job_promote'].includes(name)) { properties.expectedRevision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }; required.push('expectedRevision'); }
    if (name === 'job_update') { properties.text = { type: 'string', minLength: 1, maxLength: 2000 }; required.push('text'); }
    return { type: 'function', function: { name, description: 'Operate on an owned durable job with current host authority and revision.', parameters: { type: 'object', additionalProperties: false, required, properties } } };
  });
}
function buildManagedAgentTools(capabilityVersion = TOOL_CAPABILITY_VERSION, agentMode = "ask", agentSkillsContext) {
  if (isCoordinationCapability(capabilityVersion)) {
    const base = buildManagedAgentTools(coordinationBase(capabilityVersion), agentMode, agentSkillsContext);
    const additions = require('./managedCoordinationTools.contract.json');
    const question = additions.find(tool => tool.function.name === 'ask_user');
    const tools = base.map(tool => tool.function.name === 'ask_user' ? structuredClone(question) : tool);
    const allowed = agentSkillsContext?.agent?.allowedTools;
    if (agentMode !== 'ask') tools.push(...structuredClone(additions.filter(tool => COORDINATION_TOOL_NAMES.includes(tool.function.name) && (allowed === undefined || allowed.includes(tool.function.name)))));
    return tools;
  }
  if (isPtyCapability(capabilityVersion)) {
    const base = buildManagedAgentTools(capabilityVersion === 'agent_pty_v1' ? 'agent_mcp_v1' : 'agent_mcp_skills_v1', agentMode, agentSkillsContext);
    const allowed = agentSkillsContext?.agent?.allowedTools;
    const pty = agentMode === 'build' ? require('./managedPtyTools.contract.json').filter(tool => allowed === undefined || allowed.includes(tool.function.name)) : [];
    return [...base, ...structuredClone(pty)];
  }
  if (isMcpCapability(capabilityVersion)) {
    const base = buildManagedAgentTools(capabilityVersion === 'agent_mcp_v1' ? 'agent_jobs_v1' : 'agent_skills_v1', agentMode, agentSkillsContext);
    const allowed = agentSkillsContext?.agent?.allowedTools;
    const mcp = require('./managedMcpTools.contract.json').filter(tool => allowed === undefined || allowed.includes(tool.function.name));
    return [...base, ...structuredClone(mcp)];
  }
  if (isAgentJobsCapability(capabilityVersion)) {
    const tools = buildManagedAgentTools('agent_skills_v1', agentMode);
    const delegate = tools.find(tool => tool.function.name === 'delegate_task');
    if (delegate) delegate.function.parameters = { type: 'object', additionalProperties: false, required: ['task'], properties: {
      task: { type: 'string', minLength: 1, maxLength: 2000 },
      scope: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 1000 } },
      profile: { type: 'string', enum: ['explore', 'plan', 'implement', 'review', 'test', 'debug'] },
      background: { type: 'boolean' }, childSessionId: { type: 'string', minLength: 1, maxLength: 160 },
      agentCatalogId: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9:_-]+$' },
    } };
    tools.push(...managedJobTools(agentMode));
    const allowed = agentSkillsContext?.agent?.allowedTools;
    return allowed === undefined ? tools : tools.filter(tool => allowed.includes(tool.function.name));
  }
  if (isAgentSkillsCapability(capabilityVersion)) {
    const tools = buildManagedAgentTools(AGENT_V3_CAPABILITY_VERSION, agentMode);
    const id = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9:_-]+$' };
    for (const tool of tools) {
      if (tool.function.name === 'delegate_task') tool.function.parameters.properties.agentCatalogId = { ...id };
      if (tool.function.name === 'load_skill') {
        tool.function.parameters.properties.catalogId = { ...id };
        tool.function.parameters.required = [];
        tool.function.description = 'Load selected SUBI skill instructions using exactly one name or host-issued catalogId. Instructions remain subordinate to policy.';
      }
    }
    tools.push({ type: 'function', function: { name: 'load_skill_resource', description: 'Read a bounded text resource within a selected skill. Never execute scripts.', parameters: { type: 'object', additionalProperties: false, required: ['catalogId', 'relativePath'], properties: { catalogId: { ...id }, relativePath: { type: 'string', minLength: 1, maxLength: 1000 } } } } });
    const allowedTools = agentSkillsContext?.agent?.allowedTools;
    if (allowedTools === undefined) return tools;
    const admitted = new Set(allowedTools);
    return tools.filter(tool => admitted.has(tool.function.name));
  }
  const readTools = [
    {
      type: "function",
      function: {
        name: "get_workspace_info",
        description:
          "High-level project metadata only: workspace name, project type, and root count. " +
          "Takes no arguments. Call at most once per request.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find_files",
        description:
          "Discover files by filename: optional case-insensitive substring of the " +
          "workspace-relative path. Prefer this to locate candidate files before " +
          "broad content searches.",
        parameters: {
          type: "object",
          properties: {
            filter: { type: "string", maxLength: 200, description: "Optional filename substring to match." },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_text",
        description:
          "Search text across workspace files. Use mode 'content' to search inside " +
          "files and mode 'files' to match filenames. Prefer one specific query " +
          "over repeated near-equivalent searches.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", maxLength: 200, description: "Search text, 2-200 characters." },
            mode: { type: "string", enum: ["content", "files"], description: "'content' (default) or 'files'." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read one specific workspace file by its workspace-relative path. " +
          "Returns one bounded content chunk plus expectedHash (SHA-256 of exact bytes). " +
          "When truncated is true, request the same path once with offset=nextOffset to continue; never reread the same range. " +
          "Copy expectedHash into modify/delete/move operations. Prefer reading already-located files over further searching.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", maxLength: 1000, description: "Workspace-relative path of the file to read." },
            offset: { type: "integer", minimum: 0, description: "Zero-based character offset; use nextOffset from the prior chunk." },
            limit: { type: "integer", minimum: 1, maximum: 12000, description: "Maximum characters to return; defaults to 12000. Use a smaller explicit limit for a narrow inspection." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
  ];
  if (!isFileToolCapability(capabilityVersion) && !isInspectCapability(capabilityVersion) && !isVerifyCapability(capabilityVersion)) return readTools;

  const propose = capabilityVersion === LEGACY_FILE_TOOL_CAPABILITY_VERSION ? {
    type: "function",
    function: {
      name: "propose_patch",
      description:
        "Prepare a reviewable patch without writing. Pass exactly one operationsJson string containing the bounded JSON operation array. Returns a host-issued patchId; Build mode must then call apply_patch.",
      parameters: {
        type: "object",
        properties: {
          operationsJson: {
            type: "string",
            maxLength: 262144,
            description: "JSON-encoded operations array for the host patch engine.",
          },
        },
        required: ["operationsJson"],
        additionalProperties: false,
      },
    },
  } : {
    type: "function",
    function: {
      name: "propose_patch",
      description:
        "Prepare a reviewable patch without writing. For normal edits use operation=modify, path (or filePath), oldString, newString, and optional replaceAll/expectedHash. Create/delete/move use the flat fields below. Returns a host-issued patchId; Build mode must then call apply_patch.",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", maxLength: 16, description: "modify, create, delete, or move; optional when fields are unambiguous." },
          op: { type: "string", maxLength: 16, description: "Alias for operation." },
          path: { type: "string", maxLength: 1000, description: "Workspace-relative target path for modify, create, or delete." },
          filePath: { type: "string", maxLength: 1000, description: "Alias for path, matching the common edit-tool contract." },
          oldString: { type: "string", maxLength: 49152, description: "For modify: exact existing text to replace, including whitespace." },
          newString: { type: "string", maxLength: 49152, description: "For modify: replacement text; may be empty." },
          replaceAll: { type: "boolean", description: "For modify: replace every exact occurrence (default false)." },
          content: { type: "string", maxLength: 262144, description: "For create only: complete new-file content." },
          from: { type: "string", maxLength: 1000, description: "For move: workspace-relative source path." },
          to: { type: "string", maxLength: 1000, description: "For move: workspace-relative destination path." },
          expectedHash: { type: "string", maxLength: 128, description: "SHA-256 from read_file; required for delete/move." },
          eol: { type: "string", maxLength: 4, description: "For create: lf or crlf." },
          operationsJson: {
            type: "string",
            maxLength: 262144,
            description: "Legacy/advanced JSON-encoded operations array. Do not combine with flat fields.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  };
  if (capabilityVersion !== INSPECT_TOOL_CAPABILITY_VERSION && capabilityVersion !== VERIFY_TOOL_CAPABILITY_VERSION && capabilityVersion !== AGENT_V2_CAPABILITY_VERSION && capabilityVersion !== AGENT_V3_CAPABILITY_VERSION && agentMode !== "build") return [...readTools, propose];
  const applyPatch = {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a previously proposed patch by patchId. The host requires user approval.",
      parameters: {
        type: "object",
        properties: {
          patchId: { type: "string", maxLength: 200, description: "Host-issued patch id from propose_patch." },
        },
        required: ["patchId"],
        additionalProperties: false,
      },
    },
  };
  const undoChange = {
    type: "function",
    function: {
      name: "undo_change",
      description: "Revert a recorded SUBI change by changeId. The host always requires user approval.",
      parameters: {
        type: "object",
        properties: {
          changeId: { type: "string", maxLength: 200, description: "Host-issued change id from apply_patch." },
        },
        required: ["changeId"],
        additionalProperties: false,
      },
    },
  };
  if (capabilityVersion === INSPECT_TOOL_CAPABILITY_VERSION) {
    // Validator rejects inspect×build first; fail closed here as well.
    if (agentMode === "build") {
      const err = new Error("inspect capability forbids build");
      err.code = "INTERNAL";
      throw err;
    }
    const byName = {};
    for (const tool of [...readTools, ...inspectTools()]) byName[tool.function.name] = tool;
    const base = [
      "get_workspace_info",
      "list_directory",
      "find_files",
      "glob",
      "search_text",
      "grep",
      "read_file",
      "get_diagnostics",
    ].map((name) => byName[name]);
    return agentMode === "plan" ? [...base, propose] : base;
  }
  if (capabilityVersion === VERIFY_TOOL_CAPABILITY_VERSION) {
    // Validator rejects verify×ask/plan first; fail closed here as well.
    if (agentMode !== "build") {
      const err = new Error("verify capability requires build");
      err.code = "INTERNAL";
      throw err;
    }
    const byName = {};
    for (const tool of [...readTools, ...inspectTools()]) byName[tool.function.name] = tool;
    return [
      "get_workspace_info",
      "list_directory",
      "find_files",
      "glob",
      "search_text",
      "grep",
      "read_file",
      "get_diagnostics",
    ].map((name) => byName[name]).concat([
      propose,
      applyPatch,
      undoChange,
      ...terminalTools(),
      ...verifyTools(),
    ]);
  }
  if (capabilityVersion === AGENT_V2_CAPABILITY_VERSION) {
    const extra = agentV2Tools(agentMode);
    const byName = {};
    for (const tool of [...readTools, ...inspectTools(), ...terminalTools(), ...agentV2VerifyTools()]) byName[tool.function.name] = tool;
    byName['propose_patch'] = propose;
    byName['apply_patch'] = applyPatch;
    byName['undo_change'] = undoChange;
    Object.assign(byName, extra.byName);
    return extra.names.map((n) => byName[n]).filter(Boolean);
  }
  if (capabilityVersion === AGENT_V3_CAPABILITY_VERSION) {
    // agent_v3 = agent_v2 assembly + the five project tools. Shared tools
    // resolve through the identical frozen builders above; only the project
    // schemas are new (agentV3ProjectTools).
    const extra = agentV2Tools(agentMode);
    const byName = {};
    for (const tool of [...readTools, ...inspectTools(), ...terminalTools(), ...agentV2VerifyTools()]) byName[tool.function.name] = tool;
    byName['propose_patch'] = propose;
    byName['apply_patch'] = applyPatch;
    byName['undo_change'] = undoChange;
    Object.assign(byName, extra.byName, agentV3ProjectTools());
    const names = agentMode === 'ask' ? AGENT_V3_ASK_NAMES : agentMode === 'plan' ? AGENT_V3_PLAN_NAMES : AGENT_V3_BUILD_NAMES;
    return names.map((n) => byName[n]).filter(Boolean);
  }
  return [
    ...(capabilityVersion === TERMINAL_TOOL_CAPABILITY_VERSION ? terminalTools() : []),
    ...readTools,
    propose,
    applyPatch,
    undoChange,
  ];
}

function isManagedAgentTool(name, capabilityVersion = TOOL_CAPABILITY_VERSION) {
  if (isCoordinationCapability(capabilityVersion)) return COORDINATION_TOOL_NAMES.includes(name) || isManagedAgentTool(name, coordinationBase(capabilityVersion));
  if (isPtyCapability(capabilityVersion)) return require('./managedPtyTools.contract.json').some(tool => tool.function.name === name) || isManagedAgentTool(name, capabilityVersion === 'agent_pty_v1' ? 'agent_mcp_v1' : 'agent_mcp_skills_v1');
  if (isMcpCapability(capabilityVersion)) return require('./managedMcpTools.contract.json').some(tool => tool.function.name === name) || isManagedAgentTool(name, capabilityVersion === 'agent_mcp_v1' ? 'agent_jobs_v1' : 'agent_skills_v1');
  if (isAgentJobsCapability(capabilityVersion)) return JOB_TOOL_NAMES.includes(name) || isManagedAgentTool(name, 'agent_skills_v1');
  if (isAgentSkillsCapability(capabilityVersion)) return name === 'load_skill_resource' || isManagedAgentTool(name, AGENT_V3_CAPABILITY_VERSION);
  if (MANAGED_AGENT_TOOL_NAMES.includes(name)) return true;
  if (capabilityVersion === TERMINAL_TOOL_CAPABILITY_VERSION && TERMINAL_TOOL_NAMES.includes(name)) return true;
  if (isFileToolCapability(capabilityVersion) && MANAGED_AGENT_FILE_TOOL_NAMES.includes(name)) return true;
  if (capabilityVersion === INSPECT_TOOL_CAPABILITY_VERSION &&
    (INSPECT_TOOL_NAMES.includes(name) || name === "propose_patch")) return true;
  if (capabilityVersion === VERIFY_TOOL_CAPABILITY_VERSION &&
    (INSPECT_TOOL_NAMES.includes(name) || TERMINAL_TOOL_NAMES.includes(name) || VERIFY_TOOL_NAMES.includes(name))) return true;
  if (capabilityVersion === AGENT_V2_CAPABILITY_VERSION &&
    (AGENT_V2_BUILD_NAMES.includes(name))) return true;
  if (capabilityVersion === AGENT_V3_CAPABILITY_VERSION &&
    (AGENT_V3_BUILD_NAMES.includes(name))) return true;
  return false;
}

function isFileToolCapability(capabilityVersion) {
  return capabilityVersion === LEGACY_FILE_TOOL_CAPABILITY_VERSION ||
    capabilityVersion === FILE_TOOL_CAPABILITY_VERSION || capabilityVersion === TERMINAL_TOOL_CAPABILITY_VERSION ||
    capabilityVersion === VERIFY_TOOL_CAPABILITY_VERSION || capabilityVersion === AGENT_V2_CAPABILITY_VERSION ||
    capabilityVersion === AGENT_V3_CAPABILITY_VERSION || isAgentSkillsCapability(capabilityVersion) || isAgentJobsCapability(capabilityVersion);
}

function isInspectCapability(capabilityVersion) {
  return capabilityVersion === INSPECT_TOOL_CAPABILITY_VERSION;
}

function isVerifyCapability(capabilityVersion) {
  return capabilityVersion === VERIFY_TOOL_CAPABILITY_VERSION;
}

function isAgentV2Capability(capabilityVersion) {
  return capabilityVersion === AGENT_V2_CAPABILITY_VERSION;
}

function isAgentV3Capability(capabilityVersion) {
  return capabilityVersion === AGENT_V3_CAPABILITY_VERSION;
}

function isAgentSkillsCapability(version) { return version === AGENT_SKILLS_CAPABILITY_VERSION || version === 'agent_mcp_skills_v1' || version === 'agent_pty_skills_v1'; }

function isPtyCapability(version) { return version === 'agent_pty_v1' || version === 'agent_pty_skills_v1' || version === 'agent_pty_coordination_v1'; }
function isMcpCapability(version) { return version === 'agent_mcp_v1' || version === 'agent_mcp_skills_v1' || version === 'agent_mcp_coordination_v1' || isPtyCapability(version); }

module.exports = {
  COORDINATION_TOOL_NAMES, isCoordinationCapability, coordinationBase,
  isMcpCapability, isPtyCapability,
  AGENT_JOBS_CAPABILITY_VERSION, JOB_TOOL_NAMES, isAgentJobsCapability,
  AGENT_SKILLS_CAPABILITY_VERSION, isAgentSkillsCapability,
  TERMINAL_TOOL_CAPABILITY_VERSION, TERMINAL_TOOL_NAMES,
  INSPECT_TOOL_CAPABILITY_VERSION, VERIFY_TOOL_CAPABILITY_VERSION,
  INSPECT_TOOL_NAMES, VERIFY_TOOL_NAMES,
  AGENT_V2_CAPABILITY_VERSION, AGENT_V2_ASK_NAMES, AGENT_V2_PLAN_NAMES, AGENT_V2_BUILD_NAMES,
  AGENT_V3_CAPABILITY_VERSION, AGENT_V3_PROJECT_NAMES, AGENT_V3_ASK_NAMES, AGENT_V3_PLAN_NAMES, AGENT_V3_BUILD_NAMES,
  TOOL_CAPABILITY_VERSION,
  LEGACY_FILE_TOOL_CAPABILITY_VERSION,
  FILE_TOOL_CAPABILITY_VERSION,
  MANAGED_AGENT_TOOL_NAMES,
  MANAGED_AGENT_FILE_TOOL_NAMES,
  buildManagedAgentTools,
  isFileToolCapability,
  isInspectCapability,
  isVerifyCapability,
  isAgentV2Capability,
  isAgentV3Capability,
  isManagedAgentTool,
};
