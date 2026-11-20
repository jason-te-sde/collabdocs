import { z } from "zod";
import { handle, json, readBody, requireUser } from "@/lib/api";
import { getDb } from "@/lib/db";

const createSchema = z.object({ title: z.string().trim().min(1).max(200) });

/** Documents the caller is a member of, newest change first. */
export const GET = handle(async () => {
  const user = await requireUser();
  const memberships = await getDb().membership.findMany({
    where: { userId: user.id },
    include: { document: true },
    orderBy: { document: { updatedAt: "desc" } },
  });
  return json({
    documents: memberships.map((m) => ({
      id: m.document.id,
      title: m.document.title,
      ownerId: m.document.ownerId,
      role: m.role,
      createdAt: m.document.createdAt,
      updatedAt: m.document.updatedAt,
    })),
  });
});

export const POST = handle(async (request: Request) => {
  const user = await requireUser();
  const { title } = await readBody(request, createSchema);
  const document = await getDb().document.create({
    data: {
      title,
      ownerId: user.id,
      memberships: { create: { userId: user.id, role: "owner" } },
    },
  });
  return json({ document: { ...document, role: "owner" } }, 201);
});
