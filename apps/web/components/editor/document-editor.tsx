"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { can } from "@collabdocs/shared/permissions";
import { getDocument } from "@/lib/client-api";
import type { CollabProvider } from "@/lib/collab/provider";
import { whenIdle } from "@/lib/collab/schedule";
import { ConnectionStatus } from "./connection-status";
import { PresenceList } from "./presence-list";
import { RejectionNotice } from "./rejection-notice";
import { ShareDialog } from "./share-dialog";
import { LazyEditorSurface, loadEditorSurface } from "./load-surface";
import { useCollabSession, type CollabSession } from "./use-collab-session";
import { usePresence } from "./use-presence";

interface EditorUser {
  id: string;
  name: string;
}

export function DocumentEditor({
  documentId,
  user,
  collabUrl,
}: {
  documentId: string;
  user: EditorUser;
  collabUrl: string;
}) {
  const session = useCollabSession(documentId, user.id, collabUrl);
  // The editor's code is fetched while the socket connects, not before the first paint.
  useEffect(() => whenIdle(() => void loadEditorSurface().catch(() => {})), []);
  if (!session) {
    return (
      <p role="status" className="text-slate-800">
        Opening the document…
      </p>
    );
  }
  return <EditorView documentId={documentId} user={user} session={session} />;
}

function useDocumentTitle(documentId: string): string | null {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDocument(documentId).then(
      ({ document }) => {
        if (!cancelled) setTitle(document.title);
      },
      () => {
        // Offline or no access: the heading falls back to a generic one.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [documentId]);
  return title;
}

function EditorView({
  documentId,
  user,
  session,
}: {
  documentId: string;
  user: EditorUser;
  session: CollabSession;
}) {
  const { provider } = session;
  const snapshot = useSyncExternalStore(
    provider.subscribe,
    provider.getSnapshot,
    provider.getSnapshot,
  );
  const presence = usePresence(provider.awareness);
  const title = useDocumentTitle(documentId);

  if (snapshot.state === "denied") {
    return (
      <div role="alert" className="rounded-lg border border-slate-300 bg-white p-6">
        <h1 className="text-xl font-semibold">
          {snapshot.deniedReason === "signed-out"
            ? "You are signed out"
            : "You do not have access to this document"}
        </h1>
        <p className="mt-2 text-slate-800">
          {snapshot.deniedReason === "signed-out"
            ? "Sign in again to keep editing."
            : "It may have been deleted, or its owner may have removed you."}
        </p>
        <p className="mt-4">
          <Link
            href={snapshot.deniedReason === "signed-out" ? "/sign-in" : "/documents"}
            className="font-medium text-indigo-800 underline"
          >
            {snapshot.deniedReason === "signed-out" ? "Sign in" : "Back to your documents"}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm">
            <Link href="/documents" className="text-indigo-800 underline">
              All documents
            </Link>
          </p>
          <h1 className="text-3xl font-bold">{title ?? "Document"}</h1>
        </div>
        <div className="flex items-center gap-3">
          {snapshot.readOnly ? (
            <span
              data-testid="view-only"
              className="rounded-full border border-slate-500 px-2.5 py-1 text-sm font-medium"
            >
              View only
            </span>
          ) : null}
          {snapshot.role && can(snapshot.role, "share") ? (
            <ShareDialog documentId={documentId} role={snapshot.role} />
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <PresenceList users={presence} />
        <ConnectionStatus snapshot={snapshot} />
      </div>

      <RejectionNotice snapshot={snapshot} onDismiss={provider.dismissRejection} />

      <Surface session={session} user={user} readOnly={snapshot.readOnly} provider={provider} />
    </div>
  );
}

function Surface({
  session,
  user,
  readOnly,
  provider,
}: {
  session: CollabSession;
  user: EditorUser;
  readOnly: boolean;
  provider: CollabProvider;
}) {
  return (
    <Suspense fallback={<SurfacePlaceholder readOnly={readOnly} />}>
      <LazyEditorSurface session={session} user={user} readOnly={readOnly} provider={provider} />
    </Suspense>
  );
}

/** The space of the loaded surface's toolbar and box, so nothing moves when it arrives. */
function SurfacePlaceholder({ readOnly }: { readOnly: boolean }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {readOnly ? null : <div className="h-10" />}
      <div className="rounded-lg border border-slate-400 bg-white p-6">
        <div className="min-h-6" />
      </div>
    </div>
  );
}
