import type { Metadata } from "next";
import { DocumentEditor } from "@/components/editor/document-editor";
import { displayName } from "@/lib/collab/identity";
import { requirePageUser } from "@/lib/session";

export const metadata: Metadata = { title: "Document" };

/** Where the browser reaches the collab server; read when the page is rendered, so one build serves any deployment. */
function collabUrl(): string {
  return process.env.COLLAB_URL ?? "http://localhost:4000";
}

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser();
  return (
    <DocumentEditor
      documentId={id}
      user={{ id: user.id, name: displayName(user) }}
      collabUrl={collabUrl()}
    />
  );
}
