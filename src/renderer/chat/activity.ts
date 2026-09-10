import type { MessagePart } from '../../shared/types';
import { readWebResult } from '../../shared/web';

const meaningful = (part: MessagePart) => part.type === 'tool' || Boolean(part.text.trim());

/** Commentary before/between actions stays in the original timeline. Only text
 * after the last activity part is presented as the answer, never rearranged. */
export function activityLayout(parts: readonly MessagePart[], streaming: boolean) {
  let lastActivity = -1;
  let lastMeaningful = -1;
  let steps = 0;
  let tools = 0;
  parts.forEach((part, index) => {
    if (!meaningful(part)) return;
    lastMeaningful = index;
    if (part.type !== 'text') { lastActivity = index; steps++; }
    if (part.type === 'tool') tools++;
  });
  return {
    activity: parts.slice(0, lastActivity + 1),
    answer: parts.slice(lastActivity + 1),
    answerStart: lastActivity + 1,
    grouped: tools > 0 || steps > 1,
    activeThinking: streaming && parts[lastMeaningful]?.type === 'thinking' ? lastMeaningful : -1,
  };
}

export function activitySummary(parts: readonly MessagePart[]) {
  let searches = 0;
  let completedTools = 0;
  let failed = 0;
  let approvals = 0;
  let unfinished = 0;
  let web = false;
  const pages = new Set<string>();
  for (const part of parts) {
    if (part.type !== 'tool') continue;
    if (part.status === 'error') failed++;
    if (part.status === 'approval') approvals++;
    if (part.status === 'running') unfinished++;
    const isWeb = part.name === 'web_search' || part.name === 'fetch_url';
    web ||= isWeb;
    const result = readWebResult(part);
    if (result?.kind === 'web_search') searches++;
    if (result?.kind === 'fetch_url') pages.add(result.source.url);
    if (!isWeb && part.status === 'complete') completedTools++;
  }
  const counts = [
    searches ? `${searches} ${searches === 1 ? 'search' : 'searches'}` : '',
    pages.size ? `${pages.size} ${pages.size === 1 ? 'page' : 'pages'} read` : '',
    completedTools ? `${completedTools} ${completedTools === 1 ? 'tool' : 'tools'}` : '',
  ].filter(Boolean).join(' · ');
  return { title: web ? 'Research' : 'Activity', counts, failed, approvals, unfinished };
}

export function suppliedDuration(durationMs: number | undefined): number | null {
  return durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}

export function thinkingTitle(active: boolean, durationMs?: number): string {
  if (active) return 'Thinking';
  const duration = suppliedDuration(durationMs);
  return duration === null ? 'Thought' : duration < 1000 ? 'Thought briefly' : `Thought ${Number((duration / 1000).toFixed(1))}s`;
}
