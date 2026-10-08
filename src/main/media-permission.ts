// The app window may open the microphone, and nothing else: no camera, no
// screen, no guest page, no frame inside the window. Voice turns record in the
// window's own renderer; every other permission request stays refused.

export type MediaGrantRequest = {
  permission: string;
  /** The request came from the app window's own webContents, not a guest. */
  fromAppWindow: boolean;
  isMainFrame: boolean;
  /** What the page asked to open. Empty or unknown means it did not say. */
  mediaTypes: readonly string[];
  requestingUrl: string;
};

/** Whether `url` is a page of the app itself — its scheme and host, never a path or port of another. */
export function isAppPage(url: string, appUrls: readonly string[]): boolean {
  let page: URL;
  try { page = new URL(url); } catch { return false; }
  return appUrls.some(candidate => {
    try {
      const app = new URL(candidate);
      return page.protocol === app.protocol && page.host === app.host;
    } catch { return false; }
  });
}

/** The one media grant: audio alone, asked by the app window's main frame, on an app page. */
export function allowsAppMicrophone(request: MediaGrantRequest, appUrls: readonly string[]): boolean {
  if (request.permission !== 'media') return false;
  if (!request.fromAppWindow || !request.isMainFrame) return false;
  if (!request.mediaTypes.length || request.mediaTypes.some(type => type !== 'audio')) return false;
  return isAppPage(request.requestingUrl, appUrls);
}
