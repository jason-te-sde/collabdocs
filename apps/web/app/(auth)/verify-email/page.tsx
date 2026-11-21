import type { Metadata } from "next";
import { VerifyEmail } from "@/components/verify-email";

export const metadata: Metadata = { title: "Confirm your email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return <VerifyEmail token={typeof token === "string" ? token : null} />;
}
