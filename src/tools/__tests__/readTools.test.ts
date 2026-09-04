import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../ToolTypes';
import { isSecretFilePath } from '../files/SecretFileGuard';
import { createReadFileTool } from '../files/ReadFileTool';
import { createFindFilesTool } from '../files/FindFilesTool';
import { createSearchTextTool } from '../search/SearchTextTool';
import { createGetWorkspaceInfoTool } from '../workspace/GetWorkspaceInfoTool';

void test('isSecretFilePath blocks env, pem, key, service account json', () => {
  assert.equal(isSecretFilePath('.env'), true);
  assert.equal(isSecretFilePath('config/.env'), true);
  assert.equal(isSecretFilePath('.env.production'), true);
  assert.equal(isSecretFilePath('certs/server.pem'), true);
  assert.equal(isSecretFilePath('keys/private.key'), true);
  assert.equal(isSecretFilePath('secrets/firebase-adminsdk-abc.json'), true);
  assert.equal(isSecretFilePath('service_account.json'), true);
  assert.equal(isSecretFilePath('id_rsa'), true);
  assert.equal(isSecretFilePath('id_ed25519.pub'), true);
  assert.equal(isSecretFilePath('.aws/credentials'), true);
  assert.equal(isSecretFilePath('.ssh/id_rsa'), true);
});

void test('isSecretFilePath does not block normal source files', () => {
  assert.equal(isSecretFilePath('src/index.ts'), false);
  assert.equal(isSecretFilePath('README.md'), false);
  assert.equal(isSecretFilePath('package.json'), false);
  assert.equal(isSecretFilePath('src/components/Button.tsx'), false);
});

void test('read_file: secret file is rejected before any read', async () => {
  const fakeProjectFileService = {
    resolveRegisteredFileIdByPath: async () => 'fake-id',
    readFile: async () => ({ type: 'unknown' as const, message: 'should not be called' }),
  } as never;
  const tool = createReadFileTool(fakeProjectFileService);
  try {
    await tool.execute({ path: '.env' }, { agentMode: 'ask' });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'SECRET_FILE_BLOCKED');
  }
});

void test('read_file: missing file returns FILE_NOT_FOUND', async () => {
  const fakeProjectFileService = {
    resolveRegisteredFileIdByPath: async () => undefined,
    readFile: async () => ({ type: 'notFound' as const, message: 'no' }),
  } as never;
  const tool = createReadFileTool(fakeProjectFileService);
  try {
    await tool.execute({ path: 'missing.ts' }, { agentMode: 'ask' });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'FILE_NOT_FOUND');
  }
});

void test('read_file: binary file returns BINARY_FILE', async () => {
  const fakeProjectFileService = {
    resolveRegisteredFileIdByPath: async () => 'fake-id',
    readFile: async () => ({ type: 'binary' as const, message: 'binary' }),
  } as never;
  const tool = createReadFileTool(fakeProjectFileService);
  try {
    await tool.execute({ path: 'image.png' }, { agentMode: 'ask' });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'BINARY_FILE');
  }
});

void test('read_file: too-large file returns FILE_TOO_LARGE', async () => {
  const fakeProjectFileService = {
    resolveRegisteredFileIdByPath: async () => 'fake-id',
    readFile: async () => ({ type: 'tooLarge' as const, message: 'too big', size: 0 }),
  } as never;
  const tool = createReadFileTool(fakeProjectFileService);
  try {
    await tool.execute({ path: 'big.bin' }, { agentMode: 'ask' });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'FILE_TOO_LARGE');
  }
});

void test('read_file: success returns content with bounded preview', async () => {
  const fakeProjectFileService = {
    resolveRegisteredFileIdByPath: async () => 'fake-id',
    readFile: async () => ({
      fileId: 'fake-id',
      displayPath: 'src/hello.ts',
      content: 'export const x = 1;\n',
      size: 20,
    }),
  } as never;
  const tool = createReadFileTool(fakeProjectFileService);
  const payload = (await tool.execute({ path: 'src/hello.ts' }, { agentMode: 'ask' })) as { displayPath: string; content: string; truncated: boolean };
  assert.equal(payload.displayPath, 'src/hello.ts');
  assert.match(payload.content, /export const x/);
  assert.equal(payload.truncated, false);
});

void test('find_files: returns bounded count and items', async () => {
  const items = Array.from({ length: 250 }, (_, i) => ({
    id: `id-${i}`,
    workspaceFolderName: 'root',
    displayPath: `src/file-${i}.ts`,
  }));
  const fakeProjectFileService = {
    ensureFilesListed: async () => items,
  } as never;
  const tool = createFindFilesTool(fakeProjectFileService);
  const payload = (await tool.execute({}, { agentMode: 'ask' })) as { count: number; items: Array<unknown>; truncated: boolean };
  assert.equal(payload.count, 200); // bounded to MAX_RESULTS
  assert.equal(payload.truncated, true);
});

void test('find_files: filter narrows results case-insensitively', async () => {
  const items = [
    { id: '1', workspaceFolderName: 'root', displayPath: 'src/index.ts' },
    { id: '2', workspaceFolderName: 'root', displayPath: 'README.md' },
    { id: '3', workspaceFolderName: 'root', displayPath: 'src/utils.ts' },
  ];
  const fakeProjectFileService = {
    ensureFilesListed: async () => items,
  } as never;
  const tool = createFindFilesTool(fakeProjectFileService);
  const payload = (await tool.execute({ filter: 'README' }, { agentMode: 'ask' })) as { count: number; items: Array<{ displayPath: string }> };
  assert.equal(payload.count, 1);
  assert.equal(payload.items[0].displayPath, 'README.md');
});

void test('find_files: throws WORKSPACE_NOT_OPEN when no files', async () => {
  const fakeProjectFileService = {
    ensureFilesListed: async () => [],
  } as never;
  const tool = createFindFilesTool(fakeProjectFileService);
  try {
    await tool.execute({}, { agentMode: 'ask' });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'WORKSPACE_NOT_OPEN');
  }
});

void test('search_text: rejects short queries', async () => {
  const fakeProjectSearchService = {
    searchFiles: async () => [],
    searchContent: async () => [],
  } as never;
  const tool = createSearchTextTool(fakeProjectSearchService);
  try {
    await tool.execute({ query: 'a' }, { agentMode: 'ask' });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'TOOL_INVALID_ARGUMENTS');
  }
});

void test('search_text: rejects invalid mode', async () => {
  const fakeProjectSearchService = {
    searchFiles: async () => [],
    searchContent: async () => [],
  } as never;
  const tool = createSearchTextTool(fakeProjectSearchService);
  try {
    await tool.execute({ query: 'hello', mode: 'all' }, { agentMode: 'ask' });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'TOOL_INVALID_ARGUMENTS');
  }
});

void test('search_text: delegates to ProjectSearchService (content)', async () => {
  const fakeProjectSearchService = {
    searchFiles: async () => [{ fileId: 'a', displayPath: 'src/a.ts', line: 1, preview: 'x' }],
    searchContent: async () => [{ fileId: 'a', displayPath: 'src/a.ts', line: 3, preview: 'restoreSession' }],
  } as never;
  const tool = createSearchTextTool(fakeProjectSearchService);
  const payload = (await tool.execute({ query: 'restoreSession' }, { agentMode: 'ask' })) as { mode: string; count: number };
  assert.equal(payload.mode, 'content');
  assert.equal(payload.count, 1);
});

void test('search_text: delegates to ProjectSearchService (files)', async () => {
  const fakeProjectSearchService = {
    searchFiles: async () => [{ fileId: 'a', displayPath: 'restoreSession.ts' }],
    searchContent: async () => [],
  } as never;
  const tool = createSearchTextTool(fakeProjectSearchService);
  const payload = (await tool.execute({ query: 'restoreSession', mode: 'files' }, { agentMode: 'ask' })) as { mode: string; count: number };
  assert.equal(payload.mode, 'files');
  assert.equal(payload.count, 1);
});

void test('get_workspace_info: returns safe summary, no absolute path', async () => {
  const fakeWorkspaceService = {
    getCurrentWorkspaceInfo: async () => ({
      name: 'demo',
      path: '/Users/me/projects/demo',
      projectType: 'node',
      workspaceFolderCount: 1,
      isMultiRoot: false,
    }),
  } as never;
  const tool = createGetWorkspaceInfoTool(fakeWorkspaceService);
  const payload = (await tool.execute({}, { agentMode: 'ask' })) as { name: string; projectType: string; workspaceFolderCount: number; isMultiRoot: boolean };
  assert.equal(payload.name, 'demo');
  assert.equal(payload.projectType, 'node');
  assert.equal(payload.workspaceFolderCount, 1);
  assert.equal(payload.isMultiRoot, false);
  // The payload must not contain an absolute machine path.
  assert.ok(!('path' in payload));
});

void test('get_workspace_info: throws WORKSPACE_NOT_OPEN when no workspace', async () => {
  const fakeWorkspaceService = {
    getCurrentWorkspaceInfo: async () => null,
  } as never;
  const tool = createGetWorkspaceInfoTool(fakeWorkspaceService);
  try {
    await tool.execute({}, { agentMode: 'ask' });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.equal((e as ToolError).code, 'WORKSPACE_NOT_OPEN');
  }
});
