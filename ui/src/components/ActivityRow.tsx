import { Link } from "@/lib/router";
import { Identity } from "./Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";

const ACTION_VERBS: Record<string, string> = {
  "issue.created": "created",
  "issue.updated": "updated",
  "issue.checked_out": "checked out",
  "issue.released": "released",
  "issue.comment_added": "commented on",
  "issue.attachment_added": "attached file to",
  "issue.attachment_removed": "removed attachment from",
  "issue.document_created": "created document for",
  "issue.document_updated": "updated document on",
  "issue.document_deleted": "deleted document from",
  "issue.commented": "commented on",
  "issue.deleted": "deleted",
  "agent.created": "created",
  "agent.updated": "updated",
  "agent.paused": "paused",
  "agent.resumed": "resumed",
  "agent.terminated": "terminated",
  "agent.key_created": "created API key for",
  "agent.budget_updated": "updated budget for",
  "agent.runtime_session_reset": "reset session for",
  "heartbeat.invoked": "invoked heartbeat for",
  "heartbeat.cancelled": "cancelled heartbeat for",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "project.created": "created",
  "project.updated": "updated",
  "project.deleted": "deleted",
  "goal.created": "created",
  "goal.updated": "updated",
  "goal.deleted": "deleted",
  "cost.reported": "reported cost for",
  "cost.recorded": "recorded cost for",
  "company.created": "created company",
  "company.updated": "updated company",
  "company.archived": "archived",
  "company.budget_updated": "updated budget for",
};

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function formatVerb(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    if (details.status !== undefined) {
      const from = previous.status;
      return from
        ? `changed status from ${humanizeValue(from)} to ${humanizeValue(details.status)} on`
        : `changed status to ${humanizeValue(details.status)} on`;
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      return from
        ? `changed priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)} on`
        : `changed priority to ${humanizeValue(details.priority)} on`;
    }
  }
  return ACTION_VERBS[action] ?? action.replace(/[._]/g, " ");
}

function entityLink(entityType: string, entityId: string, name?: string | null): string | null {
  switch (entityType) {
    case "issue": return `/issues/${name ?? entityId}`;
    case "agent": return `/agents/${entityId}`;
    case "project": return `/projects/${deriveProjectUrlKey(name, entityId)}`;
    case "goal": return `/goals/${entityId}`;
    case "approval": return `/approvals/${entityId}`;
    default: return null;
  }
}

/** Rich `details` from plugins (e.g. plugin-razum-scheduler `ctx.activity.log` metadata). */
function extractCommandOutputDetails(
  details: Record<string, unknown> | null | undefined,
): { stdout: string; stderr: string; exitCode: unknown; cwd?: string } | null {
  if (!details || typeof details !== "object") return null;
  const stdout = typeof details.stdoutTail === "string" ? details.stdoutTail.trim() : "";
  const stderr = typeof details.stderrTail === "string" ? details.stderrTail.trim() : "";
  const cwd = typeof details.cwd === "string" ? details.cwd : undefined;
  const exitCode = details.exitCode;
  if (!stdout && !stderr && exitCode === undefined && !cwd) return null;
  return { stdout, stderr, exitCode, cwd };
}

function ActivityCommandOutputBlock({
  details,
}: {
  details: { stdout: string; stderr: string; exitCode: unknown; cwd?: string };
}) {
  const hasBody = Boolean(details.stdout || details.stderr);
  if (!hasBody && details.exitCode === undefined && !details.cwd) return null;

  return (
    <Collapsible className="group border-t border-border/60 bg-muted/20">
      <CollapsibleTrigger className="flex w-full items-center gap-1 px-4 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40">
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        <span>Command output</span>
        {details.exitCode !== undefined && details.exitCode !== null && (
          <span className="ml-1 font-mono text-[10px] opacity-80">exit {String(details.exitCode)}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 px-4 pb-3 pt-0">
          {details.cwd ? (
            <div className="font-mono text-[10px] text-muted-foreground break-all">{details.cwd}</div>
          ) : null}
          {details.stderr ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-destructive/30 bg-destructive/5 p-2 font-mono text-[11px] text-destructive">
              {details.stderr}
            </pre>
          ) : null}
          {details.stdout ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background/80 p-2 font-mono text-[11px] text-foreground">
              {details.stdout}
            </pre>
          ) : null}
          {!details.stdout && !details.stderr ? (
            <p className="text-xs text-muted-foreground">No captured stdout/stderr for this entry.</p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ActivityRowProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  className?: string;
}

export function ActivityRow({ event, agentMap, entityNameMap, entityTitleMap, className }: ActivityRowProps) {
  const verb = formatVerb(event.action, event.details);

  const isHeartbeatEvent = event.entityType === "heartbeat_run";
  const heartbeatAgentId = isHeartbeatEvent
    ? (event.details as Record<string, unknown> | null)?.agentId as string | undefined
    : undefined;

  const name = isHeartbeatEvent
    ? (heartbeatAgentId ? entityNameMap.get(`agent:${heartbeatAgentId}`) : null)
    : entityNameMap.get(`${event.entityType}:${event.entityId}`);

  const entityTitle = entityTitleMap?.get(`${event.entityType}:${event.entityId}`);

  const link = isHeartbeatEvent && heartbeatAgentId
    ? `/agents/${heartbeatAgentId}/runs/${event.entityId}`
    : entityLink(event.entityType, event.entityId, name);

  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
  const actorName = actor?.name ?? (event.actorType === "system" ? "System" : event.actorType === "user" ? "Board" : event.actorId || "Unknown");

  const inner = (
    <div className="flex gap-3">
      <p className="flex-1 min-w-0 truncate">
        <Identity
          name={actorName}
          size="xs"
          className="align-baseline"
        />
        <span className="text-muted-foreground ml-1">{verb} </span>
        {name && <span className="font-medium">{name}</span>}
        {entityTitle && <span className="text-muted-foreground ml-1">— {entityTitle}</span>}
      </p>
      <span className="text-xs text-muted-foreground shrink-0 pt-0.5">{timeAgo(event.createdAt)}</span>
    </div>
  );

  const commandOut = extractCommandOutputDetails(event.details);

  const rowShell = cn(className);
  const rowInner = cn(
    "px-4 py-2 text-sm",
    link && "cursor-pointer hover:bg-accent/50 transition-colors",
  );

  if (link) {
    return (
      <div className={rowShell}>
        <Link to={link} className={cn(rowInner, "no-underline text-inherit block")}>
          {inner}
        </Link>
        {commandOut ? <ActivityCommandOutputBlock details={commandOut} /> : null}
      </div>
    );
  }

  return (
    <div className={rowShell}>
      <div className={rowInner}>{inner}</div>
      {commandOut ? <ActivityCommandOutputBlock details={commandOut} /> : null}
    </div>
  );
}
