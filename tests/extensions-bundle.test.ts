import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDataStore, type DataStore } from '../src/main/data/store';
import { ResourceLibrary, readPlugin, resourceDirectory, type PluginConfig } from '../src/main/extensions/library';
import { bundleName, bundlePrologue, packagesIn, piProvidedIn } from '../src/main/extensions/bundle';
import { discoverPiExtensions } from '../src/main/extensions/discovery';

// A Pi extension published the way OpenViking publishes its own: a folder
// with index.ts at its root, no "pi" section, and an npm package installed
// beside it. Nothing is downloaded: the package is written here.
let directory: string;
let store: DataStore;
let library: ResourceLibrary;

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function extensionFolder(name: string, index: string, withPackage = true): string {
  const root = path.join(directory, 'sources', name);
  write(path.join(root, 'package.json'), JSON.stringify({ name, version: '1.2.3', description: 'Memory for Pi.', type: 'module', dependencies: withPackage ? { 'fake-memory-client': '1.0.0' } : {} }));
  write(path.join(root, 'index.ts'), index);
  write(path.join(root, 'lib', 'greeting.ts'), 'export const greeting = (who: string): string => `salut, ${who}`;\n');
  if (withPackage) {
    write(path.join(root, 'node_modules', 'fake-memory-client', 'package.json'), JSON.stringify({ name: 'fake-memory-client', version: '1.0.0', main: 'index.cjs' }));
    // CommonJS, requiring a built-in: what a bundled ES module must still serve.
    write(path.join(root, 'node_modules', 'fake-memory-client', 'index.cjs'), "const { basename } = require('node:path');\nexports.recall = (query) => `recalled ${basename('/x/' + query)}`;\n");
  }
  return root;
}

const INDEX = `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { recall } from 'fake-memory-client';
import { greeting } from './lib/greeting';
export const probe = () => [greeting('Hello'), recall('tabs')];
export default function (pi: ExtensionAPI) { void pi; }
`;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hello-bundle-'));
  store = createDataStore(path.join(directory, 'data'), { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  library = new ResourceLibrary(store);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('a Pi extension that imports npm packages', () => {
  it('is recognized by its root index.ts, and bundled with exactly the packages it reaches', async () => {
    const imported = await library.importPath('plugin', extensionFolder('openviking-like', INDEX));
    expect(imported.state).toBe('ready');
    expect(imported.entries).toEqual(['extension: index.ts, bundled with fake-memory-client']);
    const row = store.getResourceRow(imported.id);
    const config = JSON.parse(row.config) as PluginConfig;
    expect(config.extensions).toEqual(['index.hello-bundle.mjs']);
    expect(config.bundles).toEqual([{ entry: 'index.ts', file: 'index.hello-bundle.mjs', packages: ['fake-memory-client'] }]);
    const approved = resourceDirectory(path.join(directory, 'data'), row);
    // No node_modules in the approved copy: the bundle carries what is used.
    expect(existsSync(path.join(approved, 'node_modules'))).toBe(false);
    const loaded = await import(pathToFileURL(path.join(approved, 'index.hello-bundle.mjs')).href) as { probe(): string[] };
    expect(loaded.probe()).toEqual(['salut, Hello', 'recalled tabs']);
  });

  it('leaves what Pi hands every extension to Pi', async () => {
    const imported = await library.importPath('plugin', extensionFolder('uses-pi', `import { Type } from 'typebox';
import { getModel } from '@earendil-works/pi-ai';
import { recall } from 'fake-memory-client';
export default function () { void Type; void getModel; void recall; }
`));
    const row = store.getResourceRow(imported.id);
    const bundle = readFileSync(path.join(resourceDirectory(path.join(directory, 'data'), row), 'index.hello-bundle.mjs'), 'utf8');
    expect(bundle).toMatch(/from "typebox"/);
    expect(bundle).toMatch(/from "@earendil-works\/pi-ai"/);
    expect(bundle).toContain('recalled');
  });

  it('keeps an extension without packages as it is', async () => {
    const imported = await library.importPath('plugin', extensionFolder('plain', "import { readFileSync } from 'node:fs';\nimport { greeting } from './lib/greeting';\nexport default function () { void readFileSync; void greeting; }\n", false));
    const config = JSON.parse(store.getResourceRow(imported.id).config) as PluginConfig;
    expect(config.extensions).toEqual(['index.ts']);
    expect(config.bundles).toBeUndefined();
  });

  it('names a package that is not installed, and copies nothing', async () => {
    const root = extensionFolder('broken', "import { Client } from '@modelcontextprotocol/client';\nimport { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';\nexport default function () { void Client; void AjvJsonSchemaValidator; }\n", false);
    await expect(library.importPath('plugin', root)).rejects.toThrow(/index\.ts imports @modelcontextprotocol\/client, which is not installed in that folder/);
    expect(store.listResourceRows()).toEqual([]);
    expect(existsSync(path.join(directory, 'data', 'library', 'plugins'))).toBe(false);
  });

  it('notices when the approved bundle is edited afterwards', async () => {
    const imported = await library.importPath('plugin', extensionFolder('guarded', INDEX));
    const row = store.getResourceRow(imported.id);
    writeFileSync(path.join(resourceDirectory(path.join(directory, 'data'), row), 'index.hello-bundle.mjs'), 'export default () => {};\n');
    expect(await library.verify(store.getResourceRow(imported.id))).toBe('modified');
  });

  it('refuses a folder that is itself a copy out of Hello’s library', async () => {
    const root = extensionFolder('copied', INDEX);
    write(path.join(root, 'index.hello-bundle.mjs'), 'export default () => {};\n');
    await expect(readPlugin(root)).rejects.toThrow(/Import the plugin’s own folder/);
  });

  it('names bundles beside their entry and reads package names from node_modules paths', () => {
    expect(bundleName('index.ts')).toBe('index.hello-bundle.mjs');
    expect(bundleName('extensions/memory/index.js')).toBe('extensions/memory/index.hello-bundle.mjs');
    const root = path.join(directory, 'plugin');
    write(path.join(directory, 'linked', 'package.json'), JSON.stringify({ name: 'linked-helper' }));
    write(path.join(directory, 'linked', 'src', 'index.js'), 'export {};\n');
    expect(packagesIn({ inputs: {
      'index.ts': { bytes: 1, imports: [] },
      'lib/own.ts': { bytes: 1, imports: [] },
      'node_modules/@scope/pkg/dist/a.js': { bytes: 1, imports: [] },
      '../store/node_modules/.pnpm/x@1/node_modules/plain/index.js': { bytes: 1, imports: [] },
      // A hoisted or linked package: no node_modules segment, still not in the copy.
      '../linked/src/index.js': { bytes: 1, imports: [] },
      // A folder the approved copy skips.
      '.generated/types.js': { bytes: 1, imports: [] },
    }, outputs: {} }, root)).toEqual(['.generated', '@scope/pkg', 'linked-helper', 'plain']);
  });
});

describe('importing, and importing again', () => {
  it('takes a single extension file, bundling what it imports', async () => {
    const root = extensionFolder('single-home', INDEX);
    const file = path.join(root, 'memory.ts');
    write(file, INDEX.replace('./lib/greeting', './lib/greeting'));
    const imported = await library.importPath('plugin', file);
    expect(imported).toMatchObject({ name: 'memory', state: 'ready', entries: ['extension: memory.ts, bundled with fake-memory-client'] });
  });

  it('keeps the approved copy when a re-import fails', async () => {
    const root = extensionFolder('stable', INDEX);
    const imported = await library.importPath('plugin', root);
    write(path.join(root, 'index.ts'), "import { gone } from 'not-installed-anywhere';\nexport default () => gone;\n");
    await expect(library.update(imported.id)).rejects.toThrow(/not-installed-anywhere/);
    expect(await library.verify(store.getResourceRow(imported.id))).toBe('ready');
    expect(readdirSync(path.join(directory, 'data', 'library', 'plugins'))).toEqual([imported.id]);
  });

  it('refuses two entries that would share one bundle', async () => {
    const root = extensionFolder('twins', INDEX);
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'twins', pi: { extensions: ['./index.ts', './index.js'] } }));
    write(path.join(root, 'index.js'), "import { recall } from 'fake-memory-client';\nexport default () => recall('x');\n");
    await expect(library.importPath('plugin', root)).rejects.toThrow(/index\.js and index\.ts would both be bundled as index\.hello-bundle\.mjs/);
  });

  it('leaves a root index.ts alone when the package already has skills', async () => {
    const root = extensionFolder('skills-too', INDEX);
    write(path.join(root, 'skills', 'helper', 'SKILL.md'), '---\nname: helper\ndescription: Helps.\n---\nsteps');
    const imported = await readPlugin(root);
    expect((imported.config as PluginConfig).extensions).toEqual([]);
    expect((imported.config as PluginConfig).skills).toEqual(['skills/helper']);
  });
});

describe('Pi extensions installed for Pi itself', () => {
  it('are found in ~/.pi/agent/extensions, by their index or their "pi" section', async () => {
    const home = path.join(directory, 'home');
    const root = path.join(home, '.pi', 'agent', 'extensions');
    write(path.join(root, 'openviking', 'package.json'), JSON.stringify({ name: 'openviking-pi-extension', description: 'OpenViking memory and context extension for the pi coding agent' }));
    write(path.join(root, 'openviking', 'index.ts'), 'export default () => {};\n');
    write(path.join(root, 'manifest-only', 'package.json'), JSON.stringify({ name: 'manifest-only', pi: { extensions: ['./src/main.ts'] } }));
    write(path.join(root, 'notes', 'README.md'), 'not an extension');
    write(path.join(root, 'single.ts'), 'export default () => {};\n');
    const found = await discoverPiExtensions(home);
    write(path.join(root, 'scoped', 'package.json'), JSON.stringify({ name: '@acme/Memory Tool', pi: { extensions: ['./x.ts'] } }));
    expect(found.map(item => [item.name, item.source])).toEqual([['manifest-only', 'Pi'], ['openviking-pi-extension', 'Pi'], ['single', 'Pi']]);
    expect(found[1]).toMatchObject({ path: path.join(root, 'openviking'), description: 'OpenViking memory and context extension for the pi coding agent' });
    // Named as the library will name it, so an added one is not offered again.
    expect((await discoverPiExtensions(home)).find(item => item.path.endsWith('scoped'))?.name).toBe('acme-memory-tool');
    // PI_CODING_AGENT_DIR moves Pi's folder.
    expect(await discoverPiExtensions(path.join(directory, 'nobody'))).toEqual([]);
    expect((await discoverPiExtensions(path.join(directory, 'nobody'), path.join(home, '.pi', 'agent'))).length).toBe(4);
  });

  // Pi's rule is wider than Hello's import, so a found row has to say when the
  // import would refuse it instead of failing on the Add button.
  it('say why Hello would refuse one, instead of offering it', async () => {
    const home = path.join(directory, 'refused');
    const root = path.join(home, '.pi', 'agent', 'extensions');
    // A "pi" section naming a file that is not there: Pi lists it, the import refuses it.
    write(path.join(root, 'phantom', 'package.json'), JSON.stringify({ name: 'phantom', pi: { extensions: ['./src/main.ts'] } }));
    write(path.join(root, 'plain', 'package.json'), JSON.stringify({ name: 'plain' }));
    write(path.join(root, 'plain', 'index.ts'), 'export default () => {};\n');
    // A symlink Hello copies nothing through.
    write(path.join(root, 'linked', 'package.json'), JSON.stringify({ name: 'linked' }));
    write(path.join(root, 'linked', 'index.ts'), 'export default () => {};\n');
    symlinkSync(path.join(root, 'plain', 'index.ts'), path.join(root, 'linked', 'elsewhere.ts'));
    const found = await discoverPiExtensions(home);
    const by = (name: string) => found.find(item => item.name === name);
    expect(by('phantom')?.unsupported).toMatch(/matches no supported files/);
    expect(by('linked')?.unsupported).toMatch(/symbolic link/);
    expect(by('plain')?.unsupported).toBeUndefined();
    expect('unsupported' in (by('plain') ?? {})).toBe(false);
  });
});

describe('what Pi hands an extension, reached by require()', () => {
  // Pi aliases those specifiers for its loader, so an import of one resolves.
  // createRequire does not: it looks for a node_modules beside the bundle, and
  // the approved copy has none — in a packaged app, nothing on that path does.
  it('imports exactly the Pi modules the bundle reached, and hands them to require()', () => {
    const prologue = bundlePrologue(['typebox', '@earendil-works/pi-ai']);
    expect(prologue).toContain("import * as __helloPi0 from 'typebox';");
    expect(prologue).toContain("import * as __helloPi1 from '@earendil-works/pi-ai';");
    expect(prologue).toContain("new Map([['typebox', __helloPi0], ['@earendil-works/pi-ai', __helloPi1]])");
    // require.resolve and require.cache stay on it.
    expect(prologue).toContain('Object.assign(');
    // Nothing reached: Node's own require, with no import of its own.
    expect(bundlePrologue()).toBe("import { createRequire as __helloCreateRequire } from 'node:module';\nconst __helloNodeRequire = __helloCreateRequire(import.meta.url);\nconst require = __helloNodeRequire;");
    expect(bundlePrologue()).not.toContain('__helloPi0');
  });

  it('reads them off a built bundle, external ones only', () => {
    expect(piProvidedIn({
      inputs: {},
      outputs: { 'out.mjs': {
        imports: [
          { path: 'typebox', kind: 'import-statement', external: true },
          { path: '@earendil-works/pi-coding-agent', kind: 'require-call', external: true },
          { path: 'fake-memory-client', kind: 'import-statement', external: true },
          { path: '@earendil-works/pi-ai', kind: 'import-statement' },
        ],
        exports: [], entryPoint: 'index.ts', inputs: {}, bytes: 0,
      } },
    })).toEqual(['typebox', '@earendil-works/pi-coding-agent']);
  });

  it('puts the prologue on a real bundle that requires a Pi module', async () => {
    const root = extensionFolder('cjs-requires-pi', `import { recall } from 'fake-memory-client';
export default function () { void recall; }
`);
    write(path.join(root, 'node_modules', 'fake-memory-client', 'index.cjs'),
      "const { Type } = require('typebox');\nexports.recall = () => Type;\n");
    const imported = await library.importPath('plugin', root);
    const bundle = readFileSync(path.join(resourceDirectory(path.join(directory, 'data'), store.getResourceRow(imported.id)), 'index.hello-bundle.mjs'), 'utf8');
    expect(bundle).toContain("import * as __helloPi0 from 'typebox';");
    expect(bundle).toContain("__helloPiProvided.get(__helloId)");
  });
});
