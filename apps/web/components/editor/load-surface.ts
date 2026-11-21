"use client";

import { lazy, type ComponentType } from "react";
import { yieldToMain } from "@/lib/collab/schedule";
import type { EditorSurfaceProps } from "./editor-surface";

type Surface = ComponentType<EditorSurfaceProps>;

let loading: Promise<Surface> | null = null;

/**
 * Loads the editor (TipTap, ProseMirror and the Yjs bindings) after the page has painted.
 * The pieces are imported one at a time with a yield in between: evaluating them is a
 * few milliseconds each, where one import of the whole editor is a single long task.
 * The promise is shared, so the page can start the load early and the surface can wait for it.
 */
export function loadEditorSurface(): Promise<Surface> {
  loading ??= (async () => {
    await import("@tiptap/react");
    await yieldToMain();
    await import("@tiptap/starter-kit");
    await yieldToMain();
    await import("@tiptap/extension-collaboration");
    await import("@tiptap/extension-collaboration-caret");
    await yieldToMain();
    return (await import("./editor-surface")).EditorSurface;
  })().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/** The editor as a lazy component: render it inside a Suspense boundary. */
export const LazyEditorSurface = lazy(async () => ({ default: await loadEditorSurface() }));
