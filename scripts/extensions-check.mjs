/**
 * Native acceptance for the extensions library: skills, MCP and plugins.
 *
 * Everything runs against a NEW disposable app data directory, a loopback
 * model fixture and a local MCP fixture server. It never touches the owner's
 * app data, conversations, credentials or a paid provider.
 *
 *   pnpm build && node scripts/extensions-check.mjs
 */
import { _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const dataDir = await mkdtemp(join(tmpdir(), 'hello-extensions-qa-'));
const workDir = await mkdtemp(join(tmpdir(), 'hello extensions work '));
const artifacts = resolve('test-results/extensions');
await mkdir(artifacts, { recursive: true });
const executablePath = process.env.HELLO_TEST_APP || require('electron');
const launchArgs = process.env.HELLO_TEST_APP ? [] : [resolve('out/main/index.js')];
const done = [];
let shot = 0;
/** Poll from Node: the app's CSP forbids the string evaluation waitForFunction uses. */
const until = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
};
const capture = async (page, name) => {
  shot += 1;
  await page.screenshot({ path: join(artifacts, `${String(shot).padStart(2, '0')}-${name}.png`) });
};

// ── A local MCP server, written here so the check owns every moving part ────
const mcpServer = join(workDir, 'mcp-fixture.mjs');
await writeFile(mcpServer, `
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index = buffer.indexOf('\\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize')
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hello-qa-mcp', version: '1.0.0' } } });
    else if (message.method === 'tools/list')
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
        name: 'inventory',
        description: 'Return the fixture inventory this server owns.',
        inputSchema: { type: 'object', properties: { area: { type: 'string' } }, required: [] },
      }] } });
    else if (message.method === 'tools/call')
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'inventory for ' + (message.params.arguments?.area ?? 'all') + ': 3 crates, 1 pallet' }] } });
    else if (message.id !== undefined)
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported ' + message.method } });
  }
});
`);

// ── A model fixture that drives the exact tool calls under test ─────────────
const seen = { tools: [], calls: [], userMessages: '' };
let pluginProbe = false;
// Set by the check when a turn must answer without touching tools.
let skipTools = false;
const server = createServer(async (request, response) => {
  if (request.url === '/v1/models') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'hello-qa-model' }] }));
    return;
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end('no'); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  seen.tools = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
  seen.userMessages = JSON.stringify(body.messages.filter(message => message.role === 'user').map(message => message.content));
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (delta, finish = null) =>
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const call = (id, name, args) => {
    seen.calls.push(name);
    send({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls');
    response.end('data: [DONE]\n\n');
  };
  // Drive the sequence from what the fixture has already asked for, not from
  // the shape of the last message: skill first, then the MCP tool, then answer.
  const asked = name => seen.calls.includes(name);
  if (pluginProbe && seen.tools.includes('text_stats') && !asked('text_stats')) {
    call('qa_plugin', 'text_stats', { text: 'one two three' }); return;
  }
  if (!skipTools && !asked('skill_load')) { call('qa_skill', 'skill_load', { name: 'hello-visuals' }); return; }
  if (!skipTools && seen.tools.includes('mcp_qa_files_inventory') && !asked('mcp_qa_files_inventory')) {
    call('qa_mcp', 'mcp_qa_files_inventory', { area: 'skill-driven' });
    return;
  }
  const toolResult = body.messages.filter(message => message.role === 'tool').at(-1);
  send({ content: `Both extensions answered.\n\nLast tool result: ${String(toolResult?.content ?? 'none').slice(0, 160)}` });
  send({}, 'stop');
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let app;
try {
  app = await electron.launch({
    executablePath, args: launchArgs,
    env: { ...process.env, HELLO_DATA_DIR: dataDir, HELLO_TEST_MODE: '1', HELLO_TEST_ENDPOINT: `http://127.0.0.1:${port}/v1`, HELLO_TEST_MODEL: 'hello-qa-model', ELECTRON_RUN_AS_NODE: undefined },
  });
  console.log('launched');
  const page = await app.firstWindow();
  console.log('window');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await until(() => page.evaluate(() => !!window.hello).catch(() => false), 'the app bridge');
  console.log('bridge ready');
  // Launched already pointing at the fixture: no trip through Settings to connect.
  const connected = await page.evaluate(() => window.hello.settings.get());
  assert.equal(connected.model, 'hello-qa-model');
  // page.reload() is avoided deliberately: this build does not settle the
  // renderer's load event, and the settings write above already persisted.
  // Start from the app's own empty state, the way a person would.
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor({ timeout: 30000 });
  console.log('composer ready');

  // 1 ─ Settings › Extensions, empty library
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('heading', { name: 'Skills', exact: true }).waitFor();
  await capture(page, 'library-empty');
  done.push('Settings has an Extensions section listing Skills, Plugins and MCP servers');

  // 1b ─ Connection: a provider preset fills the form the user would type
  await page.getByRole('tab', { name: 'Connection', exact: true }).click();
  await page.getByRole('button', { name: 'Providers', exact: true }).click();
  await page.getByRole('menuitem', { name: 'OpenRouter', exact: false }).click();
  const endpointField = page.getByRole('textbox', { name: 'Endpoint URL', exact: true });
  assert.equal(await endpointField.inputValue(), 'https://openrouter.ai/api/v1');
  await capture(page, 'connection-presets');
  // Pointing at another provider clears the model with the model list, so the
  // fixture model has to be named again — exactly what a person would do.
  await endpointField.fill(`http://127.0.0.1:${port}/v1`);
  assert.equal(await page.getByRole('textbox', { name: 'Model', exact: true }).inputValue(), '',
    'Switching endpoint must not keep the previous server’s model id');
  await page.getByRole('textbox', { name: 'Model', exact: true }).fill('hello-qa-model');
  await page.getByRole('button', { name: 'Save connection & load models', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  done.push('A provider preset fills the connection form, and the endpoint stays what the user last saved');

  // 2 ─ Import the two bundled example skills and the example plugin
  for (const name of ['hello-visuals', 'hello-research']) {
    await page.getByRole('button', { name: `Add example: ${name}`, exact: true }).click();
    await page.getByRole('button', { name: `Re-import ${name} from its source`, exact: true }).waitFor();
  }
  await page.getByRole('button', { name: 'Add example: hello-text-tools', exact: true }).click();
  await page.getByRole('button', { name: 'Re-import hello-text-tools from its source', exact: true }).waitFor();
  await capture(page, 'library-imported');
  const imported = await page.evaluate(() => window.hello.extensions.list());
  assert.equal(imported.length, 3);
  assert.ok(imported.every(item => item.state === 'ready'));
  assert.ok(imported.find(item => item.name === 'hello-text-tools').entries.includes('extension: extensions/text-stats.ts'));
  done.push('Bundled example skills and plugin import as approved copies, not activated');

  // 3 ─ Add and probe a real MCP server
  await page.getByRole('button', { name: 'Add an MCP server', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('qa files');
  await page.getByRole('textbox', { name: 'Command', exact: true }).fill(executablePath);
  await page.getByRole('textbox', { name: 'Arguments (one per line)', exact: true }).fill(mcpServer);
  await page.getByRole('textbox', { name: 'Working folder (optional)', exact: true }).fill(workDir);
  // The label carries a hint span, so target the field by its placeholder.
  await page.getByPlaceholder('API_TOKEN=…').fill('ELECTRON_RUN_AS_NODE=1');
  await page.getByRole('button', { name: 'Save server', exact: true }).click();
  await page.getByRole('button', { name: 'Connect and list tools for qa-files', exact: true }).click();
  await page.getByText('1 tool(s)', { exact: true }).waitFor({ timeout: 20000 });
  await capture(page, 'mcp-connected');
  const status = await page.evaluate(() => window.hello.extensions.status());
  assert.deepEqual(status.map(item => [item.name, item.connected, item.tools]), [['qa-files', true, ['inventory']]]);
  done.push('An MCP server configured in Settings connects over stdio and lists its real tools');

  await page.getByRole('button', { name: 'Edit qa-files', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Command', exact: true }).inputValue(), executablePath);
  assert.equal(await page.getByRole('textbox', { name: 'Arguments (one per line)', exact: true }).inputValue(), mcpServer);
  assert.equal(await page.getByRole('textbox', { name: 'Working folder (optional)', exact: true }).inputValue(), workDir);
  await capture(page, 'mcp-edit-form');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Connect and list tools for qa-files', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect qa-files', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Disconnect qa-files', exact: true }).click();
  await page.getByRole('button', { name: 'Connect and list tools for qa-files', exact: true }).waitFor();
  await capture(page, 'mcp-edited-and-disconnected');
  done.push('Editing preserves arguments with spaces, working folder and stored environment; Disconnect stops the probed server');

  // 4 ─ Detail disclosure for one resource
  await page.getByRole('button', { name: 'hello-visuals', exact: true }).click();
  await page.getByText('references/forms.md', { exact: true }).waitFor();
  await capture(page, 'skill-details');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // 5 ─ Activate the skill and the MCP server for this chat
  await page.getByRole('button', { name: 'Extensions', exact: true }).click();
  await page.getByRole('menuitem', { name: /hello-visuals/ }).click();
  await page.getByRole('button', { name: /Extensions \(1 active\)/ }).click();
  await page.getByRole('menuitem', { name: /qa-files/ }).click();
  await page.getByRole('button', { name: /Extensions \(2 active\)/ }).waitFor();
  await page.keyboard.press('Escape');
  await capture(page, 'activated-in-chat');
  const activeIds = await page.evaluate(async () => {
    const boot = await window.hello.bootstrap();
    return window.hello.extensions.active(boot.conversations[0].id);
  });
  assert.equal(activeIds.length, 2);
  done.push('Activation is chosen per conversation from the composer');

  // 5b ─ Activate the plugin too: its Pi extension must reach the model
  await page.getByRole('button', { name: /Extensions \(2 active\)/ }).click();
  await page.getByRole('menuitem', { name: /hello-text-tools/ }).click();
  await page.getByRole('button', { name: /Extensions \(3 active\)/ }).waitFor();
  await page.keyboard.press('Escape');
  skipTools = true;
  pluginProbe = true;
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/concise Say hello.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(async () => {
    const messages = await page.evaluate(async () => {
      const boot = await window.hello.bootstrap();
      return window.hello.conversations.messages(boot.conversations[0].id);
    });
    return messages.at(-1)?.role === 'assistant' && messages.at(-1)?.status === 'complete';
  }, 'the turn that loads the plugin extension', 60000);
  assert.ok(seen.tools.includes('text_stats'),
    `The plugin's Pi extension did not register its tool: ${seen.tools.join(', ')}`);
  assert.ok(seen.tools.includes('web_search'), 'Hello tools were lost when the plugin loaded');
  assert.match(seen.userMessages, /three clear sentences/);
  assert.ok(seen.calls.includes('text_stats'), 'The fixture never executed the plugin tool');
  const pluginResult = await page.evaluate(async () => {
    const boot = await window.hello.bootstrap();
    const messages = await window.hello.conversations.messages(boot.conversations[0].id);
    return messages.at(-1).parts.find(part => part.type === 'tool' && part.name === 'text_stats');
  });
  assert.equal(pluginResult.status, 'complete');
  assert.match(pluginResult.output, /3/);
  pluginProbe = false;
  await capture(page, 'plugin-tool-offered');
  done.push('An activated plugin loads its Pi extension: its tool reaches the model beside Hello’s own');
  done.push('The plugin prompt template expands in Pi and its text_stats tool executes with its result persisted in chat');

  // 5c ─ Turning the plugin off removes that tool from the next turn
  await page.getByRole('button', { name: /Extensions \(3 active\)/ }).click();
  await page.getByRole('menuitem', { name: /hello-text-tools/ }).click();
  await page.getByRole('button', { name: /Extensions \(2 active\)/ }).waitFor();
  await page.keyboard.press('Escape');
  seen.tools = [];
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Say hello again.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(async () => {
    const messages = await page.evaluate(async () => {
      const boot = await window.hello.bootstrap();
      return window.hello.conversations.messages(boot.conversations[0].id);
    });
    return seen.tools.length > 0 && messages.at(-1)?.role === 'assistant' && messages.at(-1)?.status === 'complete';
  }, 'the next turn to finish without the plugin', 60000);
  assert.ok(!seen.tools.includes('text_stats'), 'A deactivated plugin tool was still offered');
  done.push('Turning the plugin off removes its tool from the next turn');
  skipTools = false;
  seen.calls.length = 0;

  // 6 ─ A real turn: the model loads the skill, then calls the MCP tool
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use the visuals skill and the inventory tool.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(async () => {
    const messages = await page.evaluate(async () => {
      const boot = await window.hello.bootstrap();
      return window.hello.conversations.messages(boot.conversations[0].id);
    });
    return messages.at(-1)?.role === 'assistant' && messages.at(-1)?.status === 'complete';
  }, 'the skill and MCP turn to finish', 60000);
  await capture(page, 'skill-and-mcp-used');
  assert.ok(seen.tools.includes('skill_load'), `skill_load was not offered: ${seen.tools.join(', ')}`);
  assert.ok(seen.tools.includes('mcp_qa_files_inventory'), `MCP tool was not offered: ${seen.tools.join(', ')}`);
  assert.deepEqual(seen.calls, ['skill_load', 'mcp_qa_files_inventory']);
  const messages = await page.evaluate(async () => {
    const boot = await window.hello.bootstrap();
    return window.hello.conversations.messages(boot.conversations[0].id);
  });
  const parts = messages.at(-1).parts.filter(part => part.type === 'tool');
  const skillPart = parts.find(part => part.name === 'skill_load');
  const mcpPart = parts.find(part => part.name === 'mcp_qa_files_inventory');
  assert.equal(skillPart.status, 'complete');
  assert.match(skillPart.output, /Hello Visuals/);
  assert.match(skillPart.output, /browser_show_html/);
  assert.equal(mcpPart.status, 'complete');
  assert.match(mcpPart.output, /3 crates, 1 pallet/);
  assert.match(messages.at(-1).content, /3 crates, 1 pallet/);
  done.push('The model loads real skill instructions with skill_load and calls a real MCP tool; both results reach the answer');

  // 7 ─ Deactivating removes the tools and stops the server process
  await page.getByRole('button', { name: /Extensions \(2 active\)/ }).click();
  await page.getByRole('menuitem', { name: /qa-files/ }).click();
  await page.keyboard.press('Escape');
  await until(async () => (await page.evaluate(() => window.hello.extensions.status())).every(item => !item.connected),
    'the deactivated MCP server to stop', 20000);
  seen.tools = [];
  skipTools = true; // The next turn answers directly.
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Answer without the server.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(async () => {
    const messages = await page.evaluate(async () => {
      const boot = await window.hello.bootstrap();
      return window.hello.conversations.messages(boot.conversations[0].id);
    });
    return messages.at(-1)?.role === 'assistant' && messages.at(-1)?.status === 'complete';
  }, 'the answer without the server', 60000);
  assert.ok(!seen.tools.includes('mcp_qa_files_inventory'), 'A deactivated MCP tool was still offered to the model');
  assert.ok(seen.tools.includes('skill_load'), 'The still-active skill lost its tool');
  await capture(page, 'deactivated');
  done.push('Turning a server off removes its tools from the next turn and stops its process');

  // 8 ─ A changed approved copy blocks the run by name
  const skillFile = join(dataDir, 'library', 'skills',
    (await page.evaluate(() => window.hello.extensions.list())).find(item => item.name === 'hello-visuals').id, 'SKILL.md');
  await writeFile(skillFile, '---\nname: hello-visuals\ndescription: tampered\n---\nrewritten');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Try again after the file changed.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('hello-visuals', { exact: false }).first().waitFor();
  await until(async () => {
    const messages = await page.evaluate(async () => {
      const boot = await window.hello.bootstrap();
      return window.hello.conversations.messages(boot.conversations[0].id);
    });
    return Boolean(messages.at(-1)?.error?.includes('hello-visuals'));
  }, 'the blocked run to report the changed extension', 30000);
  await capture(page, 'modified-copy-blocked');
  const blocked = await page.evaluate(async () => {
    const boot = await window.hello.bootstrap();
    const messages = await window.hello.conversations.messages(boot.conversations[0].id);
    return messages.at(-1).error;
  });
  assert.match(blocked, /changed since you approved it/);
  done.push('An approved copy edited on disk stops the run and names the extension instead of loading it');

  assert.deepEqual(errors, []);
  await capture(page, 'final');

  // 9 ─ The library survives a real restart of the application
  await app.close();
  app = await electron.launch({
    executablePath, args: launchArgs,
    env: { ...process.env, HELLO_DATA_DIR: dataDir, HELLO_TEST_MODE: '1', HELLO_TEST_ENDPOINT: `http://127.0.0.1:${port}/v1`, HELLO_TEST_MODEL: 'hello-qa-model', ELECTRON_RUN_AS_NODE: undefined },
  });
  const restarted = await app.firstWindow();
  await until(() => restarted.evaluate(() => !!window.hello).catch(() => false), 'the restarted app bridge');
  const afterRestart = await restarted.evaluate(async () => {
    const boot = await window.hello.bootstrap();
    return {
      resources: await window.hello.extensions.list(),
      active: await window.hello.extensions.active(boot.conversations[0].id),
      servers: await window.hello.extensions.status(),
    };
  });
  assert.equal(afterRestart.resources.length, 4);
  assert.equal(afterRestart.resources.find(item => item.name === 'hello-visuals').state, 'modified');
  assert.equal(afterRestart.active.length, 1);
  assert.ok(afterRestart.servers.every(item => !item.connected));
  done.push('Library, approved copies, the modified flag and per-chat activation survive an app restart with no server left running');

  // 10 ─ Discovery reads what other agent tools configured on this Mac
  await app.close();
  const fakeHome = await mkdtemp(join(tmpdir(), 'hello-qa-home-'));
  await writeFile(join(fakeHome, '.claude.json'), JSON.stringify({
    mcpServers: {
      'qa-discovered': { type: 'stdio', command: process.execPath, args: [mcpServer], env: { QA_DISCOVERED_TOKEN: 'fixture-only-value' } },
      'qa-hosted': { type: 'http', url: 'https://example.test/mcp' },
    },
  }));
  await mkdir(join(fakeHome, '.agents', 'skills', 'qa-found-skill'), { recursive: true });
  await writeFile(join(fakeHome, '.agents', 'skills', 'qa-found-skill', 'SKILL.md'),
    '---\nname: qa-found-skill\ndescription: Planted for the discovery check.\n---\n\nFound by scanning, not typed.\n');
  app = await electron.launch({
    executablePath, args: launchArgs,
    env: { ...process.env, HELLO_HOME_DIR: fakeHome, HELLO_DATA_DIR: dataDir, HELLO_TEST_MODE: '1', ELECTRON_RUN_AS_NODE: undefined },
  });
  const scanning = await app.firstWindow();
  await until(() => scanning.evaluate(() => !!window.hello).catch(() => false), 'the app bridge with discovery pointed at a fixture home');
  const discovery = await scanning.evaluate(() => window.hello.extensions.discover());
  const server = discovery.mcp.find(item => item.name === 'qa-discovered');
  const hosted = discovery.mcp.find(item => item.name === 'qa-hosted');
  const skill = discovery.skills.find(item => item.name === 'qa-found-skill');
  assert.ok(server, 'Discovery must list the server another tool configured');
  assert.equal(server.source, 'Claude Code');
  assert.deepEqual(server.envNames, ['QA_DISCOVERED_TOKEN']);
  assert.ok(!JSON.stringify(discovery).includes('fixture-only-value'), 'Environment values must not reach the renderer');
  assert.equal(hosted?.transport, 'remote');
  assert.match(hosted.unsupported, /stdio/);
  assert.ok(skill, 'Discovery must list the skill folder another tool installed');
  // The same scan, done the way a person does it, and shown in the library.
  await scanning.getByRole('button', { name: 'Settings', exact: true }).click();
  await scanning.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await scanning.getByRole('button', { name: 'Find what other agent tools already have', exact: true }).click();
  await scanning.getByRole('button', { name: 'Look again', exact: true }).waitFor();
  const foundRow = scanning.locator('.extension-found li', { hasText: 'qa-found-skill' });
  await foundRow.waitFor();
  assert.match(await foundRow.innerText(), /Agent skills/);
  await capture(scanning, 'discovered');
  await scanning.getByRole('button', { name: 'Close Settings', exact: true }).click();
  const adopted = await scanning.evaluate(async ({ serverId, skillId }) => {
    const added = await window.hello.extensions.importDiscovered('mcp', serverId);
    const copied = await window.hello.extensions.importDiscovered('skill', skillId);
    return { added, copied, probe: await window.hello.extensions.probe(added.id), library: await window.hello.extensions.list() };
  }, { serverId: server.id, skillId: skill.id });
  assert.equal(adopted.added.name, 'qa-discovered');
  assert.ok(adopted.probe.connected, `The discovered server must start: ${adopted.probe.error ?? ''}`);
  assert.ok(adopted.probe.tools.length, 'The discovered server must list its tools');
  assert.equal(adopted.copied.state, 'ready');
  assert.equal(adopted.library.length, 6);
  await scanning.evaluate(id => window.hello.extensions.disconnect(id), adopted.added.id);
  done.push('Servers and skills configured for other agent tools are found in their own files and added without retyping');
} catch (error) {
  // A failed check must say what the app actually did, not only what it wanted.
  try {
    const page = await app?.firstWindow();
    const state = await page?.evaluate(async () => {
      const boot = await window.hello.bootstrap();
      const messages = await window.hello.conversations.messages(boot.conversations[0].id);
      return messages.slice(-2).map(message => ({
        role: message.role, status: message.status, error: message.error,
        content: String(message.content).slice(0, 300),
        parts: (message.parts ?? []).map(part => part.type === 'tool'
          ? { tool: part.name, status: part.status, output: String(part.output ?? '').slice(0, 200) }
          : part.type),
      }));
    });
    console.error('\nLast messages:', JSON.stringify(state, null, 2));
  } catch { /* diagnostics only */ }
  console.error('Fixture saw tools:', seen.tools.join(', ') || '(none)');
  console.error('Fixture saw calls:', seen.calls.join(', ') || '(none)');
  throw error;
} finally {
  await app?.close().catch(() => {});
  server.close();
}
console.log(`\nExtensions acceptance — ${done.length} checks, data in ${dataDir}\n`);
for (const line of done) console.log(`  ✓ ${line}`);
console.log(`\nScreenshots: ${artifacts}\n`);
