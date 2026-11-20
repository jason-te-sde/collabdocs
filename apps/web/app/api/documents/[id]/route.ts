import { z } from "zod";
import {
  handle,
  json,
  noContent,
  readBody,
  requireRole,
  requireUser,
  type DocumentContext,
} from "@/lib/api";
import { getDb } from "@/lib/db";

const renameSchema = z.object({ title: z.string().trim().min(1).max(200) });

export const GET = handle(async (_request: Request, { params }: DocumentContext) => {
  const { id } = await params;
  const user = await requireUser();
  const role = await requireRole(id, user.id, "read");
  const document = await getDb().document.findUniqueOrThrow({ where: { id } });
  return json({ document: { ...document, role } });
});

export const PATCH = handle(async (request: Request, { params }: DocumentContext) => {
  const { id } = await params;
  const user = await requireUser();
  const role = await requireRole(id, user.id, "write");
  const { title } = await readBody(request, renameSchema);
  const document = await getDb().document.update({ where: { id }, data: { title } });
  return json({ document: { ...document, role } });
});

export const DELETE = handle(async (_request: Request, { params }: DocumentContext) => {
  const { id } = await params;
  const user = await requireUser();
  await requireRole(id, user.id, "delete");
  await getDb().document.delete({ where: { id } });
  return noContent();
});
