"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { resetUser } from "@/lib/analytics";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, LogOut, Settings, Users } from "lucide-react";
import { useEffect, useState } from "react";

interface UserProfile {
  name: string | null;
  image: string | null;
  email: string;
}

function UserAvatar({ profile }: { profile: UserProfile }) {
  if (profile.image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={profile.image}
        alt=""
        className="h-7 w-7 rounded-full border-2 border-foreground"
      />
    );
  }

  const initial = (profile.name?.[0] ?? profile.email[0] ?? "?").toUpperCase();
  return (
    <div className="h-7 w-7 rounded-full border-2 border-foreground bg-muted flex items-center justify-center text-xs font-bold">
      {initial}
    </div>
  );
}

export function UserDropdown() {
  const { user: authUser } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);

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
    resetUser();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
  };

  const displayName = profile.name || profile.email.split("@")[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer outline-none">
        <UserAvatar profile={profile} />
        <span className="hidden lg:inline max-w-[120px] truncate">{displayName}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => router.push("/account")} className="cursor-pointer">
          <Settings className="h-4 w-4 mr-2" />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/teams")} className="cursor-pointer">
          <Users className="h-4 w-4 mr-2" />
          Teams
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
          <LogOut className="h-4 w-4 mr-2" />
          Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
