"use client";

import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { can } from "@collabdocs/shared/permissions";
import { Button } from "@/components/ui";
import { getDocument } from "@/lib/client-api";
import { userColor } from "@/lib/collab/identity";
import type { CollabProvider } from "@/lib/collab/provider";
import { ConnectionStatus } from "./connection-status";
import { PresenceList } from "./presence-list";
import { ShareDialog } from "./share-dialog";
import { useCollabSession, type CollabSession } from "./use-collab-session";
import { usePresence } from "./use-presence";

interface EditorUser {
  id: string;
  name: string;
}

export function DocumentEditor({ documentId, user }: { documentId: string; user: EditorUser }) {
  const session = useCollabSession(documentId, user.id);
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
  const color = useMemo(() => userColor(user.id), [user.id]);
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: !readOnly,
      extensions: [
        // The Collaboration extension brings its own undo and redo, which must
        // only undo this user's changes; the history extension would undo everyone's.
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: session.doc }),
        CollaborationCaret.configure({ provider, user: { id: user.id, name: user.name, color } }),
      ],
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-label": "Document body",
          "aria-multiline": "true",
        },
      },
    },
    [session, user.id, user.name, color],
  );

  useEffect(() => {
    if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  return (
    <div className="space-y-2">
      {!readOnly && editor ? <Toolbar editor={editor} /> : null}
      <div className="rounded-lg border border-slate-400 bg-white p-6 focus-within:ring-2 focus-within:ring-indigo-700">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      heading: e.isActive("heading", { level: 2 }),
      list: e.isActive("bulletList"),
    }),
  });
  const buttons = [
    { label: "Bold", pressed: active.bold, run: () => editor.chain().focus().toggleBold().run() },
    {
      label: "Italic",
      pressed: active.italic,
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      label: "Heading",
      pressed: active.heading,
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: "Bulleted list",
      pressed: active.list,
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
  ];
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-2">
      {buttons.map((button) => (
        <Button
          key={button.label}
          aria-pressed={button.pressed}
          className={button.pressed ? "bg-slate-200" : ""}
          onClick={button.run}
        >
          {button.label}
        </Button>
      ))}
    </div>
  );
}
