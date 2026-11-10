"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Lock, LockOpen, Trash2 } from "lucide-react";
import { InlineMessage, Panel, StatusTag, settingsLink } from "@/components/settings/panel";
import { shortDate } from "@/components/settings/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  releaseName,
  reserveName,
  setNamePassword,
  type ApiName,
  type NamesListing,
} from "@/lib/shares-api";
import { CommandBlock } from "./command-block";

const PERSONAL = "personal";

interface TeamChoice {
  id: string;
  name: string;
}

/**
 * The names an account keeps for its previews: its own and its teams'. A
 * name holds its link across runs, and its password holds for every share
 * under it.
 */
export function NamesPanel({
  accessToken,
  listing,
  passwords,
  teams,
  onChange,
}: {
  accessToken: string;
  listing: NamesListing;
  /** Whether the plan allows passwords on previews. */
  passwords: boolean;
  teams: TeamChoice[];
  onChange: () => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [team, setTeam] = useState(PERSONAL);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [releasing, setReleasing] = useState<ApiName | null>(null);
  const [passwordFor, setPasswordFor] = useState<ApiName | null>(null);
  const [password, setPassword] = useState("");

  const canReserve = listing.limit > 0;
  const full = listing.used >= listing.limit;

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      setMessage({ tone: "success", text });
      await onChange();
      return true;
    } catch (err) {
      setMessage({
        tone: "error",
        text: err instanceof Error ? err.message : "That did not work.",
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reserve = async (event: React.FormEvent) => {
    event.preventDefault();
    const wanted = name.trim().toLowerCase();
    if (!wanted) return;
    const ok = await run(async () => {
      await reserveName(accessToken, wanted, team === PERSONAL ? null : team);
      return `${wanted} is yours.`;
    });
    if (ok) setName("");
  };

  const savePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!passwordFor) return;
    const target = passwordFor;
    const ok = await run(async () => {
      await setNamePassword(accessToken, target.name, password);
      return `Visitors to ${target.name} now need the password.`;
    });
    if (ok) {
      setPasswordFor(null);
      setPassword("");
    }
  };

  return (
    <Panel
      id="names"
      flush
      title="Names"
      description={
        canReserve
          ? `A name keeps your link the same every time you share under it. ${listing.used} of ${listing.limit} on your plan.`
          : "Free previews get a new random name each time."
      }
    >
      {listing.names.length > 0 && (
        <ul className="ph-no-capture">
          {listing.names.map((entry) => (
            <li
              key={entry.name}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-5 py-3"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono font-medium">{entry.name}</span>
                  {entry.live && <StatusTag tone="success">Sharing now</StatusTag>}
                  {entry.password && (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                      title="Visitors need a password"
                    >
                      <Lock className="h-3 w-3" aria-hidden />
                      Password
                    </span>
                  )}
                </p>
                <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  {entry.url && <span className="font-mono">{entry.url}</span>}
                  {entry.team && <span>Team {entry.team.name}</span>}
                  {!entry.mine && entry.reservedBy && <span>Kept by {entry.reservedBy.email}</span>}
                  <span>Since {shortDate(entry.createdAt)}</span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {entry.url && (
                  <Button variant="ghost" size="icon" asChild>
                    <a
                      href={entry.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open"
                      aria-label={`Open ${entry.name}`}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                )}
                {passwords &&
                  (entry.password ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      title="Remove the password"
                      aria-label={`Remove the password from ${entry.name}`}
                      onClick={() =>
                        void run(async () => {
                          await setNamePassword(accessToken, entry.name, null);
                          return `${entry.name} is open to anyone with the link.`;
                        })
                      }
                    >
                      <LockOpen className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      title="Set a password"
                      aria-label={`Set a password on ${entry.name}`}
                      onClick={() => {
                        setPassword("");
                        setPasswordFor(entry);
                      }}
                    >
                      <Lock className="h-4 w-4" />
                    </Button>
                  ))}
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  title="Release the name"
                  aria-label={`Release ${entry.name}`}
                  onClick={() => setReleasing(entry)}
                >
                  <Trash2 className="h-4 w-4 text-destructive-ink" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-3 px-5 py-4">
        {canReserve ? (
          full ? (
            <p className="text-sm text-muted-foreground">
              Every name on your plan is in use. Release one to keep another.
            </p>
          ) : (
            <form onSubmit={(event) => void reserve(event)} className="flex flex-wrap gap-2">
              <label htmlFor="reserve-name" className="sr-only">
                Name to keep
              </label>
              <Input
                id="reserve-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my-project"
                autoComplete="off"
                spellCheck={false}
                className="ph-no-capture w-56 max-w-full font-mono"
              />
              {teams.length > 0 && (
                <Select value={team} onValueChange={setTeam}>
                  <SelectTrigger aria-label="Who the name is for" className="w-48 max-w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="ph-no-capture">
                    <SelectItem value={PERSONAL}>Just me</SelectItem>
                    {teams.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        Team {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button type="submit" disabled={busy || !name.trim()}>
                Keep name
              </Button>
            </form>
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            Names of your own come with Pro and Business.{" "}
            <Link href="/account/plan" className={settingsLink}>
              See plans
            </Link>
          </p>
        )}
        {listing.names.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Share under a name:</p>
            <CommandBlock command={`whk share 3000 --name ${listing.names[0].name}`} />
          </div>
        )}
        {message && <InlineMessage tone={message.tone}>{message.text}</InlineMessage>}
      </div>

      <AlertDialog open={releasing !== null} onOpenChange={(open) => !open && setReleasing(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release {releasing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its link stops working, and anyone may keep the name after you.
              {releasing?.live ? " The share running under it stops now." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = releasing;
                setReleasing(null);
                if (target)
                  void run(async () => {
                    await releaseName(accessToken, target.name);
                    return `${target.name} is released.`;
                  });
              }}
            >
              Release
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={passwordFor !== null} onOpenChange={(open) => !open && setPasswordFor(null)}>
        <DialogContent className="max-w-md border-strong border-line shadow-raised">
          <form onSubmit={(event) => void savePassword(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Password for {passwordFor?.name}</DialogTitle>
              <DialogDescription>
                Visitors type it once per browser. It holds for every share under this name, unless
                a share sets its own with --password.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <label htmlFor="name-password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="name-password"
                type="password"
                value={password}
                minLength={8}
                maxLength={200}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">At least 8 characters.</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPasswordFor(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || password.length < 8}>
                Set password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
