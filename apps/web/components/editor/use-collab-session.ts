"use client";

import { useEffect, useState } from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { CollabProvider } from "@/lib/collab/provider";
import { requestCollabToken } from "@/lib/collab/token";

export interface CollabSession {
  doc: Y.Doc;
  provider: CollabProvider;
}

/**
 * Opens a document: a Y.Doc kept in IndexedDB on this device (so a reload
 * keeps edits that never reached the server) and a provider that syncs it.
 *
 * The IndexedDB name includes the user, so that two accounts sharing a browser
 * never read each other's copies. When the server says the user has no access
 * (any more), the local copy is deleted.
 */
export function useCollabSession(
  documentId: string,
  userId: string,
  collabUrl: string,
): CollabSession | null {
  const [session, setSession] = useState<CollabSession | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(`collabdocs:${userId}:${documentId}`, doc);
    const provider = new CollabProvider({
      documentId,
      doc,
      url: collabUrl,
      fetchToken: () => requestCollabToken(documentId),
    });
    let cleared = false;
    const unsubscribe = provider.subscribe(() => {
      if (provider.getSnapshot().state === "denied" && !cleared) {
        cleared = true;
        void persistence.clearData();
      }
    });
    provider.connect();
    // The session is created here, not during render: it opens a database and a socket,
    // which a render must not do (and React may render twice).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession({ doc, provider });
    return () => {
      unsubscribe();
      provider.destroy();
      if (!cleared) void persistence.destroy();
      doc.destroy();
      setSession(null);
    };
  }, [documentId, userId, collabUrl]);

  return session;
}
