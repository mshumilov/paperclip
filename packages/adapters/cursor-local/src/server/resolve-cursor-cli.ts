import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * When the adapter is configured with the default `agent` command, resolve it to a concrete
 * executable if the Cursor CLI was installed to the usual locations (Docker volume + installer).
 */
export async function resolveCursorCliCommand(command: string, homeDir: string): Promise<string> {
  const trimmed = command.trim();
  if (trimmed !== "agent") return trimmed;
  const candidates = [
    "/paperclip/.local/bin/agent",
    "/usr/local/bin/agent",
    path.join(homeDir, ".local/bin/agent"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return trimmed;
}
