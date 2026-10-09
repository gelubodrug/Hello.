import { describe, expect, it } from 'vitest';
import { readLoginShellEnv } from '../src/main/shell-env';

describe('login shell environment capture', () => {
  it('frames noisy startup output, allowlists variables and keeps shell argv separate', async () => {
    const result = await readLoginShellEnv({ SHELL: '/bin/zsh', PATH: '/usr/bin', HOME: '/tmp', NODE_OPTIONS: 'do-not-inherit' }, async (shell, args, env) => {
      expect(shell).toBe('/bin/zsh');
      expect(args.slice(0, 3)).toEqual(['-l', '-i', '-c']);
      expect(env.NODE_OPTIONS).toBeUndefined();
      const marker = /HELLO_ENV_[a-f0-9-]+/.exec(args[3])![0];
      return `welcome\n${marker}${JSON.stringify({ PATH: '/custom/bin:/usr/bin', LANG: 'ro_RO.UTF-8', HTTPS_PROXY: 'http://localhost:8080', UNRELATED: 'discard' })}${marker}\ngoodbye`;
    });
    expect(result.PATH?.split(':')[0]).toBe('/custom/bin');
    expect(result.LANG).toBe('ro_RO.UTF-8');
    expect(result.HTTPS_PROXY).toBe('http://localhost:8080');
    expect(result.UNRELATED).toBeUndefined();
  });
  it('falls back to an augmented PATH after timeout, missing shell or malformed output', async () => {
    for (const run of [async () => { throw new Error('unavailable'); }, async () => 'not an environment']) {
      const result = await readLoginShellEnv({ PATH: '/custom/bin', SHELL: '/missing-shell' }, run);
      expect(result.PATH?.split(':')).toEqual(expect.arrayContaining(['/custom/bin', '/usr/bin', '/bin']));
      expect(Object.keys(result)).toEqual(['PATH']);
    }
  });
});
