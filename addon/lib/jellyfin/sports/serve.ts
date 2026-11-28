// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { inTime } from '../addonReader';
import { liveTvReady } from '../livetv/gate';
import { programmesFor } from '../livetv/guide';
import { channelParts } from '../livetv/items';
import { listChannels, type ListedChannel } from '../livetv/lineup';
import type { Programme } from '../livetv/programmes';
import { timeOf } from '../livetv/query';
import type { LiveTvDeps } from '../livetv/routes';
import { scoreboard as sharedBoard, type Scoreboard } from './espn';
import { GameFinder, gameInfo, ranked } from './guide';
import { leagueByKey } from './leagues';
import { gameChannels } from './channels';
import { sportsLeagues, sportsOn } from './settings';

const logger = consola.withTag('JellyfinSports');
const HOUR = 60 * 60 * 1000;
// The games a guide's programmes are found among: a day back, two ahead.
const FINDER_BEHIND_MS = 24 * HOUR;
const FINDER_AHEAD_MS = 48 * HOUR;
// How long the games found are used before they're read again (each league's day keeps its own time).
const FINDER_MS = 15 * 1000;
// How long a guide waits for games never read; past it, it's sent without them, and they're there next time.
const FIRST_WAIT_MS = 1500;
const LIST_BEHIND_MS = 6 * HOUR;
const LIST_AHEAD_MS = 30 * HOUR;
const MAX_LIST_SPAN_MS = 4 * 24 * HOUR;
const LIST_KEEP_MS = 20 * 1000;
// The games whose channels are kept: half a day back, two ahead.
const INDEX_BEHIND_MS = 12 * HOUR;
const INDEX_AHEAD_MS = 48 * HOUR;
const ALL_CHANNELS = 100000;
const LOGO_HOST = 'a.espncdn.com';
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TIMEOUT_MS = 8000;

let held: { at: number; leagues: string; finder: GameFinder } | null = null;
let building: Promise<GameFinder> | null = null;

/**
 * The games a guide's programmes are found among, kept a few seconds; null with sports off. A guide
 * waits a moment at most, and only for the first games read: after that, the last ones found are used
 * while newer ones are read.
 */
export async function gameFinder(board: Scoreboard = sharedBoard, now = Date.now(), waitMs = FIRST_WAIT_MS): Promise<GameFinder | null> {
  if (!sportsOn()) return null;
  const leagues = sportsLeagues();
  const key = leagues.map((league) => league.key).join(',');
  if (held && held.leagues === key && now - held.at < FINDER_MS) return held.finder;
  building ??= board.games(now - FINDER_BEHIND_MS, now + FINDER_AHEAD_MS, leagues)
    .then(({ games }) => {
      const finder = new GameFinder(games, now);
      held = { at: now, leagues: key, finder };
      return finder;
    })
    .finally(() => {
      building = null;
    });
  // Games found before are used while new ones are read, so a guide never waits on ESPN once it has them.
  if (held?.leagues === key) return held.finder;
  return (await inTime(building, waitMs)) ?? null;
}

/** For tests: forget the games found. */
export function forgetGames(): void {
  held = null;
  building = null;
}

export type GameTag = (channel: ListedChannel, programme: Programme) => any | undefined;

/** What the Live TV guide adds to a programme that shows a game (`aiostreams.game`); undefined with sports off. */
export async function gameTagger(board: Scoreboard = sharedBoard): Promise<GameTag | undefined> {
  const finder = await gameFinder(board);
  if (!finder) return undefined;
  return (channel, programme) => {
    const showing = finder.showing(channel, programme);
    return showing ? gameInfo(showing.game, showing.part) : undefined;
  };
}

const lists = new LRUCache<string, any>({ max: 200, ttl: LIST_KEEP_MS });

/**
 * The games of a span (6 hours back to 30 ahead unless asked), each with the channels showing it,
 * best first: what the apps' list of games shows. A few seconds' worth is kept, as each app asks
 * again while it's open.
 */
export async function gamesList(deps: LiveTvDeps, req: any, config: any, board: Scoreboard = sharedBoard): Promise<any | null> {
  const live = await liveTvReady(deps, config);
  if (!live) return null;
  if (!sportsOn()) return { games: [], failed: [] };
  const now = deps.now();
  const ask = (name: string) => req.query?.[name] ?? req.query?.[name.toLowerCase()];
  const from = timeOf(ask('From')) ?? now - LIST_BEHIND_MS;
  const to = Math.min(timeOf(ask('To')) ?? now + LIST_AHEAD_MS, from + MAX_LIST_SPAN_MS);
  const asked = String(ask('League') ?? '').trim().toLowerCase();
  const leagues = asked ? sportsLeagues().filter((league) => league.key === asked) : sportsLeagues();
  const serverId = deps.serverIdFor(req.jellyfin?.userUUID ?? req.params?.userUUID);
  const key = [serverId, live.base, live.catalogs.map((c) => `${c.type}/${c.id}`).join(','), Math.floor(from / 60000), Math.floor(to / 60000), leagues.map((l) => l.key).join(',')].join('|');
  const kept = lists.get(key);
  if (kept) return kept;

  // Which channel shows which game is read in the background and kept (channels.ts); the games and
  // their scores are read fresh.
  const guideKey = [live.base, ...live.catalogs.map((c) => `${c.type}/${c.id}`)].join('|');
  const [read, found] = await Promise.all([
    board.games(from, to, leagues),
    gameChannels(guideKey, {
      channels: async () => (await listChannels(deps.addon, live.base, live.catalogs, { startIndex: 0, limit: ALL_CHANNELS })).channels,
      programmes: (channels) => {
        const at = deps.now();
        return programmesFor(deps.addon, live.base, live.reach, channels.map((c) => c.meta), at - INDEX_BEHIND_MS - 2 * HOUR, at + INDEX_AHEAD_MS + 4 * HOUR);
      },
      games: async () => {
        const at = deps.now();
        return (await board.games(at - INDEX_BEHIND_MS, at + INDEX_AHEAD_MS, sportsLeagues())).games;
      },
    }),
  ]);
  const byGame = found.byGame;
  const answer = {
    games: read.games.map((game) => ({
      ...gameInfo(game),
      channels: ranked(byGame.get(game.id) ?? []).map(({ channel, by, programme }) => {
        const parts = channelParts(deps, serverId, channel);
        const entry: any = { Id: parts.id, Name: channel.meta.name, by };
        const number = channel.number ?? channel.meta.channelNumber;
        if (number) entry.Number = number;
        if (parts.imageTag) entry.ChannelPrimaryImageTag = parts.imageTag;
        if (programme) {
          entry.ProgramId = deps.encodeProgramId({ t: channel.meta.type, i: channel.meta.id, at: Math.floor(programme.start / 1000) }, parts.id);
          entry.StartDate = new Date(programme.start).toISOString();
          entry.EndDate = new Date(programme.end).toISOString();
          if (programme.live !== undefined) entry.IsLive = programme.live;
        }
        return entry;
      }),
    })),
    leagues: leagues.map((league) => ({ key: league.key, name: league.name })),
    failed: read.failed,
    // False while the guide is first read for channels: the games are there, their channels to come.
    complete: found.complete,
  };
  // Kept only once complete, so an app asking again soon gets the channels as they're found.
  if (found.complete) lists.set(key, answer);
  return answer;
}

const logos = new LRUCache<string, { type: string; bytes: Buffer }>({
  maxSize: 32 * 1024 * 1024,
  sizeCalculation: (logo) => logo.bytes.length + 100,
  ttl: 7 * 24 * HOUR,
});

export interface LogoAnswer {
  type: string;
  bytes: Buffer;
}

const logoWarned = new Map<string, number>();
/** Why a logo didn't come, in the log at most once a minute for each reason. */
function logoFailed(why: string): null {
  const now = Date.now();
  if ((logoWarned.get(why) ?? 0) + 60 * 1000 < now) {
    logoWarned.set(why, now);
    logger.warn(`A team logo couldn't be sent: ${why}`);
  }
  return null;
}

/** A team's logo, fetched by this server from ESPN's image host only and kept, so apps never ask ESPN. */
export async function teamLogo(league: string, team: string, board: Scoreboard = sharedBoard, fetcher: typeof fetch = fetch): Promise<LogoAnswer | null> {
  if (!sportsOn()) return null;
  let url = board.logoOf(league, team);
  // Not read since the server started: the league's days around now.
  const known = leagueByKey(league);
  if (!url && known) {
    const now = Date.now();
    await board.games(now - FINDER_BEHIND_MS, now + FINDER_AHEAD_MS, [known]);
    url = board.logoOf(league, team);
  }
  if (!url) return logoFailed(`no logo known for ${league}/${team} (its games not read)`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return logoFailed('its address could not be read');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== LOGO_HOST) return logoFailed(`its address is on another host (${parsed.hostname})`);
  const kept = logos.get(url);
  if (kept) return kept;
  try {
    const response = await fetcher(url, { headers: { 'user-agent': 'AIOMetadata' }, signal: AbortSignal.timeout(LOGO_TIMEOUT_MS) });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok) return logoFailed(`ESPN's image host answered HTTP ${response.status}`);
    if (!/^image\//i.test(type)) return logoFailed(`ESPN's image host sent ${type || 'no type'}, not a picture`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_LOGO_BYTES) return logoFailed(`it was ${bytes.length} bytes`);
    const logo = { type, bytes };
    logos.set(url, logo);
    return logo;
  } catch (error: any) {
    return logoFailed(error?.name === 'TimeoutError' ? "ESPN's image host didn't answer in time" : `ESPN's image host couldn't be reached (${error?.cause?.code ?? error?.name ?? 'error'})`);
  }
}

export function registerSports(router: any, deps: LiveTvDeps, board: Scoreboard = sharedBoard): void {
  router.get('/AIOStreams/Games', async (req: any, res: any, next: any) => {
    try {
      // It lists the configuration's channels: for a signed-in app only.
      if (!req.jellyfin?.authenticated) {
        res.status(401).json({ Message: 'Sign in first' });
        return;
      }
      const config = await deps.loadConfig(req);
      const list = config ? await gamesList(deps, req, config, board) : null;
      if (!list) {
        next();
        return;
      }
      res.json(list);
    } catch (error) {
      next(error);
    }
  });

  router.get('/AIOStreams/Sports/Logo/:league/:team', async (req: any, res: any, next: any) => {
    try {
      const logo = await teamLogo(String(req.params.league).toLowerCase(), String(req.params.team), board);
      if (!logo) {
        res.status(404).end();
        return;
      }
      res.set('Content-Type', logo.type);
      res.set('Cache-Control', 'public, max-age=604800');
      res.end(logo.bytes);
    } catch (error) {
      next(error);
    }
  });
}
