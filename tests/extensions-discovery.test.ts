import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMcpServers, discoverSkills, withoutSecrets } from '../src/main/extensions/discovery';

let home: string;
const write = (relative: string, content: string) => {
  const file = join(home, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content, 'utf8');
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hello-discovery-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('finding what other agent tools already have', () => {
  it('reads each tool in its own format and keeps environment values out of the renderer', async () => {
    write('.claude.json', JSON.stringify({
      mcpServers: {
        notes: { type: 'stdio', command: '/usr/local/bin/notes', args: ['--root', '/Users/me/notes'], env: { API_TOKEN: 'test-only-value' } },
        hosted: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer header-only-value' } },
        local_http: { type: 'http', url: 'http://localhost:7891/rpc' },
        legacy: { type: 'sse', url: 'https://example.test/sse' },
        plain: { type: 'http', url: 'http://example.test/mcp' },
      },
      projects: { '/Users/me/work': { mcpServers: { repo: { command: 'repo-server' } } } },
    }));
    write('.codex/config.toml', [
      '[mcp_servers.files]',
      'command = "/opt/homebrew/bin/node"',
      'args = ["/Users/me/files.js"]',
      'cwd = "/Users/me"',
      '',
      '[mcp_servers.files.env]',
      'FILES_TOKEN = "another-test-value"',
    ].join('\n'));
    write('.kimi/config.toml', '[mcp.servers.kimi_tools]\ncommand = "kimi-tools"\n');
    write('.config/opencode/opencode.json', JSON.stringify({
      mcp: { local: { type: 'local', command: ['bun', 'x', 'my-server'] } },
    }));
    write('.continue/config.yaml', 'mcpServers:\n  - name: continue-server\n    command: cont-mcp\n    args: ["--stdio"]\n');
    write('Library/Application Support/Code/User/mcp.json', JSON.stringify({
      servers: { vscode_server: { command: 'code-mcp', args: ['--stdio'] } },
    }));
    write('.config/zed/settings.json',
      '// Zed allows comments in this file.\n' +
      JSON.stringify({ context_servers: { zed_server: { command: { path: 'zed-mcp', args: ['--x'], env: { ZED_TOKEN: 'zed-only-value' } } } } }));
    // A file that is not valid JSON must not take the rest of the scan down:
    // this source is read before opencode, Continue, VS Code and Zed above.
    write('.gemini/settings.json', '{ this is not json');
    // Gemini CLI, read separately below: its `url` is SSE, its `httpUrl` streamable HTTP.

    const found = await discoverMcpServers(home);
    const byName = Object.fromEntries(found.map(item => [item.name, item]));
    expect(Object.keys(byName).sort()).toEqual(
      ['continue-server', 'files', 'hosted', 'kimi_tools', 'legacy', 'local', 'local_http', 'notes', 'plain', 'repo', 'vscode_server', 'zed_server'],
    );
    expect(byName.notes).toMatchObject({
      source: 'Claude Code',
      command: '/usr/local/bin/notes',
      args: ['--root', '/Users/me/notes'],
      transport: 'stdio',
      envNames: ['API_TOKEN'],
    });
    expect(byName.notes.env).toEqual({ API_TOKEN: 'test-only-value' });
    expect(byName.repo.source).toBe('Claude Code · /Users/me/work');
    expect(byName.files).toMatchObject({ source: 'Codex CLI', cwd: '/Users/me', envNames: ['FILES_TOKEN'] });
    expect(byName.kimi_tools.source).toBe('Kimi CLI');
    // opencode writes the whole command line as one array.
    expect(byName.local).toMatchObject({ command: 'bun', args: ['x', 'my-server'] });
    expect(byName['continue-server']).toMatchObject({ command: 'cont-mcp', args: ['--stdio'] });
    expect(byName.vscode_server).toMatchObject({ source: 'VS Code', command: 'code-mcp', args: ['--stdio'] });
    expect(byName.zed_server).toMatchObject({ source: 'Zed', command: 'zed-mcp', args: ['--x'], envNames: ['ZED_TOKEN'] });
    // Streamable HTTP is reached (user, 03.11: Neon was "Not supported"), its headers kept like env values.
    expect(byName.hosted).toMatchObject({ transport: 'http', url: 'https://example.test/mcp', envNames: ['Authorization'] });
    expect(byName.hosted.unsupported).toBeUndefined();
    expect(byName.local_http).toMatchObject({ transport: 'http', url: 'http://localhost:7891/rpc' });
    // What Hello cannot reach is listed, disabled, with the reason.
    expect(byName.legacy).toMatchObject({ transport: 'remote', unsupported: expect.stringMatching(/old SSE transport/) });
    expect(byName.plain).toMatchObject({ transport: 'remote', unsupported: expect.stringMatching(/https, or http on this Mac/) });

    write('.gemini/settings.json', JSON.stringify({ mcpServers: {
      gemini_sse: { url: 'https://example.test/sse' },
      gemini_http: { httpUrl: 'https://example.test/mcp' },
    } }));
    const gemini = Object.fromEntries((await discoverMcpServers(home)).filter(item => item.source === 'Gemini CLI').map(item => [item.name, item]));
    expect(gemini.gemini_sse).toMatchObject({ transport: 'remote', unsupported: expect.stringMatching(/old SSE transport/) });
    expect(gemini.gemini_http).toMatchObject({ transport: 'http', url: 'https://example.test/mcp' });

    const shown = withoutSecrets(found);
    expect(JSON.stringify(shown)).not.toContain('test-only-value');
    expect(JSON.stringify(shown)).not.toContain('another-test-value');
    expect(JSON.stringify(shown)).not.toContain('zed-only-value');
    expect(JSON.stringify(shown)).not.toContain('header-only-value');
    expect(shown.every(item => !('env' in item))).toBe(true);
  });

  it('finds skill folders across tools, a plugin’s own skills, and names them as declared', async () => {
    write('.claude/skills/macos-app-ui/SKILL.md', '---\nname: macOS app UI\ndescription: |\n  Native-feeling\n  windows.\n---\n\nBody.');
    write('.agents/skills/apple-hig/SKILL.md', '# No front matter here');
    write('.codex/skills/ios/SKILL.md', '---\nname: ios\ndescription: iOS work\n---\n');
    // The layout Claude Code actually writes: the marketplace clone holds
    // plugins/ (and external_plugins/), and each plugin holds its own skills.
    write('.claude/plugins/marketplaces/official/plugins/pyright/skills/types/SKILL.md', '---\nname: types\ndescription: Typing help\n---\n');
    write('.claude/plugins/marketplaces/official/external_plugins/vendor-kit/skills/vendor/SKILL.md', '---\nname: vendor\ndescription: Vendor help\n---\n');
    // A folder without SKILL.md is not a skill.
    write('.claude/skills/not-a-skill/README.md', 'nothing here');

    const found = await discoverSkills(home);
    expect(found.map(item => item.name).sort()).toEqual(['apple-hig', 'ios', 'macOS app UI', 'types', 'vendor']);
    const declared = found.find(item => item.name === 'macOS app UI')!;
    expect(declared.source).toBe('Claude Code');
    expect(declared.description).toBe('Native-feeling\nwindows.');
    expect(declared.path).toBe(join(home, '.claude', 'skills', 'macos-app-ui'));
    expect(found.find(item => item.name === 'apple-hig')?.source).toBe('Agent skills');
    expect(found.find(item => item.name === 'types')?.source).toBe('Plugin · pyright');
    expect(found.find(item => item.name === 'vendor')?.source).toBe('Plugin · vendor-kit');
  });

  it('follows a symlinked skill folder and survives an unreadable one', async () => {
    write('.claude/skills/real-skill/SKILL.md', '---\nname: real-skill\ndescription: On disk.\n---\n');
    write('elsewhere/linked-skill/SKILL.md', '---\nname: linked-skill\ndescription: Reached through a link.\n---\n');
    symlinkSync(join(home, 'elsewhere', 'linked-skill'), join(home, '.claude', 'skills', 'linked-skill'));
    symlinkSync(join(home, 'nothing-here'), join(home, '.claude', 'skills', 'broken-link'));
    const found = await discoverSkills(home);
    expect(found.map(item => item.name).sort()).toEqual(['linked-skill', 'real-skill']);
  });

  it('reads per-project configuration, both from the projects a tool recorded and from a folder passed in', async () => {
    const recorded = join(home, 'work', 'recorded-project');
    const attached = join(home, 'work', 'attached-project');
    write('.claude.json', JSON.stringify({ projects: { [recorded]: {} } }));
    write('work/recorded-project/.mcp.json', JSON.stringify({
      mcpServers: { project_server: { command: 'project-mcp', args: ['--stdio'] } },
    }));
    write('work/recorded-project/.claude/skills/project-skill/SKILL.md', '---\nname: project-skill\ndescription: Beside the code.\n---\n');
    write('work/attached-project/.vscode/mcp.json', JSON.stringify({
      servers: { attached_server: { command: 'attached-mcp' } },
    }));

    const found = await discoverMcpServers(home, [attached]);
    const byName = Object.fromEntries(found.map(item => [item.name, item]));
    expect(Object.keys(byName).sort()).toEqual(['attached_server', 'project_server']);
    expect(byName.project_server.source).toBe(`Claude Code · ${recorded}`);
    expect(byName.attached_server.source).toBe(`VS Code · ${attached}`);

    const skills = await discoverSkills(home, [attached]);
    expect(skills.map(item => `${item.source} → ${item.name}`)).toEqual(['Project · recorded-project → project-skill']);
  });

  it('returns nothing instead of failing when no agent tool is configured', async () => {
    expect(await discoverMcpServers(home)).toEqual([]);
    expect(await discoverSkills(home)).toEqual([]);
  });
});
