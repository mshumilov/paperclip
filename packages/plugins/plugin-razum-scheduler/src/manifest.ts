import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/** Must match `JOB_KEY` in `scheduler-config.ts` (manifest bundle cannot import that module). */
const MANIFEST_JOB_KEY = "workspace-command";

const manifest: PaperclipPluginManifestV1 = {
  id: "plugin-razum-scheduler",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Razum scheduler",
  description:
    "Runs any shell command on a timer in a project workspace. Host fires the job every minute; intervalMinutes throttles how often the command actually runs.",
  author: "Mikhail Shumilov",
  categories: ["automation", "workspace"],
  capabilities: [
    "jobs.schedule",
    "projects.read",
    "project.workspaces.read",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      companyId: {
        type: "string",
        title: "Company ID",
        description: "UUID of the company that owns the project.",
      },
      projectId: {
        type: "string",
        title: "Project ID",
        description: "UUID of the project whose workspace path will be used as cwd.",
      },
      workspaceName: {
        type: "string",
        title: "Workspace name",
        description: "Match Paperclip workspace display name (e.g. pclip-workspace). Leave empty to use the primary workspace.",
        default: "",
      },
      cwdSubdir: {
        type: "string",
        title: "Subdirectory (optional)",
        description: "Relative path under the workspace root for cwd (must not escape the workspace).",
        default: "",
      },
      command: {
        type: "string",
        title: "Command",
        description: "Full shell command to run in that directory (e.g. npm run sync-incoming).",
        default: "npm run sync-incoming",
      },
      intervalMinutes: {
        type: "integer",
        title: "Minimum interval (minutes)",
        description: "For scheduled runs only: skip if the last successful scheduled run was less than this many minutes ago. Manual runs always execute.",
        minimum: 1,
        maximum: 10080,
        default: 1,
      },
    },
    required: ["companyId", "projectId", "command"],
  },
  jobs: [
    {
      jobKey: MANIFEST_JOB_KEY,
      displayName: "Workspace command",
      description: "Executes the configured shell command in the selected workspace.",
      schedule: "* * * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "razum-scheduler-health",
        displayName: "Razum scheduler",
        exportName: "DashboardWidget",
      },
    ],
  },
};

export default manifest;
