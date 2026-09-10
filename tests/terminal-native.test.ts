import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureSpawnHelperExecutable,
  probeNodePty,
  spawnHelperPath,
} from "../src/main/terminal/native";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("reused lazy native PTY probe", () => {
  it("reports unavailable native loading without crashing app startup", () => {
    const probe = probeNodePty(() => {
      throw new Error("native module unavailable");
    }, vi.fn());
    expect(probe).toMatchObject({
      ok: false,
      reason: expect.stringContaining("native module unavailable"),
    });
  });

  it("rejects a broken module without attempting a terminal spawn", () => {
    expect(
      probeNodePty(
        () => "/package/lib/index.js",
        () => ({}),
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no spawn()"),
    });
  });

  it("finds and repairs only the package helper in a disposable fake installation", () => {
    const root = mkdtempSync(join(tmpdir(), "hello-pty-probe-"));
    roots.push(root);
    const directory = join(root, "build/Release");
    mkdirSync(directory, { recursive: true });
    const helper = join(directory, "spawn-helper");
    writeFileSync(helper, "test fixture, never executed", { mode: 0o600 });
    expect(spawnHelperPath(root)).toBe(helper);
    expect(ensureSpawnHelperExecutable(helper)).toBeNull();
    expect(statSync(helper).mode & 0o111).toBe(0o111);
    const spawn = vi.fn();
    expect(
      probeNodePty(
        () => join(root, "lib/index.js"),
        () => ({ spawn }),
      ),
    ).toMatchObject({ ok: true });
    expect(spawn).not.toHaveBeenCalled();
  });
});
