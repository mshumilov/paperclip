import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/** Must match `JOB_KEY` in `scheduler-config.ts` (manifest bundle cannot import that module). */
const MANIFEST_JOB_KEY = "workspace-command";

const taskItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "companyId", "projectId", "command", "intervalMinutes"],
  properties: {
    id: { type: "string", minLength: 1, title: "Task id", description: "Stable id for this row (used for throttle state)." },
    label: {
      type: "string",
      title: "Label",
      description: "Optional name in logs and UI.",
      default: "",
    },
    companyId: { type: "string", title: "Company ID", description: "UUID of the company that owns the project." },
    projectId: { type: "string", title: "Project ID", description: "UUID of the project whose workspace path will be used as cwd." },
    workspaceName: {
      type: "string",
      title: "Workspace name",
      description:
        "Match Paperclip workspace display name. Leave empty to use the primary workspace.",
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
      description: "Shell command to run in the workspace directory (pipes and chaining allowed).",
      minLength: 1,
    },
    intervalMinutes: {
      type: "integer",
      title: "Minimum interval (minutes)",
      description:
        "For scheduled runs only: wait at least this many minutes after the last successful run before running again. Value 1 means run on every host schedule tick (about once per minute); higher values throttle across ticks.",
      minimum: 1,
      maximum: 10080,
      default: 1,
    },
  },
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: "plugin-razum-scheduler",
  apiVersion: 1,
  version: "0.2.4",
  displayName: "Razum scheduler",
  description:
    "Runs one or more shell commands on a timer in project workspaces. Host fires the job every minute; each task’s intervalMinutes throttles how often that command actually runs.",
  author: "Mikhail Shumilov",
  categories: ["automation", "workspace"],
  capabilities: [
    "jobs.schedule",
    "projects.read",
    "project.workspaces.read",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "instance.settings.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        minItems: 0,
        maxItems: 20,
        title: "Scheduled tasks",
        items: taskItemSchema,
      },
    },
  },
  jobs: [
    {
      jobKey: MANIFEST_JOB_KEY,
      displayName: "Workspace command",
      description: "Executes configured shell commands for each task in settings.",
      schedule: "* * * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "razum-scheduler-settings",
        displayName: "Razum scheduler",
        exportName: "SchedulerSettingsPage",
      },
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
