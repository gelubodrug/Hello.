import { describe, expect, it, vi } from "vitest";
import { createTerminalOutput } from "../src/renderer/terminal/output";

describe("terminal snapshot and live output reconciliation", () => {
  it("replays only live chunks newer than the snapshot, exactly once and in order", () => {
    const writes: string[] = [];
    const output = createTerminalOutput((data, done) => {
      writes.push(data);
      done();
    });
    output.receive({ id: "one", data: "already snapshotted", sequence: 1 });
    output.receive({ id: "one", data: "new output", sequence: 2 });
    expect(writes).toEqual([]);
    output.attach({ scrollback: "history", sequence: 1 });
    expect(writes).toEqual(["history", "new output"]);
    output.receive({ id: "one", data: "stale", sequence: 1 });
    output.receive({ id: "one", data: "duplicate", sequence: 2 });
    output.receive({ id: "one", data: "latest", sequence: 3 });
    expect(writes).toEqual(["history", "new output", "latest"]);
  });

  it("bounds output waiting for the xterm parser instead of accumulating an unbounded hidden queue", () => {
    const writes: Array<{ data: string; done: () => void }> = [];
    const output = createTerminalOutput((data, done) =>
      writes.push({ data, done }),
    );
    output.attach({ scrollback: "history", sequence: 0 });
    for (let sequence = 1; sequence <= 40; sequence++)
      output.receive({ id: "one", data: "x".repeat(256 * 1024), sequence });
    output.receive({ id: "one", data: "\nlast line", sequence: 41 });
    expect(writes).toHaveLength(1);
    writes[0].done();
    expect(writes).toHaveLength(2);
    expect(writes[1].data.length).toBeLessThanOrEqual(1024 * 1024);
    expect(writes[1].data).toContain("earlier output omitted");
    expect(writes[1].data).toContain("last line");
  });

  it("does not write or resume parsing after the exact host has been disposed", () => {
    const write = vi.fn<(data: string, done: () => void) => void>();
    const output = createTerminalOutput(write);
    output.attach({ scrollback: "first", sequence: 0 });
    output.receive({ id: "one", data: "queued", sequence: 1 });
    output.dispose();
    write.mock.calls[0][1]();
    output.receive({ id: "one", data: "too late", sequence: 2 });
    output.attach({ scrollback: "too late", sequence: 3 });
    expect(write).toHaveBeenCalledOnce();
  });
});
