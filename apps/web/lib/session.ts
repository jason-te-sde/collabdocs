import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "./db";

export interface PageUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: Date | null;
}

/** The signed-in user for a page, or null. The user is looked up again, as `requireUser` does for routes. */
export async function getPageUser(): Promise<PageUser | null> {
  const id = (await auth())?.user?.id;
  if (!id) return null;
  return getDb().user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, emailVerified: true },
  });
}

export async function requirePageUser(): Promise<PageUser> {
  const user = await getPageUser();
  if (!user) redirect("/sign-in");
  return user;
}
