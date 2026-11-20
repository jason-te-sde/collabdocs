import type { Metadata } from "next";
import { DocumentList } from "@/components/document-list";

export const metadata: Metadata = { title: "Documents" };

export default function DocumentsPage() {
  return <DocumentList />;
}
