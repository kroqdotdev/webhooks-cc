import { RequireAuth } from "@/components/auth/require-auth";

export default function EndpointLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequireAuth>{children}</RequireAuth>;
}
