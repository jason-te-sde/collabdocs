import type { CollabSnapshot } from "@/lib/collab/provider";

interface Message {
  title: string;
  detail: string;
}

/** What happened and what the user can do, for each reason the server gives for refusing a write. */
export function describeRejection(reason: NonNullable<CollabSnapshot["rejection"]>): Message {
  switch (reason) {
    case "document_full":
      return {
        title: "This document is full",
        detail:
          "It has reached its size limit, so new changes are not being saved or shared. Delete some content to make room (deleting is still allowed), or ask your administrator to raise the limit. Your recent changes stay on this device only.",
      };
    case "too_large":
      return {
        title: "That change was too large to save",
        detail:
          "A single paste or edit was over the size limit, so it was not saved or shared. Try pasting it in smaller pieces.",
      };
    case "forbidden":
      return {
        title: "You cannot make changes to this document",
        detail:
          "Your role does not allow editing, so your changes were not saved or shared. Ask the document's owner for edit access.",
      };
    case "overloaded":
      return {
        title: "The server could not keep up",
        detail:
          "It closed the connection because changes arrived faster than it could save them. The editor reconnects by itself; wait a moment before typing more.",
      };
    case "malformed":
    case "unknown":
      return {
        title: "A change was not accepted",
        detail:
          "The server refused your last change, so it was not saved or shared. Reload the page; if this keeps happening, contact your administrator.",
      };
  }
}

/** A live alert for a refused write; renders nothing when there is none. */
export function RejectionNotice({
  snapshot,
  onDismiss,
}: {
  snapshot: CollabSnapshot;
  onDismiss: () => void;
}) {
  if (!snapshot.rejection) return null;
  const { title, detail } = describeRejection(snapshot.rejection);
  return (
    <div
      role="alert"
      data-testid="rejection-notice"
      data-reason={snapshot.rejection}
      className="rounded-lg border border-red-700 bg-red-50 p-4 text-slate-900"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm">{detail}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 rounded text-sm font-medium text-red-900 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-900"
      >
        Dismiss
      </button>
    </div>
  );
}
