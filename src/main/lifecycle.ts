/** Attempt every release even if one subsystem fails. Never return secret-bearing errors. */
export async function disposeInOrder(services: Array<{ name: string; dispose(): void | Promise<void> }>): Promise<string[]> {
  const failures: string[] = [];
  for (const service of services) {
    try { await service.dispose(); }
    catch { failures.push(service.name); }
  }
  return failures;
}
