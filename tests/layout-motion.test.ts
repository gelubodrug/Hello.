import { describe, expect, it, vi } from 'vitest';

import { createPreviewLayoutMotion } from '../src/renderer/ui/layout-motion';
import type { animateSurface } from '../src/renderer/ui/surface-motion';

interface Layout {
  chat: boolean;
  tools: boolean;
  sidebar: boolean;
}

function fixture({ immediate = false }: { immediate?: boolean } = {}) {
  const initial: Layout = { chat: true, tools: false, sidebar: true };
  const body = { id: 'body' } as unknown as HTMLElement;
  const sidebar = { id: 'sidebar' } as unknown as HTMLElement;
  const actions = { id: 'actions' } as unknown as HTMLElement;
  let visible = [body, sidebar, actions];
  const commit = vi.fn();
  const phase = vi.fn();
  const pending: Array<{
    surface: HTMLElement;
    direction: 'enter' | 'exit';
    finish: () => void;
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  const animate: typeof animateSurface = (surface, direction, options = {}) => {
    const cancel = vi.fn();
    pending.push({ surface, direction, finish: () => options.onFinish?.(), cancel });
    if (immediate) options.onFinish?.();
    return cancel;
  };
  const controller = createPreviewLayoutMotion(
    initial,
    {
      surfaces: () => visible,
      commit,
      phase,
      equals: (left, right) =>
        left.chat === right.chat && left.tools === right.tools && left.sidebar === right.sidebar,
    },
    animate,
  );
  return {
    initial,
    body,
    sidebar,
    actions,
    controller,
    commit,
    phase,
    pending,
    surfaces: (surfaces: HTMLElement[]) => {
      visible = surfaces;
    },
  };
}

describe('preview layout choreography', () => {
  it('holds existing geometry until every outgoing foreground has faded', () => {
    const { controller, pending, commit, phase } = fixture();
    controller.request((state) => ({ ...state, tools: true, sidebar: false }));
    expect(phase).toHaveBeenLastCalledWith('exit');
    expect(pending.map((motion) => motion.direction)).toEqual(['exit', 'exit', 'exit']);
    pending[0].finish();
    pending[1].finish();
    expect(commit).not.toHaveBeenCalled();
    pending[2].finish();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith({ chat: true, tools: true, sidebar: false });
    // The outgoing filled frame stays until React commits, not an arbitrary timer.
    expect(pending.every((motion) => motion.cancel.mock.calls.length === 0)).toBe(true);
    expect(pending).toHaveLength(3);
  });

  it('reveals only committed visible hosts and releases a now-hidden sidebar', () => {
    const { controller, pending, body, sidebar, actions, surfaces, commit } = fixture();
    controller.request((state) => ({ ...state, tools: true, sidebar: false }));
    pending.slice().forEach((motion) => motion.finish());
    expect(commit).toHaveBeenCalledOnce();
    surfaces([body, actions]);
    controller.revealCommitted();
    expect(pending.find((motion) => motion.surface === sidebar)?.cancel).toHaveBeenCalledOnce();
    expect(pending.slice(3).map((motion) => [motion.surface, motion.direction])).toEqual([
      [body, 'enter'],
      [actions, 'enter'],
    ]);
    expect(controller.getPhase()).toBe('enter');
    pending.slice(3).forEach((motion) => motion.finish());
    expect(controller.getPhase()).toBe('idle');
    controller.revealCommitted();
    expect(pending).toHaveLength(5);
  });

  it('enters a newly visible sidebar together with the resized content', () => {
    const { controller, pending, body, sidebar, actions, surfaces } = fixture();
    surfaces([body, actions]);
    controller.request((state) => ({ ...state, sidebar: false }));
    pending.slice().forEach((motion) => motion.finish());
    controller.revealCommitted();
    pending.slice(2).forEach((motion) => motion.finish());
    controller.request((state) => ({ ...state, sidebar: true }));
    pending.slice(4).forEach((motion) => motion.finish());
    surfaces([body, sidebar, actions]);
    controller.revealCommitted();
    expect(pending.slice(-3).map((motion) => [motion.surface, motion.direction])).toEqual([
      [body, 'enter'],
      [sidebar, 'enter'],
      [actions, 'enter'],
    ]);
  });

  it('reverses rapid sidebar clicks against intent, without committing a stale close', () => {
    const { controller, pending, commit, initial } = fixture();
    controller.request((state) => ({ ...state, sidebar: !state.sidebar }));
    const stale = pending.slice();
    controller.request((state) => ({ ...state, sidebar: !state.sidebar }));
    stale.forEach((motion) => motion.finish());
    expect(commit).not.toHaveBeenCalled();
    expect(pending.slice(3).every((motion) => motion.direction === 'enter')).toBe(true);
    pending.slice(3).forEach((motion) => motion.finish());
    expect(controller.getPhase()).toBe('idle');
    controller.request(() => initial);
    expect(pending).toHaveLength(6);
  });

  it('coalesces chat and tool intents atomically while rejecting stale finish callbacks', () => {
    const { controller, pending, commit } = fixture();
    controller.request((state) => ({ ...state, tools: true }));
    const firstExit = pending.slice();
    controller.request((state) => ({ ...state, chat: false }));
    firstExit.forEach((motion) => motion.finish());
    expect(commit).not.toHaveBeenCalled();
    pending.slice(3).forEach((motion) => motion.finish());
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith({ chat: false, tools: true, sidebar: true });
  });

  it('can close again during a reveal without an earlier enter marking it idle', () => {
    const { controller, pending, commit } = fixture();
    controller.request((state) => ({ ...state, chat: false }));
    pending.slice().forEach((motion) => motion.finish());
    controller.revealCommitted();
    const staleEnter = pending.slice(3);
    controller.request((state) => ({ ...state, chat: true }));
    staleEnter.forEach((motion) => motion.finish());
    expect(controller.getPhase()).toBe('exit');
    pending.slice(6).forEach((motion) => motion.finish());
    expect(commit).toHaveBeenLastCalledWith({ chat: true, tools: false, sidebar: true });
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('commits reduced-motion paths synchronously without timers or artificial delay', () => {
    const { controller, commit, pending } = fixture({ immediate: true });
    controller.request((state) => ({ ...state, chat: false, tools: true }));
    expect(commit).toHaveBeenCalledOnce();
    expect(pending).toHaveLength(3);
    controller.revealCommitted();
    expect(controller.getPhase()).toBe('idle');
    expect(pending).toHaveLength(6);
  });

  it('does not strand the state when no surface is mounted', () => {
    const { controller, commit, surfaces } = fixture();
    surfaces([]);
    controller.request((state) => ({ ...state, tools: true }));
    expect(commit).toHaveBeenCalledOnce();
    controller.revealCommitted();
    expect(controller.getPhase()).toBe('idle');
  });

  it('does not restart a transition when selecting another tool with the same layout', () => {
    const { controller, pending, commit } = fixture();
    controller.request((state) => ({ ...state, tools: true }));
    controller.request((state) => ({ ...state, tools: true }));
    expect(pending).toHaveLength(3);
    pending.slice().forEach((motion) => motion.finish());
    expect(commit).toHaveBeenCalledOnce();
  });

  it('releases every animation and rejects future/stale callbacks after disposal', () => {
    const { controller, pending, commit } = fixture();
    controller.request((state) => ({ ...state, tools: true }));
    controller.dispose();
    pending.slice().forEach((motion) => motion.finish());
    controller.request((state) => ({ ...state, chat: false }));
    controller.revealCommitted();
    expect(commit).not.toHaveBeenCalled();
    expect(pending).toHaveLength(3);
    expect(pending.every((motion) => motion.cancel.mock.calls.length === 1)).toBe(true);
  });
});

