// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClipboardCopy, Loader2, Trophy } from "lucide-react";
import { toast } from "sonner";
import { useAdmin } from "@/contexts/AdminContext";
import { ownPageToken } from "@/lib/ownPage";

/** The category the sports settings are shown in (customSettings.ts), where this check sits. */
export const SPORTS_CATEGORY = "Custom: Live TV Sports";

interface CheckedChannel {
  channel: string;
  number?: string;
  by: "programme" | "channel";
  programme?: string;
}

interface NearMiss {
  league: string;
  game: string;
  start: string;
  programmes: Array<{ channel: string; number?: string; programme: string; start: string }>;
}

interface Check {
  /** The configurations sharing this guide. */
  configurations?: string[];
  checkedAt: string;
  from: string;
  to: string;
  channels: number;
  channelsRead?: number;
  seconds?: number;
  channelsWithGuide: number;
  programmes: number;
  leagues: Array<{ league: string; games: number; withChannels: number }>;
  failed: Array<{ league: string; why: string }>;
  games: Array<{ league: string; game: string; start: string; state: string; detail: string; channels: CheckedChannel[] }>;
  unmatchedProgrammes: Array<{ channel: string; number?: string; programme: string; start: string }>;
  unmatchedChannels: Array<{ channel: string; number?: string }>;
  nearMisses?: NearMiss[];
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
const named = (channel: { channel: string; number?: string }) => (channel.number ? `${channel.number} ${channel.channel}` : channel.channel);

/** The check as plain text, to paste into a message. */
function asText(checks: Check[]): string {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`Sports check ${check.checkedAt}: ${check.channelsRead ?? check.channels} of ${check.channels} channels read in ${check.seconds ?? "?"}s (sports channels first), ${check.channelsWithGuide} with a guide, ${check.programmes} programmes${(check.configurations?.length ?? 0) > 1 ? `, for ${check.configurations!.length} configurations sharing this guide` : ""}`);
    lines.push("Leagues (found on a channel / games):");
    for (const row of check.leagues) lines.push(`  ${row.league}: ${row.withChannels} / ${row.games}`);
    if (check.failed.length) lines.push(`Not read: ${check.failed.map((f) => `${f.league} (${f.why})`).join(", ")}`);
    lines.push(`Programmes named like a game that matched none (${check.unmatchedProgrammes.length}):`);
    for (const p of check.unmatchedProgrammes) lines.push(`  ${when(p.start)} · ${named(p)} · ${p.programme}`);
    lines.push(`Channels named like a game that matched none (${check.unmatchedChannels.length}):`);
    for (const c of check.unmatchedChannels) lines.push(`  ${named(c)}`);
    const near = check.nearMisses ?? [];
    lines.push(`Games on no channel, with programmes near them naming a team (${near.length}):`);
    for (const miss of near) {
      lines.push(`  ${miss.league} · ${miss.game} · ${when(miss.start)}`);
      for (const p of miss.programmes) lines.push(`      ${when(p.start)} · ${named(p)} · ${p.programme}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function CheckResult({ check }: { check: Check }) {
  const [showGames, setShowGames] = useState(false);
  const found = check.leagues.reduce((sum, row) => sum + row.withChannels, 0);
  const total = check.leagues.reduce((sum, row) => sum + row.games, 0);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {found} of {total} games found on your channels, from {when(check.from)} to {when(check.to)}. Read{" "}
        {check.channelsRead ?? check.channels} of {check.channels} channels in {check.seconds ?? "?"}s, sports channels first
        {check.channelsRead !== undefined && check.channelsRead < check.channels ? " (stopped there to answer in time)" : ""};{" "}
        {check.channelsWithGuide} with a guide.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-4 font-medium">League</th>
              <th className="py-1 pr-4 font-medium">Games</th>
              <th className="py-1 font-medium">On your channels</th>
            </tr>
          </thead>
          <tbody>
            {check.leagues.map((row) => (
              <tr key={row.league} className="border-t border-border/50">
                <td className="py-1 pr-4">{row.league}</td>
                <td className="py-1 pr-4">{row.games}</td>
                <td className="py-1">{row.withChannels}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {check.failed.length > 0 && (
        <p className="text-sm text-red-400">Not read: {check.failed.map((f) => `${f.league} (${f.why})`).join(", ")}</p>
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium">Programmes named like a game that matched none ({check.unmatchedProgrammes.length})</p>
        {check.unmatchedProgrammes.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="max-h-64 overflow-y-auto text-sm space-y-0.5">
            {check.unmatchedProgrammes.map((p, n) => (
              <li key={n} className="text-muted-foreground">
                <span className="text-foreground">{p.programme}</span> · {named(p)} · {when(p.start)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Channels named like a game that matched none ({check.unmatchedChannels.length})</p>
        {check.unmatchedChannels.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="max-h-64 overflow-y-auto text-sm space-y-0.5">
            {check.unmatchedChannels.map((c, n) => (
              <li key={n}>{named(c)}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">Games on no channel, with programmes near them naming a team ({check.nearMisses?.length ?? 0})</p>
        {!check.nearMisses?.length ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="max-h-64 overflow-y-auto text-sm space-y-1">
            {check.nearMisses.map((miss, n) => (
              <li key={n}>
                <span>{miss.game}</span> <span className="text-muted-foreground">· {miss.league} · {when(miss.start)}</span>
                {miss.programmes.map((p, m) => (
                  <div key={m} className="pl-2 text-muted-foreground">{p.programme} · {named(p)} · {when(p.start)}</div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2">
        <Button variant="ghost" size="sm" onClick={() => setShowGames((on) => !on)}>
          {showGames ? "Hide the games" : `Show every game (${check.games.length})`}
        </Button>
        {showGames && (
          <ul className="max-h-96 overflow-y-auto text-sm space-y-2">
            {check.games.map((game, n) => (
              <li key={n}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="text-[10px]">{game.league}</Badge>
                  <span>{game.game}</span>
                  <span className="text-muted-foreground">{when(game.start)} · {game.detail}</span>
                </div>
                <div className="pl-2 text-muted-foreground">
                  {game.channels.length === 0
                    ? "Not on your channels"
                    : game.channels.map((c) => `${named(c)}${c.by === "channel" ? " (its own channel)" : ""}`).join(" · ")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Checks the Live TV guide against the day's games (/api/dashboard/jellyfin/sports-check): which
 * games are found on which channels, and what in the guide looks like a game but matched none.
 */
export function SportsCheck() {
  const { isAdmin, adminKey } = useAdmin();
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (isAdmin && adminKey) headers["x-admin-key"] = adminKey;
      const ownPage = ownPageToken();
      if (ownPage) headers["x-own-page"] = ownPage;
      const response = await fetch("/api/dashboard/jellyfin/sports-check", { headers, signal: AbortSignal.timeout(5 * 60 * 1000) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || `The check failed (${response.status})`);
      setChecks(Array.isArray(body?.guides) ? body.guides : [body]);
    } catch (err: any) {
      setError(err?.name === "TimeoutError" ? "The check took too long; try again in a minute" : err?.message || "The check failed");
    } finally {
      setRunning(false);
    }
  }

  async function copy() {
    if (!checks) return;
    try {
      await navigator.clipboard.writeText(asText(checks));
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy");
    }
  }

  return (
    <div className="mt-4 border-t border-border/50 pt-4 space-y-3">
      <div>
        <p className="text-sm font-medium">Check the guide against today's games</p>
        <p className="text-sm text-muted-foreground">
          Reads the games from 12 hours ago to 30 hours ahead and the Live TV guide over that time, sports channels first, and
          shows which games were found on which channels. On a very large guide it reads for up to a minute and a half.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={run} disabled={running}>
          {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trophy className="mr-1.5 h-4 w-4" />}
          {running ? "Checking…" : checks ? "Check again" : "Check the guide"}
        </Button>
        {checks && (
          <Button size="sm" variant="outline" onClick={copy}>
            <ClipboardCopy className="mr-1.5 h-4 w-4" />
            Copy the results
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {checks?.map((check, n) => (
        <div key={n} className="space-y-2">
          {checks.length > 1 && (
            <p className="text-sm font-medium">
              {check.configurations?.length === 1 ? "Configuration" : "Configurations"} {check.configurations?.map((id) => id.slice(0, 8)).join(", ")}
            </p>
          )}
          <CheckResult check={check} />
        </div>
      ))}
    </div>
  );
}
