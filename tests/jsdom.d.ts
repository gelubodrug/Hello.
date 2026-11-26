// jsdom ships no types and @types/jsdom is not a dependency: what the Unclutter
// tests use of it, and no more.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; runScripts?: 'dangerously' | 'outside-only' });
    readonly window: Window & typeof globalThis & { eval(code: string): unknown; close(): void };
  }
}
