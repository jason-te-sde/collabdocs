import type { IndexeddbPersistence } from "y-indexeddb";
import type * as Y from "yjs";
import type { CollabProvider } from "./provider";
import { yieldToMain } from "./schedule";

export interface CollabSession {
  doc: Y.Doc;
  provider: CollabProvider;
}

export interface OpenedSession {
  session: CollabSession;
  /** Closes the socket and releases the document; keeps or deletes the local copy as it should. */
  close: () => void;
}

/**
 * Opens a document: a Y.Doc, a provider that syncs it, and a copy kept in IndexedDB on
 * this device (so a reload keeps edits that never reached the server).
 *
 * The libraries are loaded here, with dynamic imports and a yield between the steps,
 * so that none of them is part of the page's first load and no step runs in the same
 * task as another. The provider connects first; the local copy is attached next. An edit
 * made in between is not lost: the copy stores the document's whole state when it opens.
 *
 * The IndexedDB name includes the user, so that two accounts sharing a browser never
 * read each other's copies. When the server says the user has no access (any more),
 * the local copy is deleted.
 */
export async function openCollabSession(
  documentId: string,
  userId: string,
  collabUrl: string,
  onOpen: (session: CollabSession) => void,
  isCancelled: () => boolean,
): Promise<OpenedSession | null> {
  const [Y, { CollabProvider }, { requestCollabToken }] = await Promise.all([
    import("yjs"),
    import("./provider"),
    import("./token"),
  ]);
  await yieldToMain();
  if (isCancelled()) return null;

  const doc = new Y.Doc();
  const provider = new CollabProvider({
    documentId,
    doc,
    url: collabUrl,
    fetchToken: () => requestCollabToken(documentId),
  });
  const databaseName = `collabdocs:${userId}:${documentId}`;
  let persistence: IndexeddbPersistence | null = null;
  let cleared = false;
  const clearLocalCopy = () => {
    if (cleared) return;
    cleared = true;
    if (persistence) void persistence.clearData();
    else indexedDB.deleteDatabase(databaseName);
  };
  const unsubscribe = provider.subscribe(() => {
    if (provider.getSnapshot().state === "denied") clearLocalCopy();
  });
  provider.connect();
  onOpen({ doc, provider });

  let closed = false;
  const close = () => {
    closed = true;
    unsubscribe();
    provider.destroy();
    if (persistence && !cleared) void persistence.destroy();
    doc.destroy();
  };

  await yieldToMain();
  const { IndexeddbPersistence } = await import("y-indexeddb");
  if (closed) return { session: { doc, provider }, close };
  if (cleared) return { session: { doc, provider }, close };
  persistence = new IndexeddbPersistence(databaseName, doc);
  return { session: { doc, provider }, close };
}
