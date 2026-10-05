import { nativeTheme, type BrowserWindow } from 'electron';
import type { AppSettings } from '../shared/types';

/** The window's ground before the page paints, from tokens.css --surface-sidebar
 *  in each theme, so opening shows no flash of the other one. */
const GROUND = { light: '#f1f1f1', dark: '#111111' } as const;

/** Where the app's look stands now: as chosen, or as macOS is (audit B2). */
export function appearanceGround(appearance: AppSettings['appearance']): string {
  nativeTheme.themeSource = appearance ?? 'system';
  return nativeTheme.shouldUseDarkColors ? GROUND.dark : GROUND.light;
}

/** Light, Dark or System, at once: native menus and the window's ground follow,
 *  and every page reads it as prefers-color-scheme. */
export function applyAppearance(window: BrowserWindow, appearance: AppSettings['appearance']): void {
  const ground = appearanceGround(appearance);
  if (!window.isDestroyed()) window.setBackgroundColor(ground);
}
