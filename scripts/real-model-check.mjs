/**
 * Acceptance against a REAL provider, for the parts a fixture cannot judge:
 * whether an actual model, reached over the network, drives Hello's tools,
 * skills and plugins.
 *
 * Everything runs against a NEW disposable app data directory. It never touches
 * the owner's app data, conversations or running instance. The only credential
 * used is the one placed in .env (git-ignored) or the environment:
 *
 *   HELLO_QA_ENDPOINT=https://openrouter.ai/api/v1
 *   HELLO_QA_MODEL=vendor/model:free
 *   HELLO_QA_API_KEY=…
 *
 * The key is read, passed to the app's own encrypted settings, and never
 * printed — failures redact it before anything reaches the console.
 *
 *   pnpm build && node scripts/real-model-check.mjs
 *
 * Transport and tool plumbing are hard assertions. Whether the model chooses to
 * call a tool is reported, not asserted: that is the model's judgement, and a
 * free model refusing to use a tool is a finding, not a broken app.
 */
import { _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);

// ── Credentials come from .env or the environment, never from a flag ─────────
const fromFile = existsSync('.env')
  ? Object.fromEntries(
      readFileSync('.env', 'utf8')
        .split('\n')
        .map(line => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line))
        .filter(Boolean)
        .map(match => [match[1], match[2].trim().replace(/^["']|["']$/g, '')]),
    )
  : {};
const config = {
  endpoint: process.env.HELLO_QA_ENDPOINT || fromFile.HELLO_QA_ENDPOINT,
  model: process.env.HELLO_QA_MODEL || fromFile.HELLO_QA_MODEL,
  apiKey: process.env.HELLO_QA_API_KEY || fromFile.HELLO_QA_API_KEY,
};
const missing = Object.entries(config).filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.error(`Missing ${missing.join(', ')}. Put them in .env (git-ignored) or the environment:

  HELLO_QA_ENDPOINT=https://openrouter.ai/api/v1
  HELLO_QA_MODEL=vendor/model:free
  HELLO_QA_API_KEY=…
`);
  process.exit(2);
}
/** No path prints a credential, including failures. */
const redact = text => String(text).split(config.apiKey).join('«api key»');

const dataDir = await mkdtemp(join(tmpdir(), 'hello-real-model-qa-'));
const workDir = await mkdtemp(join(tmpdir(), 'hello-real-model-work-'));
const artifacts = resolve('test-results/real-model');
const executablePath = process.env.HELLO_TEST_APP || require('electron');
const launchArgs = process.env.HELLO_TEST_APP ? [] : [resolve('out/main/index.js')];

const until = async (check, what, timeout = 180_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise(done => setTimeout(done, 500));
  }
};

const done = [];
const reported = [];
let app;
try {
  app = await electron.launch({
    executablePath, args: launchArgs,
    env: { ...process.env, HELLO_DATA_DIR: dataDir, HELLO_TEST_MODE: '1', ELECTRON_RUN_AS_NODE: undefined },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await until(() => page.evaluate(() => !!window.hello).catch(() => false), 'the app bridge', 60_000);

  // 1 ─ The real endpoint answers a model listing and accepts the saved key
  const saved = await page.evaluate(async settings => {
    const result = await window.hello.settings.save({
      endpointUrl: settings.endpoint, model: settings.model, apiKey: settings.apiKey,
      contextWindow: 32768, maxOutputTokens: 4096,
    });
    return { apiKeySet: result.apiKeySet, models: await window.hello.settings.models() };
  }, config);
  assert.equal(saved.apiKeySet, true, 'The key must be stored encrypted, not rejected');
  assert.ok(saved.models.length > 5, `The provider must list its models, saw ${saved.models.length}`);
  assert.ok(saved.models.includes(config.model), `The provider must offer ${config.model}`);
  done.push(`The real endpoint lists ${saved.models.length} models and accepts the stored key`);

  // 2 ─ A chat with a folder, the bundled examples imported and turned on
  const chat = await page.evaluate(async folder => {
    const created = await window.hello.conversations.create('Real model check');
    await window.hello.conversations.update(created.id, { folder });
    for (const name of ['hello-visuals', 'hello-research'])
      await window.hello.extensions.importExample('skill', name);
    await window.hello.extensions.importExample('plugin', 'hello-text-tools');
    const library = await window.hello.extensions.list();
    for (const resource of library)
      await window.hello.extensions.setActive(created.id, resource.id, true);
    return { id: created.id, library: library.map(item => item.name) };
  }, workDir);
  assert.equal(chat.library.length, 3);
  done.push(`Imported and activated ${chat.library.join(', ')} for one chat`);

  const ask = async (text, what) => {
    const before = await page.evaluate(id => window.hello.conversations.messages(id), chat.id);
    await page.evaluate(({ id, text }) => window.hello.chat.send(id, text), { id: chat.id, text });
    await until(async () => {
      const messages = await page.evaluate(id => window.hello.conversations.messages(id), chat.id);
      const last = messages.at(-1);
      return messages.length > before.length && last?.role === 'assistant' &&
        (last.status === 'complete' || last.status === 'error');
    }, what);
    const messages = await page.evaluate(id => window.hello.conversations.messages(id), chat.id);
    const answer = messages.at(-1);
    assert.notEqual(answer.status, 'error', `${what} failed: ${redact(answer.error ?? '')}`);
    const tools = (answer.parts ?? []).filter(part => part.type === 'tool');
    const failed = tools.filter(part => part.status && part.status !== 'complete');
    if (failed.length)
      reported.push(`Tool call(s) did not complete during ${what}: ${failed.map(part => `${part.name}=${part.status}`).join(', ')}`);
    return {
      content: String(answer.content ?? ''),
      tools: tools.filter(part => !part.status || part.status === 'complete').map(part => part.name),
      thinking: (answer.parts ?? []).some(part => part.type === 'thinking'),
    };
  };

  // 3 ─ A plain turn completes end to end against the real provider
  const plain = await ask('Reply with exactly: HELLO OK', 'the first real answer');
  assert.ok(plain.content.trim().length, 'The model must return text');
  done.push(`A real turn completed: ${JSON.stringify(plain.content.slice(0, 60))}`);

  // 4 ─ Hello's own file tool, driven by the model, actually writes to disk
  const wrote = await ask(
    'Use your file tools to create a file named note.md in the attached folder whose only content is the word MODELWROTE. Then say DONE.',
    'the model to use a file tool',
  );
  const files = await readdir(workDir);
  if (files.includes('note.md')) {
    const body = await readFile(join(workDir, 'note.md'), 'utf8');
    assert.match(body, /MODELWROTE/, 'The file the model wrote must hold what it was asked to write');
    done.push(`The model wrote note.md through Hello's file tools (${wrote.tools.join(', ') || 'no tool parts recorded'})`);
  } else {
    reported.push(`The model did not create note.md. Tools it called: ${wrote.tools.join(', ') || 'none'}`);
  }

  // 5 ─ A plugin's own tool, loaded into Pi from the imported copy
  const plugin = await ask(
    'Call the text_stats tool on the text "one two three" and report the word count it returns.',
    'the model to use the plugin tool',
  );
  if (plugin.tools.includes('text_stats')) done.push('The model called the plugin tool text_stats and used its result');
  else reported.push(`The model did not call text_stats. Tools it called: ${plugin.tools.join(', ') || 'none'}`);

  // 6 ─ Progressive skill disclosure with a real model
  const skill = await ask(
    'Load the instructions of the hello-visuals skill with skill_load, then quote its first heading.',
    'the model to load a skill',
  );
  if (skill.tools.includes('skill_load')) done.push('The model loaded real skill instructions with skill_load');
  else reported.push(`The model did not call skill_load. Tools it called: ${skill.tools.join(', ') || 'none'}`);

  // 7 ─ The Visuals flow the earlier reports left unexercised: skill → HTML pane
  const visual = await ask(
    'Render a tiny HTML page titled "Real model check" with browser_show_html, then say SHOWN.',
    'the model to render HTML',
  );
  if (visual.tools.includes('browser_show_html')) {
    const tabs = await page.evaluate(async id => {
      const boot = await window.hello.bootstrap();
      return boot.browsers.filter(tab => tab.conversationId === id).map(tab => tab.title);
    }, chat.id);
    assert.ok(tabs.length, 'browser_show_html must leave a real page open in the chat');
    done.push(`The model rendered a page with browser_show_html, open as ${JSON.stringify(tabs[0])}`);
  } else reported.push(`The model did not call browser_show_html. Tools it called: ${visual.tools.join(', ') || 'none'}`);

  // 8 ─ The Research flow: a real web search through Hello's own tool
  const research = await ask(
    'Search the web for the current version of the Electron framework and cite the page you used.',
    'the model to search the web',
  );
  if (research.tools.includes('web_search') || research.tools.includes('fetch_url'))
    done.push(`The model reached the web through Hello's tools (${research.tools.join(', ')})`);
  else reported.push(`The model did not search the web. Tools it called: ${research.tools.join(', ') || 'none'}`);

  await page.screenshot({ path: join(artifacts, 'real-model-chat.png') }).catch(() => {});
  assert.deepEqual(errors, [], 'The renderer must raise no errors during a real-model run');
} catch (error) {
  console.error(redact(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
}

console.log(`\nReal-model acceptance — ${config.model} via ${config.endpoint}\n`);
for (const line of done) console.log(`  ✓ ${line}`);
for (const line of reported) console.log(`  · ${line}`);
console.log(`\nDisposable data: ${dataDir}\n`);
