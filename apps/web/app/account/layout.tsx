import { RequireAuth } from "@/components/auth/require-auth";
import { AppHeader } from "@/components/nav/app-header";

export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RequireAuth>
      <div className="min-h-screen">
        <AppHeader backLink={{ href: "/dashboard", label: "Back to Dashboard" }} />
        {children}
      </div>
    </RequireAuth>
  );
}
