"use client";

import { useEffect, useState } from "react";
import { openCollabSession, type CollabSession } from "@/lib/collab/session";
import { whenIdle } from "@/lib/collab/schedule";

export type { CollabSession };

/**
 * The open session for a document, or null until it is ready. Nothing starts before the
 * first paint: the page shows its shell, and the browser opens the document when it is idle
 * (see `openCollabSession`).
 */
export function useCollabSession(
  documentId: string,
  userId: string,
  collabUrl: string,
): CollabSession | null {
  const [session, setSession] = useState<CollabSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    let close: (() => void) | null = null;
    const cancelIdle = whenIdle(() => {
      openCollabSession(documentId, userId, collabUrl, setSession, () => cancelled).then(
        (opened) => {
          if (!opened) return;
          if (cancelled) opened.close();
          else close = opened.close;
        },
        () => {
          // The libraries could not be loaded (offline before the first visit): the page
          // keeps saying that it is opening the document.
        },
      );
    });
    return () => {
      cancelled = true;
      cancelIdle();
      close?.();
      setSession(null);
    };
  }, [documentId, userId, collabUrl]);

  return session;
}
