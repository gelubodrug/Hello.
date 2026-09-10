import { createStore } from 'zustand/vanilla';

import type {
  AiModeConfig,
  ShellGrant,
  Api,
  SystemPreferences,
  WebSearchSettings,
} from '../../shared/ipc-contract';
import { clampSidebarWidth, SIDEBAR_LAYOUT } from '../../shared/ipc-contract';
import { loadBrowserOpenState, saveBrowserOpenState } from '../app/browser-split';
import { loadTerminalOpen, saveTerminalOpen } from '../terminal/dock-state';
import type { ThemePreference } from '../../shared/types';

export type ResolvedTheme = 'light' | 'dark';

export interface SettingsState {
  /** Developer-only affordances, intentionally not persisted. */
  browserPaneDevTools: boolean;
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  reducedMotion: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  /** Live width while the resize handle is dragged (T135), or null at rest.
   * The docked panel and the conversation column read the same value, so the
   * chat offset follows the pointer instead of jumping on release. Session
   * state, intentionally not persisted. */
  sidebarDragWidth: number | null;
  /** Whether the sidebar's conversation-search row is revealed (T126). Both
   * the titlebar band's Search control and the sidebar's own Search ghost
   * flip it; it is session state, intentionally not persisted. */
  conversationSearchOpen: boolean;
  /** Set to request that the composer's model chip open its popover — the
   * channel the stream-failure banner's "Switch model…" action uses
   * (DESIGNUIguide.md §Errors: never a second embedded selector). The chip
   * clears it as it opens. Session state, intentionally not persisted. */
  modelPopoverRequested: boolean;
  activeEndpointId: string | null;
  activeModelId: string | null;
  /** Whether the web-search tool may run (T137). Off by default; persisted. */
  webSearchEnabled: boolean;
  /**
   * Whether the feature is both enabled *and* pointed at a usable provider
   * URL. An enabled-but-unconfigured feature behaves exactly like a disabled
   * one, so surfaces gate on this, not on `webSearchEnabled` alone.
   */
  webSearchConfigured: boolean;
  /**
   * Which kind of work this window is doing: an ordinary chat, or a coding
   * session driven by a headless agent. It changes what a message means, so
   * it lives beside the other session-wide choices rather than in a menu.
   */
  appMode: AppMode;
  /** Terminal access: off, granted for a day, or until revoked. */
  shellGrant: ShellGrant;
  /** When a day-grant started, for the "expires" line. */
  shellGrantedAt: number | null;
  /** The one folder commands run in; null until the user picks one. */
  shellRoot: string | null;
  /**
   * The user's own terminal — a different thing from `shellGrant` above, which
   * is the model's permission to run a command inside `shellRoot`. Opening a
   * shell yourself needs no grant, so this only says whether the drawer offers
   * one at all.
   */
  terminalEnabled: boolean;
  /**
   * Whether a pty can be opened here: true/false once main has answered,
   * `null` until it does — which includes the call having failed and never
   * answering at all (DESIGNUIguide.md §State pills). `false` is a verdict
   * about the user's machine and may only be shown once main has given one.
   */
  terminalAvailable: boolean | null;
  /** Why not, shown verbatim. Null while nothing is wrong. */
  terminalUnavailableReason: string | null;
  /** Whether the drawer is showing. Persisted per window, like the browser split. */
  terminalOpen: boolean;
  /**
   * Which terminal session the drawer is attached to, or null for "whichever
   * one is already running". Set by reopening a project's terminal from the
   * sidebar; session state, intentionally not persisted.
   */
  activeTerminalId: string | null;
  /** Whether the interactive coding CLI has its own side pane visible. */
  cliWorkerOpen: boolean;
  /** The CLI-worker PTY shown in that pane; never reused by the plain terminal. */
  activeCliWorkerSessionId: string | null;
  /**
   * Bumped on every `setActive…` call, even one that names the session that
   * is already active. The shell reveals a session in reaction to these
   * setters, and "open the one I clicked" must work on the second click too —
   * with only the id to watch, a repeat click was not a change and did nothing.
   */
  sessionRevealSeq: number;
  /** Whether the browser pane is showing. Persisted, like the drawer above. */
  browserOpen: boolean;
  /**
   * Whether the chat column is showing. Closing it hides the column and
   * nothing else — the conversation stays selected and stays listed, and
   * choosing a chat in the sidebar brings the column back.
   */
  chatOpen: boolean;
  /** Legacy persisted gate; effective browser permission lives on each tab. */
  aiModeEnabled: boolean;
  /** Legacy persisted action gate retained for config compatibility. */
  aiModeAllowActions: boolean;
  setTheme: (theme: ThemePreference) => void;
  setReducedMotion: (reducedMotion: boolean) => void;
  setBrowserPaneDevTools: (enabled: boolean) => void;
  setSidebarCollapsed: (sidebarCollapsed: boolean) => void;
  setSidebarWidth: (sidebarWidth: number) => void;
  setSidebarDragWidth: (sidebarDragWidth: number | null) => void;
  toggleSidebarCollapsed: () => void;
  setConversationSearchOpen: (conversationSearchOpen: boolean) => void;
  setModelPopoverRequested: (modelPopoverRequested: boolean) => void;
  setActiveEndpointId: (activeEndpointId: string | null) => void;
  setActiveModelId: (activeModelId: string | null) => void;
  setWebSearchEnabled: (webSearchEnabled: boolean) => void;
  setAppMode: (mode: AppMode) => void;
  setShellGrant: (grant: ShellGrant) => void;
  /**
   * Opens the native folder picker and stores the choice as the last project.
   * Naming a conversation moves that conversation there as well; resolves to
   * the folder chosen, or null when the picker was dismissed.
   */
  chooseShellRoot: (conversationId?: string | null) => Promise<string | null>;
  setAiModeEnabled: (aiModeEnabled: boolean) => void;
  setAiModeAllowActions: (aiModeAllowActions: boolean) => void;
  setTerminalEnabled: (terminalEnabled: boolean) => void;
  setTerminalOpen: (terminalOpen: boolean) => void;
  toggleTerminal: () => void;
  setActiveTerminalId: (activeTerminalId: string | null) => void;
  setCliWorkerOpen: (cliWorkerOpen: boolean) => void;
  setActiveCliWorkerSessionId: (activeCliWorkerSessionId: string | null) => void;
  setBrowserOpen: (browserOpen: boolean) => void;
  toggleBrowser: () => void;
  setChatOpen: (chatOpen: boolean) => void;
}

type SettingsStore = ReturnType<typeof createSettingsStore>;
type SettingsSystemApi = Pick<
  Api['system'],
  'getPreferences' | 'onPreferencesChanged' | 'setPreferences'
>;
type SettingsWebSearchApi = Pick<Api['websearch'], 'getSettings' | 'setSettings'>;
type SettingsAiModeApi = Pick<Api['aimode'], 'getSettings' | 'setSettings'>;
type SettingsShellApi = Pick<Api['shell'], 'getSettings' | 'setSettings' | 'chooseRoot'>;
type SettingsTerminalApi = Pick<Api['terminal'], 'getSettings' | 'setSettings'>;

/** The two kinds of session this window can be in. */
export type AppMode = 'chat' | 'coder';

const APP_MODE_KEY = 'app-mode';

function readStoredMode(): AppMode {
  try {
    return window.localStorage.getItem(APP_MODE_KEY) === 'coder' ? 'coder' : 'chat';
  } catch {
    return 'chat';
  }
}

const CHAT_OPEN_KEY = 'chat-column-open';

/** Open unless it was explicitly closed: the chat column is the default view. */
function readChatOpen(): boolean {
  try {
    return window.localStorage.getItem(CHAT_OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function writeChatOpen(open: boolean): void {
  try {
    window.localStorage.setItem(CHAT_OPEN_KEY, open ? 'open' : 'closed');
  } catch {
    // A window without storage keeps the choice for this session only.
  }
}

const DEFAULT_THEME: ThemePreference = 'system';
const THEME_COLOR_LIGHT = '#f7f7f8';
const THEME_COLOR_DARK = '#1e1e20';

let systemColorSchemeQuery: MediaQueryList | null = null;
let systemColorSchemeListener: ((event: MediaQueryListEvent) => void) | null = null;

function getSystemApi(): SettingsSystemApi | null {
  if (typeof window === 'undefined' || !('api' in window)) {
    return null;
  }

  return window.api.system;
}

function getShellApi(): SettingsShellApi | null {
  if (typeof window === 'undefined' || !('api' in window)) {
    return null;
  }

  return window.api.shell ?? null;
}

function getTerminalApi(): SettingsTerminalApi | null {
  if (typeof window === 'undefined' || !('api' in window)) {
    return null;
  }

  return window.api.terminal ?? null;
}

function getAiModeApi(): SettingsAiModeApi | null {
  if (typeof window === 'undefined' || !('api' in window)) {
    return null;
  }

  return window.api.aimode ?? null;
}

function getWebSearchApi(): SettingsWebSearchApi | null {
  if (typeof window === 'undefined' || !('api' in window)) {
    return null;
  }

  return window.api.websearch ?? null;
}

/** Mirrors the main-side rule: enabled only counts with a usable http(s) URL. */
function isWebSearchConfigured(settings: Pick<WebSearchSettings, 'enabled' | 'baseUrl'>): boolean {
  if (!settings.enabled) {
    return false;
  }

  try {
    const parsed = new URL(settings.baseUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getSystemColorScheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveThemePreference(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') {
    return getSystemColorScheme();
  }

  return preference;
}

function applyThemeToDocument(preference: ThemePreference, resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;

  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', resolved === 'dark' ? THEME_COLOR_DARK : THEME_COLOR_LIGHT);
  }
}

function applyThemeState(store: SettingsStore, preference: ThemePreference): void {
  const resolved = resolveThemePreference(preference);
  store.setState({ resolvedTheme: resolved });
  applyThemeToDocument(preference, resolved);
}

function attachSystemColorSchemeListener(store: SettingsStore): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return;
  }

  const query = window.matchMedia('(prefers-color-scheme: dark)');

  const onChange = (): void => {
    if (store.getState().theme !== 'system') {
      return;
    }

    applyThemeState(store, 'system');
  };

  if (systemColorSchemeQuery && systemColorSchemeListener) {
    systemColorSchemeQuery.removeEventListener('change', systemColorSchemeListener);
  }

  systemColorSchemeQuery = query;
  systemColorSchemeListener = onChange;
  query.addEventListener('change', onChange);
}

function applyPreferences(store: SettingsStore, preferences: SystemPreferences): void {
  store.setState({
    theme: preferences.theme,
    reducedMotion: preferences.reducedMotion,
    sidebarCollapsed: preferences.sidebarCollapsed,
    sidebarWidth: clampSidebarWidth(preferences.sidebarWidth),
  });
  applyThemeState(store, preferences.theme);
}

function persistSidebarPreferences(
  patch: Partial<Pick<SystemPreferences, 'sidebarCollapsed' | 'sidebarWidth'>>,
): void {
  const api = getSystemApi();
  if (api) {
    void api.setPreferences(patch);
  }
}

function hydrateSettingsStore(store: SettingsStore, systemApi: SettingsSystemApi | null): void {
  if (!systemApi) {
    return;
  }

  void systemApi.getPreferences().then((result) => {
    if (result.ok) {
      applyPreferences(store, result.value);
    }
  });

  systemApi.onPreferencesChanged((preferences) => {
    applyPreferences(store, preferences);
  });
}

function hydrateWebSearchSettings(store: SettingsStore, api: SettingsWebSearchApi | null): void {
  if (!api) {
    return;
  }

  void api.getSettings().then((result) => {
    if (result.ok) {
      store.setState({
        webSearchEnabled: result.value.enabled,
        webSearchConfigured: isWebSearchConfigured(result.value),
      });
    }
  });
}

/** Writes an AI Mode patch through and re-syncs from the normalized answer. */
function persistAiMode(store: SettingsStore, patch: Partial<AiModeConfig>): void {
  const api = getAiModeApi();
  if (!api) {
    return;
  }

  void api.setSettings(patch).then((result) => {
    if (result.ok) {
      store.setState({
        aiModeEnabled: result.value.enabled,
        aiModeAllowActions: result.value.allowActions,
      });
    }
  });
}

function hydrateAiModeSettings(store: SettingsStore, api: SettingsAiModeApi | null): void {
  if (!api) {
    return;
  }

  void api.getSettings().then((result) => {
    if (result.ok) {
      store.setState({
        aiModeEnabled: result.value.enabled,
        aiModeAllowActions: result.value.allowActions,
      });
    }
  });
}

export function createSettingsStore(
  systemApi: SettingsSystemApi | null = getSystemApi(),
  webSearchApi: SettingsWebSearchApi | null = getWebSearchApi(),
  aiModeApi: SettingsAiModeApi | null = getAiModeApi(),
) {
  const store = createStore<SettingsState>()((set) => ({
    theme: DEFAULT_THEME,
    resolvedTheme: resolveThemePreference(DEFAULT_THEME),
    reducedMotion: false,
    browserPaneDevTools: false,
    sidebarCollapsed: false,
    sidebarWidth: SIDEBAR_LAYOUT.defaultWidth,
    sidebarDragWidth: null,
    conversationSearchOpen: false,
    modelPopoverRequested: false,
    activeEndpointId: null,
    activeModelId: null,
    webSearchEnabled: false,
    webSearchConfigured: false,
    appMode: readStoredMode(),
    shellGrant: 'off',
    shellGrantedAt: null,
    shellRoot: null,
    terminalEnabled: false,
    terminalAvailable: null,
    terminalUnavailableReason: null,
    terminalOpen: loadTerminalOpen(),
    activeTerminalId: null,
    cliWorkerOpen: false,
    activeCliWorkerSessionId: null,
    sessionRevealSeq: 0,
    browserOpen: loadBrowserOpenState(),
    chatOpen: readChatOpen(),
    aiModeEnabled: false,
    aiModeAllowActions: false,
    setTheme: (theme) => {
      set({ theme });
      applyThemeState(store, theme);

      const api = getSystemApi();
      if (api) {
        void api.setPreferences({ theme });
      }
    },
    setReducedMotion: (reducedMotion) => {
      set({ reducedMotion });

      const api = getSystemApi();
      if (api) {
        void api.setPreferences({ reducedMotion });
      }
    },
    setBrowserPaneDevTools: (enabled) => set({ browserPaneDevTools: enabled }),
    setSidebarCollapsed: (sidebarCollapsed) => {
      set({ sidebarCollapsed });
      persistSidebarPreferences({ sidebarCollapsed });
    },
    setSidebarWidth: (sidebarWidth) => {
      const nextWidth = clampSidebarWidth(sidebarWidth);
      set({ sidebarWidth: nextWidth });
      persistSidebarPreferences({ sidebarWidth: nextWidth });
    },
    setSidebarDragWidth: (sidebarDragWidth) => {
      set({
        sidebarDragWidth: sidebarDragWidth === null ? null : clampSidebarWidth(sidebarDragWidth),
      });
    },
    toggleSidebarCollapsed: () => {
      const nextCollapsed = !store.getState().sidebarCollapsed;
      store.getState().setSidebarCollapsed(nextCollapsed);
    },
    setConversationSearchOpen: (conversationSearchOpen) => set({ conversationSearchOpen }),
    setModelPopoverRequested: (modelPopoverRequested) => set({ modelPopoverRequested }),
    setActiveEndpointId: (activeEndpointId) => set({ activeEndpointId }),
    setActiveModelId: (activeModelId) => set({ activeModelId }),
    setAppMode: (appMode) => {
      set({ appMode });
      try {
        window.localStorage.setItem(APP_MODE_KEY, appMode);
      } catch {
        // A window without storage keeps the mode for this session only.
      }
    },

    setShellGrant: (shellGrant) => {
      set({ shellGrant });
      const api = getShellApi();
      void api?.setSettings({ grant: shellGrant }).then((result) => {
        if (result.ok) {
          set({
            shellGrant: result.value.grant,
            shellGrantedAt: result.value.grantedAt,
            shellRoot: result.value.root,
          });
        }
      });
    },

    chooseShellRoot: async (conversationId) => {
      const api = getShellApi();
      const result = await api?.chooseRoot(conversationId ?? undefined);
      if (result === undefined || !result.ok) {
        return null;
      }

      set({
        shellGrant: result.value.config.grant,
        shellGrantedAt: result.value.config.grantedAt,
        shellRoot: result.value.config.root,
      });
      return result.value.chosen;
    },

    setTerminalEnabled: (terminalEnabled) => {
      set({ terminalEnabled });
      // Turning it off has to take the drawer with it: a panel with no shell
      // behind it is exactly the placeholder affordance the guide forbids.
      if (!terminalEnabled) {
        store.getState().setTerminalOpen(false);
        store.getState().setCliWorkerOpen(false);
      }

      void getTerminalApi()
        ?.setSettings({ enabled: terminalEnabled })
        .then((result) => {
          if (result.ok) {
            set({
              terminalEnabled: result.value.enabled,
              terminalAvailable: result.value.available,
              terminalUnavailableReason: result.value.unavailableReason,
            });
          }
        });
    },

    setTerminalOpen: (terminalOpen) => {
      set({ terminalOpen });
      saveTerminalOpen(terminalOpen);
    },

    toggleTerminal: () => {
      const state = store.getState();
      if (!state.terminalEnabled) {
        return;
      }
      state.setTerminalOpen(!state.terminalOpen);
    },

    setActiveTerminalId: (activeTerminalId) =>
      set((state) => ({ activeTerminalId, sessionRevealSeq: state.sessionRevealSeq + 1 })),

    setCliWorkerOpen: (cliWorkerOpen) => set({ cliWorkerOpen }),

    setActiveCliWorkerSessionId: (activeCliWorkerSessionId) =>
      set((state) => ({
        activeCliWorkerSessionId,
        sessionRevealSeq: state.sessionRevealSeq + 1,
      })),

    setBrowserOpen: (browserOpen) => {
      set({ browserOpen });
      saveBrowserOpenState(browserOpen);
    },

    toggleBrowser: () => {
      store.getState().setBrowserOpen(!store.getState().browserOpen);
    },

    setChatOpen: (chatOpen) => {
      set({ chatOpen });
      writeChatOpen(chatOpen);
    },

    setAiModeEnabled: (aiModeEnabled) => {
      set({ aiModeEnabled });
      persistAiMode(store, { enabled: aiModeEnabled });
    },
    setAiModeAllowActions: (aiModeAllowActions) => {
      set({ aiModeAllowActions });
      persistAiMode(store, { allowActions: aiModeAllowActions });
    },
    setWebSearchEnabled: (webSearchEnabled) => {
      set({ webSearchEnabled });

      const api = getWebSearchApi();
      if (!api) {
        set({ webSearchConfigured: false });
        return;
      }

      void api.setSettings({ enabled: webSearchEnabled }).then((result) => {
        if (result.ok) {
          store.setState({
            webSearchEnabled: result.value.enabled,
            webSearchConfigured: isWebSearchConfigured(result.value),
          });
        }
      });
    },
  }));

  applyThemeState(store, DEFAULT_THEME);
  attachSystemColorSchemeListener(store);
  hydrateSettingsStore(store, systemApi);
  hydrateWebSearchSettings(store, webSearchApi);
  hydrateAiModeSettings(store, aiModeApi);

  void getTerminalApi()
    ?.getSettings()
    .then((result) => {
      if (result.ok) {
        store.setState({
          terminalEnabled: result.value.enabled,
          terminalAvailable: result.value.available,
          terminalUnavailableReason: result.value.unavailableReason,
          // A drawer remembered as open is only reopened when there is
          // something to open.
          terminalOpen: store.getState().terminalOpen && result.value.enabled,
        });
      }
    });

  const shellApi = getShellApi();
  void shellApi?.getSettings().then((result) => {
    if (result.ok) {
      store.setState({
        shellGrant: result.value.grant,
        shellGrantedAt: result.value.grantedAt,
        shellRoot: result.value.root,
      });
    }
  });

  return store;
}

export const settingsStore = createSettingsStore();

declare global {
  interface Window {
    api: Api;
  }
}
