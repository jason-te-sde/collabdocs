import type { Metadata } from "next";
import { DocumentEditor } from "@/components/editor/document-editor";
import { displayName } from "@/lib/collab/identity";
import { requirePageUser } from "@/lib/session";

export const metadata: Metadata = { title: "Document" };

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser();
  return <DocumentEditor documentId={id} user={{ id: user.id, name: displayName(user) }} />;
}
