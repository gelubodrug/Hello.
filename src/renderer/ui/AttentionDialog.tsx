import type { PendingRequest } from "../../shared/types";
import { Dialog } from "./primitives";

/** "just now", "4 min ago", "2 h ago". */
function age(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/**
 * What every chat waits for the person to answer (audit A1): grouped by chat,
 * the oldest first, each with the way to where it is answered. Answering stays
 * in the controls that already do it; this only leads there.
 */
export function AttentionDialog({ open, requests, titles, onOpenRequest, onClose }: {
  open: boolean;
  requests: readonly PendingRequest[];
  titles: ReadonlyMap<string, string>;
  onOpenRequest: (request: PendingRequest) => void;
  onClose: () => void;
}): JSX.Element {
  const now = Date.now();
  const groups = new Map<string, PendingRequest[]>();
  for (const request of [...requests].sort((a, b) => a.createdAt - b.createdAt))
    groups.set(request.conversationId, [...(groups.get(request.conversationId) ?? []), request]);
  return (
    <Dialog open={open} title="Needs your attention" onClose={onClose} dismissOnBackdrop className="attention-dialog">
      <p className="attention-summary" role="status">
        {requests.length
          ? `${requests.length} ${requests.length === 1 ? "request waits" : "requests wait"} for your answer.`
          : "Nothing is waiting for you."}
      </p>
      {[...groups].map(([conversationId, items]) => (
        <section key={conversationId} className="attention-group" aria-label={titles.get(conversationId) ?? "Chat"}>
          <h2 className="truncate">{titles.get(conversationId) ?? "Chat"}</h2>
          <ul>
            {items.map(request => (
              <li key={request.requestId} className="attention-row">
                <span className="attention-row-text">
                  <span className="attention-row-kind">{request.kind === "approval" ? "Approval" : "Plugin question"}</span>
                  <span className="attention-row-label truncate">
                    {request.kind === "approval" ? request.label.replace(/_/g, " ") : request.label}
                  </span>
                </span>
                <span className="attention-row-age">{age(request.createdAt, now)}</span>
                <button type="button" className="pill" onClick={() => onOpenRequest(request)}>Open request</button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Dialog>
  );
}
