import { redirect } from "next/navigation";
import { getPageUser } from "@/lib/session";

export default async function Home() {
  redirect((await getPageUser()) ? "/documents" : "/sign-in");
}
