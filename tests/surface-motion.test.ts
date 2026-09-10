import { describe, expect, it, vi } from 'vitest';

import { animateSurface } from '../src/renderer/ui/surface-motion';

function surface({
  tokens = {},
  reduced = false,
  systemReduced = false,
}: {
  tokens?: Record<string, string>;
  reduced?: boolean;
  systemReduced?: boolean;
} = {}) {
  const values: Record<string, string> = {
    '--motion-base': '160ms',
    '--motion-fast': '120ms',
    '--ease-out': 'cubic-bezier(0.32, 0.72, 0, 1)',
    '--ease-in': 'cubic-bezier(0.4, 0, 1, 1)',
    '--reveal-translate': '4px',
    ...tokens,
  };
  const animations: Array<{
    onfinish: (() => void) | null;
    oncancel: (() => void) | null;
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  const computedStyle = {
    getPropertyValue: (name: string) => values[name] ?? '',
    opacity: '1',
    transform: 'none',
  };
  const animate = vi.fn(() => {
    const animation = { onfinish: null, oncancel: null, cancel: vi.fn() };
    animations.push(animation);
    return animation;
  });
  const element = {
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => computedStyle,
        matchMedia: () => ({ matches: systemReduced }),
      },
    },
    closest: () => (reduced ? {} : null),
    animate,
  } as unknown as HTMLElement;
  return { element, animate, animations, computedStyle };
}

describe('surface reveal motion', () => {
  it('enters with token-driven opacity and translation only, then releases its fill', () => {
    const { element, animate, animations } = surface();
    const onFinish = vi.fn();
    animateSurface(element, 'enter', { onFinish });

    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 160, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'both' },
    );
    expect(onFinish).not.toHaveBeenCalled();
    const finish = animations[0].onfinish;
    finish?.();
    finish?.();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(animations[0].cancel).toHaveBeenCalledOnce();
  });

  it('exits at the fast token and holds its final frame until the layout is ready', () => {
    const { element, animate, animations } = surface();
    const onFinish = vi.fn();
    const cancel = animateSurface(element, 'exit', { onFinish });

    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(4px)' },
      ],
      { duration: 120, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' },
    );
    const finish = animations[0].onfinish;
    finish?.();
    finish?.();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(animations[0].cancel).not.toHaveBeenCalled();
    cancel();
    cancel();
    expect(animations[0].cancel).toHaveBeenCalledOnce();
  });

  it('cancels without dispatching an obsolete finish callback', () => {
    const { element, animations } = surface();
    const onFinish = vi.fn();
    const cancel = animateSurface(element, 'exit', { onFinish });
    const staleFinish = animations[0].onfinish;
    cancel();
    staleFinish?.();

    expect(animations[0].onfinish).toBeNull();
    expect(animations[0].oncancel).toBeNull();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('lets the latest action win and starts from the interrupted visual frame', () => {
    const { element, animate, animations, computedStyle } = surface();
    const previousFinish = vi.fn();
    const latestFinish = vi.fn();
    animateSurface(element, 'exit', { onFinish: previousFinish });
    const staleFinish = animations[0].onfinish;
    computedStyle.opacity = '0.4';
    computedStyle.transform = 'matrix(1, 0, 0, 1, 0, 2.4)';
    animateSurface(element, 'enter', { onFinish: latestFinish });

    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(animate.mock.calls[1]).toEqual([
      [
        { opacity: '0.4', transform: 'matrix(1, 0, 0, 1, 0, 2.4)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 160, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'both' },
    ]);
    staleFinish?.();
    animations[1].onfinish?.();
    expect(previousFinish).not.toHaveBeenCalled();
    expect(latestFinish).toHaveBeenCalledOnce();
  });

  it.each(['local', 'system', 'zero duration'] as const)(
    'completes immediately without movement for %s reduced motion',
    (mode) => {
      const { element, animate } = surface({
        reduced: mode === 'local',
        systemReduced: mode === 'system',
        tokens: mode === 'zero duration' ? { '--motion-base': '0ms' } : {},
      });
      const onFinish = vi.fn();
      const cancel = animateSurface(element, 'enter', { onFinish });

      expect(animate).not.toHaveBeenCalled();
      expect(onFinish).toHaveBeenCalledOnce();
      cancel();
      expect(onFinish).toHaveBeenCalledOnce();
    },
  );

  it('resolves seconds and a local reveal distance from computed tokens', () => {
    const { element, animate } = surface({
      tokens: { '--motion-base': '0.2s', '--reveal-translate': '2px' },
    });
    animateSurface(element, 'enter');

    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 0, transform: 'translateY(2px)' },
        { opacity: 1, transform: 'none' },
      ],
      expect.objectContaining({ duration: 200 }),
    );
  });

  it('does not strand an action when WAAPI is unavailable or rejects animation', () => {
    const { element, animate } = surface();
    const rejectedFinish = vi.fn();
    animate.mockImplementationOnce(() => {
      throw new Error('Animation unavailable');
    });
    animateSurface(element, 'exit', { onFinish: rejectedFinish });
    expect(rejectedFinish).toHaveBeenCalledOnce();

    Object.defineProperty(element, 'animate', { value: undefined });
    const absentFinish = vi.fn();
    animateSurface(element, 'exit', { onFinish: absentFinish });
    expect(absentFinish).toHaveBeenCalledOnce();
  });

  it('does not complete an animation canceled outside the helper', () => {
    const { element, animations } = surface();
    const onFinish = vi.fn();
    animateSurface(element, 'exit', { onFinish });
    const staleFinish = animations[0].onfinish;
    animations[0].oncancel?.();
    staleFinish?.();
    expect(onFinish).not.toHaveBeenCalled();
  });
});

