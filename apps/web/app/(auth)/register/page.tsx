import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/auth-forms";
import { getPageUser } from "@/lib/session";

export const metadata: Metadata = { title: "Create an account" };

export default async function RegisterPage() {
  if (await getPageUser()) redirect("/documents");
  return <RegisterForm />;
}
