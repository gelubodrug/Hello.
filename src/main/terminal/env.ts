// Adapted from the old terminal/env.ts and coder/binary.ts; no app/store inheritance.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const TERMINAL_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TZ",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSH_AUTH_SOCK",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
] as const;

export function augmentedPath(
  source: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const system =
    process.platform === "win32"
      ? []
      : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const extra =
    process.platform === "win32"
      ? []
      : [
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
          "/usr/local/sbin",
          join(home, ".local", "bin"),
          join(home, ".cargo", "bin"),
          join(home, ".bun", "bin"),
          join(home, ".kimi-code", "bin"),
        ];
  const inherited = (source.PATH ?? "").split(delimiter).filter(isAbsolute);
  return [
    ...new Set([
      ...inherited,
      ...system,
      ...extra.filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      }),
    ]),
  ].join(delimiter);
}

export function terminalEnv(
  source: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of TERMINAL_ENV_ALLOWLIST) {
    if (source[name]) env[name] = source[name]!;
  }
  env.HOME ??= home;
  env.PATH = augmentedPath(source, home);
  env.LANG ??= "en_US.UTF-8";
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.FORCE_COLOR = "1";
  return env;
}

export function resolveTerminalShell(source: NodeJS.ProcessEnv = process.env): {
  file: string;
  args: string[];
} {
  if (process.platform === "win32")
    return { file: source.ComSpec || "cmd.exe", args: [] };
  return {
    file:
      source.SHELL && isAbsolute(source.SHELL)
        ? source.SHELL
        : process.platform === "darwin"
          ? "/bin/zsh"
          : "/bin/bash",
    args: ["-l"],
  };
}
