// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LEAGUES, type League } from './leagues';

/**
 * Live TV sports, set up in the dashboard (customSettings.ts) or the environment, read each time
 * they're used so a change applies at once.
 *
 * - `JELLYFIN_SPORTS`: on by default; off sends nothing to ESPN and adds nothing to the guide.
 * - `JELLYFIN_SPORTS_LEAGUES`: the leagues read, by key (leagues.ts); empty for all.
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function sportsOn(): boolean {
  const value = readEnv('JELLYFIN_SPORTS')?.toLowerCase();
  return value === undefined || !['false', '0', 'no', 'off'].includes(value);
}

export function sportsLeagues(): League[] {
  const asked = (readEnv('JELLYFIN_SPORTS_LEAGUES') ?? '')
    .split(/[\s,|]+/)
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean);
  if (!asked.length) return LEAGUES;
  const chosen = LEAGUES.filter((league) => asked.includes(league.key));
  return chosen.length ? chosen : LEAGUES;
}
