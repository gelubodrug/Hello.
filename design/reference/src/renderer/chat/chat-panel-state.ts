export type ChatPresentation = 'floating' | 'pinned';

export interface ChatPanelState {
  presentation: ChatPresentation;
  minimized: boolean;
  expanded: boolean;
}

export type ChatPanelAction = 'toggle-pin' | 'toggle-minimize' | 'toggle-expand' | 'restore';

export const CHAT_PRESENTATION_KEY = 'hello.chat-presentation.v1';

export function initialChatPanelState(presentation: ChatPresentation = 'floating'): ChatPanelState {
  return { presentation, minimized: false, expanded: false };
}

export function chatPanelReducer(state: ChatPanelState, action: ChatPanelAction): ChatPanelState {
  switch (action) {
    case 'toggle-pin':
      return initialChatPanelState(state.presentation === 'floating' ? 'pinned' : 'floating');
    case 'toggle-minimize':
      return { ...state, minimized: !state.minimized };
    case 'toggle-expand':
      return { ...state, minimized: false, expanded: !state.expanded };
    case 'restore':
      return { ...state, minimized: false };
  }
}

export function loadChatPresentation(): ChatPresentation {
  try {
    return localStorage.getItem(CHAT_PRESENTATION_KEY) === 'pinned' ? 'pinned' : 'floating';
  } catch {
    return 'floating';
  }
}

export function saveChatPresentation(presentation: ChatPresentation): void {
  try {
    localStorage.setItem(CHAT_PRESENTATION_KEY, presentation);
  } catch {
    // A private/unavailable store must not prevent a layout change.
  }
}
