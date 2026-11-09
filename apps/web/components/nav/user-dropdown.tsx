"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { resetUser, trackSignOut } from "@/lib/analytics";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  Gauge,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Palette,
  Settings,
  Users,
} from "lucide-react";
import { useStaff } from "@/components/ops/use-staff";
import { useEffect, useState } from "react";

interface UserProfile {
  name: string | null;
  image: string | null;
  email: string;
}

function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return parts[0][0].toUpperCase();
  }
  return (email[0] ?? "?").toUpperCase();
}

function UserAvatar({ profile }: { profile: UserProfile }) {
  const [imgFailed, setImgFailed] = useState(false);
  const initials = getInitials(profile.name, profile.email);

  if (profile.image && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={profile.image}
        alt=""
        className="h-7 w-7 rounded-full border-strong border-line"
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div className="h-7 w-7 rounded-full border-strong border-line bg-muted flex items-center justify-center text-[10px] font-bold leading-none">
      {initials}
    </div>
  );
}

export function UserDropdown() {
  const { user: authUser, session } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  // Asked when the menu first opens, not on every page load.
  const [menuOpened, setMenuOpened] = useState(false);
  const staff = useStaff(authUser?.id ?? null, session?.access_token ?? null, menuOpened);

  useEffect(() => {
    if (!authUser) {
      setProfile(null);
      return;
    }

    const supabase = createClient();
    supabase
      .from("users")
      .select("name, image, email")
      .eq("id", authUser.id)
      .single<UserProfile>()
      .then(({ data }) => {
        if (data) setProfile(data);
      });
  }, [authUser]);

  if (!profile) return null;

  const handleSignOut = async () => {
    trackSignOut();
    resetUser();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
  };

  const displayName = profile.name || profile.email.split("@")[0];

  return (
    <DropdownMenu onOpenChange={(open) => open && setMenuOpened(true)}>
      {/* The name and initials stay out of autocapture. */}
      <DropdownMenuTrigger className="ph-no-capture flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        <UserAvatar profile={profile} />
        <span className="hidden lg:inline max-w-[120px] truncate">{displayName}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="ph-no-capture w-48">
        <DropdownMenuItem onClick={() => router.push("/dashboard")} className="cursor-pointer">
          <LayoutDashboard className="h-4 w-4 mr-2" />
          Dashboard
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/account")} className="cursor-pointer">
          <Settings className="h-4 w-4 mr-2" />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => router.push("/account/appearance")}
          className="cursor-pointer"
        >
          <Palette className="h-4 w-4 mr-2" />
          Appearance
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/teams")} className="cursor-pointer">
          <Users className="h-4 w-4 mr-2" />
          Teams
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/support")} className="cursor-pointer">
          <LifeBuoy className="h-4 w-4 mr-2" />
          Support
        </DropdownMenuItem>
        {staff?.staff && (
          <DropdownMenuItem
            onClick={() => router.push("/ops")}
            className="cursor-pointer text-staff focus:text-staff"
          >
            <Gauge className="h-4 w-4 mr-2" />
            Operations
            {staff.waiting ? (
              <span className="ml-auto rounded-sm bg-staff-wash px-1.5 text-xs font-semibold tabular-nums text-staff">
                {staff.waiting}
              </span>
            ) : null}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
          <LogOut className="h-4 w-4 mr-2" />
          Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
