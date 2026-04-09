import path from "node:path";

export * from "./scheduler-model.js";

/**
 * Resolve working directory: workspace root or a safe subdirectory.
 */
export function resolveWorkingDirectory(workspacePath: string, cwdSubdir: string): string {
  const root = path.resolve(workspacePath);
  if (!cwdSubdir) return root;
  const resolved = path.resolve(root, cwdSubdir);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("cwdSubdir escapes workspace root");
  }
  return resolved;
}
