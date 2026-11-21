import type { CollabSnapshot } from "@/lib/collab/provider";

interface Display {
  label: string;
  detail: string | null;
  dot: string;
}

/** What to tell the user about the connection, from the provider's snapshot. */
export function describeConnection(snapshot: CollabSnapshot): Display {
  const { state, synced, unsynced, rejection } = snapshot;
  // The server is refusing writes: it is connected, but nothing is being saved. Do not say "Syncing".
  if (state === "connected" && rejection) {
    return {
      label: "Changes not saved",
      detail: "See the message below.",
      dot: "bg-red-700",
    };
  }
  if (state === "connected") {
    return synced
      ? { label: "Connected", detail: null, dot: "bg-emerald-600" }
      : { label: "Syncing…", detail: null, dot: "bg-amber-600" };
  }
  if (state === "offline") {
    return {
      label: "Offline",
      detail: unsynced
        ? "Your edits are saved on this device and will sync when you are back online."
        : "Changes you make will sync when you are back online.",
      dot: "bg-slate-600",
    };
  }
  if (state === "reconnecting") {
    return {
      label: "Reconnecting…",
      detail: unsynced
        ? "Your edits are kept here and will sync when the connection returns."
        : null,
      dot: "bg-amber-600",
    };
  }
  if (state === "denied") return { label: "No access", detail: null, dot: "bg-red-700" };
  return { label: "Connecting…", detail: null, dot: "bg-amber-600" };
}

export function ConnectionStatus({ snapshot }: { snapshot: CollabSnapshot }) {
  const { label, detail, dot } = describeConnection(snapshot);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-status"
      data-state={
        snapshot.state === "connected" && snapshot.rejection
          ? "rejected"
          : snapshot.state === "connected" && !snapshot.synced
            ? "syncing"
            : snapshot.state
      }
      data-unsynced={snapshot.unsynced ? "true" : "false"}
      className="flex items-center gap-2 text-sm text-slate-900"
    >
      <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
      <span className="font-medium">{label}</span>
      {detail ? <span className="text-slate-800">{detail}</span> : null}
    </div>
  );
}
