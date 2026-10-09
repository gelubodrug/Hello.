/** Only work shutdown will interrupt belongs in the close warning. */
export function closeWarning(terminals: number, replies: number): { message: string; detail: string } | null {
  if (!terminals && !replies) return null;
  const running = [
    ...(terminals ? [`${terminals} terminal ${terminals === 1 ? 'session' : 'sessions'}`] : []),
    ...(replies ? [`${replies} ${replies === 1 ? 'reply' : 'replies'}`] : []),
  ];
  return {
    message: `${running.join(' and ')} ${terminals + replies === 1 ? 'is' : 'are'} still running.`,
    detail: `Closing the application will stop ${terminals && replies ? 'these processes and replies' : terminals ? 'these processes' : 'these replies'}. Your chats and notebooks are saved.`,
  };
}

/** Attempt every release even if one subsystem fails. Never return secret-bearing errors. */
export async function disposeInOrder(services: Array<{ name: string; dispose(): void | Promise<void> }>): Promise<string[]> {
  const failures: string[] = [];
  for (const service of services) {
    try { await service.dispose(); }
    catch { failures.push(service.name); }
  }
  return failures;
}
