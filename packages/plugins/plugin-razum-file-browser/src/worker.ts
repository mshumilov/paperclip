import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

const PLUGIN_NAME = "razum-file-browser";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH_LIKE_PATTERN = /[\\/]/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

function looksLikePath(value: string): boolean {
  const normalized = value.trim();
  return (PATH_LIKE_PATTERN.test(normalized) || WINDOWS_DRIVE_PATH_PATTERN.test(normalized))
    && !UUID_PATTERN.test(normalized);
}

function sanitizeWorkspacePath(pathValue: string): string {
  return looksLikePath(pathValue) ? pathValue.trim() : "";
}

function resolveWorkspace(workspacePath: string, requestedPath?: string): string | null {
  const root = path.resolve(workspacePath);
  const resolved = requestedPath ? path.resolve(root, requestedPath) : root;
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

const FILE_PATH_REGEX = /(?:^|[\s(`"'])([^\s,;)}`"'>\]]*\/[^\s,;)}`"'>\]]+|[.\/~][^\s,;)}`"'>\]]+|[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,10}(?:\/[^\s,;)}`"'>\]]+)?)/g;
const FILE_EXTENSION_REGEX = /\.[a-zA-Z0-9]{1,10}$/;
const URL_ROUTE_PATTERN = /^\/(?:projects|issues|agents|settings|dashboard|plugins|api|auth|admin)\b/i;

function extractFilePaths(body: string): string[] {
  const paths = new Set<string>();
  for (const match of body.matchAll(FILE_PATH_REGEX)) {
    const raw = match[1];
    const cleaned = raw.replace(/[.:,;!?)]+$/, "");
    if (cleaned.length <= 1) continue;
    if (!FILE_EXTENSION_REGEX.test(cleaned)) continue;
    if (URL_ROUTE_PATTERN.test(cleaned)) continue;
    paths.add(cleaned);
  }
  return [...paths];
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    ctx.data.register("plugin-config", async () => {
      const config = await ctx.config.get();
      return {
        showFilesInSidebar: config?.showFilesInSidebar === true,
        commentAnnotationMode: config?.commentAnnotationMode ?? "both",
      };
    });

    ctx.data.register("comment-file-links", async (params: Record<string, unknown>) => {
      const commentId = typeof params.commentId === "string" ? params.commentId : "";
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!commentId || !issueId || !companyId) return { links: [] };
      try {
        const comments = await ctx.issues.listComments(issueId, companyId);
        const comment = comments.find((c) => c.id === commentId);
        if (!comment?.body) return { links: [] };
        return { links: extractFilePaths(comment.body) };
      } catch (err) {
        ctx.logger.warn("Failed to fetch comment for file link extraction", { commentId, error: String(err) });
        return { links: [] };
      }
    });

    ctx.data.register("workspaces", async (params: Record<string, unknown>) => {
      const projectId = params.projectId as string;
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!projectId || !companyId) return [];
      const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
      return workspaces.map((w) => ({
        id: w.id,
        projectId: w.projectId,
        name: w.name,
        path: sanitizeWorkspacePath(w.path),
        isPrimary: w.isPrimary,
      }));
    });

    ctx.data.register(
      "fileList",
      async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string;
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const workspaceId = params.workspaceId as string;
        const directoryPath = typeof params.directoryPath === "string" ? params.directoryPath : "";
        if (!projectId || !companyId || !workspaceId) return { entries: [] };
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) return { entries: [] };
        const workspacePath = sanitizeWorkspacePath(workspace.path);
        if (!workspacePath) return { entries: [] };
        const dirPath = resolveWorkspace(workspacePath, directoryPath);
        if (!dirPath) {
          return { entries: [] };
        }
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
          return { entries: [] };
        }
        const names = fs.readdirSync(dirPath).sort((a, b) => a.localeCompare(b));
        const entries = names.map((name) => {
          const full = path.join(dirPath, name);
          const stat = fs.lstatSync(full);
          const relativePath = path.relative(workspacePath, full);
          return {
            name,
            path: relativePath,
            isDirectory: stat.isDirectory(),
          };
        }).sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return { entries };
      },
    );

    ctx.data.register(
      "fileContent",
      async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string;
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const workspaceId = params.workspaceId as string;
        const filePath = params.filePath as string;
        if (!projectId || !companyId || !workspaceId || !filePath) {
          return { content: null, error: "Missing file context" };
        }
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) return { content: null, error: "Workspace not found" };
        const workspacePath = sanitizeWorkspacePath(workspace.path);
        if (!workspacePath) return { content: null, error: "Workspace has no path" };
        const fullPath = resolveWorkspace(workspacePath, filePath);
        if (!fullPath) {
          return { content: null, error: "Path outside workspace" };
        }
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          return { content };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: null, error: message };
        }
      },
    );

    // --- Actions ---

    ctx.actions.register(
      "writeFile",
      async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string;
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const workspaceId = params.workspaceId as string;
        const filePath = typeof params.filePath === "string" ? params.filePath.trim() : "";
        if (!filePath) throw new Error("filePath must be a non-empty string");
        const content = typeof params.content === "string" ? params.content : null;
        if (!projectId || !companyId || !workspaceId) throw new Error("Missing workspace context");
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) throw new Error("Workspace not found");
        const workspacePath = sanitizeWorkspacePath(workspace.path);
        if (!workspacePath) throw new Error("Workspace has no path");
        if (content === null) throw new Error("Missing file content");
        const fullPath = resolveWorkspace(workspacePath, filePath);
        if (!fullPath) throw new Error("Path outside workspace");
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) throw new Error("Selected path is not a file");
        fs.writeFileSync(fullPath, content, "utf-8");
        return { ok: true, path: filePath, bytes: Buffer.byteLength(content, "utf-8") };
      },
    );

    ctx.actions.register(
      "createFile",
      async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string;
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const workspaceId = params.workspaceId as string;
        const filePath = typeof params.filePath === "string" ? params.filePath.trim() : "";
        if (!filePath) throw new Error("filePath must be a non-empty string");
        if (!projectId || !companyId || !workspaceId) throw new Error("Missing workspace context");
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) throw new Error("Workspace not found");
        const workspacePath = sanitizeWorkspacePath(workspace.path);
        if (!workspacePath) throw new Error("Workspace has no path");
        const fullPath = resolveWorkspace(workspacePath, filePath);
        if (!fullPath) throw new Error("Path outside workspace");
        if (fs.existsSync(fullPath)) throw new Error("File already exists");
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        const content = typeof params.content === "string" ? params.content : "";
        fs.writeFileSync(fullPath, content, "utf-8");
        return { ok: true, path: filePath, bytes: Buffer.byteLength(content, "utf-8") };
      },
    );

    ctx.actions.register(
      "deleteFile",
      async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string;
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const workspaceId = params.workspaceId as string;
        const filePath = typeof params.filePath === "string" ? params.filePath.trim() : "";
        if (!filePath) throw new Error("filePath must be a non-empty string");
        if (!projectId || !companyId || !workspaceId) throw new Error("Missing workspace context");
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) throw new Error("Workspace not found");
        const workspacePath = sanitizeWorkspacePath(workspace.path);
        if (!workspacePath) throw new Error("Workspace has no path");
        const fullPath = resolveWorkspace(workspacePath, filePath);
        if (!fullPath) throw new Error("Path outside workspace");
        if (!fs.existsSync(fullPath)) throw new Error("File does not exist");
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) throw new Error("Selected path is not a file");
        fs.unlinkSync(fullPath);
        return { ok: true, path: filePath };
      },
    );

    ctx.actions.register(
      "deleteDirectory",
      async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string;
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const workspaceId = params.workspaceId as string;
        const dirPath = typeof params.dirPath === "string" ? params.dirPath.trim() : "";
        if (!dirPath) throw new Error("dirPath must be a non-empty string");
        if (!projectId || !companyId || !workspaceId) throw new Error("Missing workspace context");
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) throw new Error("Workspace not found");
        const workspacePath = sanitizeWorkspacePath(workspace.path);
        if (!workspacePath) throw new Error("Workspace has no path");
        const fullPath = resolveWorkspace(workspacePath, dirPath);
        if (!fullPath) throw new Error("Path outside workspace");
        if (fullPath === path.resolve(workspacePath)) throw new Error("Cannot delete workspace root");
        if (!fs.existsSync(fullPath)) throw new Error("Directory does not exist");
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) throw new Error("Selected path is not a directory");
        fs.rmSync(fullPath, { recursive: true });
        return { ok: true, path: dirPath };
      },
    );

    ctx.actions.register(
      "rename",
      async (params: Record<string, unknown>) => {
        const projectId = params.projectId as string;
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const workspaceId = params.workspaceId as string;
        const oldPath = typeof params.oldPath === "string" ? params.oldPath.trim() : "";
        const newName = typeof params.newName === "string" ? params.newName.trim() : "";
        if (!oldPath) throw new Error("oldPath must be a non-empty string");
        if (!newName) throw new Error("newName must be a non-empty string");
        if (newName.includes("/") || newName.includes("\\")) throw new Error("newName must not contain path separators");
        if (!projectId || !companyId || !workspaceId) throw new Error("Missing workspace context");
        const workspaces = await ctx.projects.listWorkspaces(projectId, companyId);
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) throw new Error("Workspace not found");
        const workspacePath = sanitizeWorkspacePath(workspace.path);
        if (!workspacePath) throw new Error("Workspace has no path");
        const fullOldPath = resolveWorkspace(workspacePath, oldPath);
        if (!fullOldPath) throw new Error("Source path outside workspace");
        if (!fs.existsSync(fullOldPath)) throw new Error("Source does not exist");
        const parentDir = path.dirname(fullOldPath);
        const fullNewPath = path.join(parentDir, newName);
        const resolvedNew = resolveWorkspace(workspacePath, path.relative(workspacePath, fullNewPath));
        if (!resolvedNew) throw new Error("Destination path outside workspace");
        if (fs.existsSync(fullNewPath)) throw new Error("Destination already exists");
        fs.renameSync(fullOldPath, fullNewPath);
        const newRelative = path.relative(workspacePath, fullNewPath);
        return { ok: true, oldPath, newPath: newRelative };
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
