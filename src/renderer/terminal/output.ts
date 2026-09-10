import type { TerminalAttach, TerminalData } from "../../shared/types";

const MAX_PENDING = 1024 * 1024;
const OMITTED =
  "\r\n[terminal: earlier output omitted during a large burst]\r\n";
function bounded(text: string): string {
  return text.length <= MAX_PENDING
    ? text
    : OMITTED + text.slice(-(MAX_PENDING - OMITTED.length));
}

/** Joins a main-process snapshot to live events without duplicated or missed output. */
export function createTerminalOutput(
  write: (data: string, done: () => void) => void,
) {
  let sequence: number | null = null;
  let buffered: TerminalData[] = [];
  let bufferedChars = 0;
  let pending = "";
  let writing = false;
  let disposed = false;
  const drain = (): void => {
    if (disposed || writing || !pending) return;
    const data = pending;
    pending = "";
    writing = true;
    write(data, () => {
      writing = false;
      drain();
    });
  };
  const append = (data: string): void => {
    if (disposed) return;
    pending = bounded(pending + data);
    drain();
  };
  const receive = (event: TerminalData): void => {
    if (disposed) return;
    if (sequence === null) {
      buffered.push(event);
      bufferedChars += event.data.length;
      while (bufferedChars > MAX_PENDING && buffered.length > 1)
        bufferedChars -= buffered.shift()!.data.length;
      if (bufferedChars > MAX_PENDING) {
        buffered[0] = { ...event, data: bounded(event.data) };
        bufferedChars = buffered[0].data.length;
      }
      return;
    }
    if (event.sequence <= sequence) return;
    sequence = event.sequence;
    append(event.data);
  };
  return {
    receive,
    attach(snapshot: Pick<TerminalAttach, "scrollback" | "sequence">): void {
      if (disposed) return;
      sequence = snapshot.sequence;
      append(snapshot.scrollback);
      for (const event of buffered) receive(event);
      buffered = [];
      bufferedChars = 0;
    },
    append,
    dispose(): void {
      disposed = true;
      pending = "";
      buffered = [];
    },
  };
}
