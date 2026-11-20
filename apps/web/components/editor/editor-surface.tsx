"use client";

import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo } from "react";
import { Button } from "@/components/ui";
import { renderCaret } from "@/lib/collab/caret";
import { userColor } from "@/lib/collab/identity";
import type { CollabProvider } from "@/lib/collab/provider";
import type { CollabSession } from "@/lib/collab/session";

interface EditorUser {
  id: string;
  name: string;
}

/**
 * The editing surface: TipTap with the Yjs collaboration extensions. Loaded on demand by
 * `load-surface.ts`, never as part of the page's first load.
 */
export interface EditorSurfaceProps {
  session: CollabSession;
  user: EditorUser;
  readOnly: boolean;
  provider: CollabProvider;
}

export function EditorSurface({ session, user, readOnly, provider }: EditorSurfaceProps) {
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
        CollaborationCaret.configure({
          provider,
          user: { id: user.id, name: user.name, color },
          render: renderCaret,
        }),
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
