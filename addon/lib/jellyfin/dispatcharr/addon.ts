// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import type { AddonDeps, Manifest } from '../addonReader';
import type { GuideProgramme } from './guide';
import type { DispatcharrLive } from './index';
import { CHANNEL_TYPE } from './lineup';

const logger = consola.withTag('JellyfinDispatcharr');

/** The stream base Live TV is read from where the server reads Dispatcharr itself. */
export const DIRECT_BASE = 'dispatcharr://live';
const CATALOG_ID = 'dispatcharr';

export const isDirectBase = (base: string): boolean => base === DIRECT_BASE;

/** The parts of a catalog path, as `livetv/catalogs.ts` builds them. */
export function catalogQuery(path: string): { type: string; id: string; extra: Record<string, string> } | null {
  const match = /^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]*))?\.json$/.exec(path);
  if (!match) return null;
  const extra: Record<string, string> = {};
  for (const part of (match[3] ?? '').split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    if (at <= 0) continue;
    extra[decodeURIComponent(part.slice(0, at))] = decodeURIComponent(part.slice(at + 1));
  }
  return { type: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]), extra };
}

/** A programme as a video of a channel's meta, the shape a live catalog's guide is read in. */
export function videoOf(programme: GuideProgramme): any {
  return {
    id: programme.id,
    title: programme.name,
    ...(programme.overview ? { description: programme.overview } : {}),
    startTime: new Date(programme.start).toISOString(),
    endTime: new Date(programme.end).toISOString(),
    ...(programme.thumbnail ? { thumbnail: programme.thumbnail } : {}),
    ...(programme.season !== null ? { season: programme.season } : {}),
    ...(programme.episode !== null ? { episode: programme.episode } : {}),
    ...(programme.genres?.length ? { genres: programme.genres } : {}),
    ...(programme.episodeTitle ? { episodeTitle: programme.episodeTitle } : {}),
    ...(programme.live !== undefined ? { isLive: programme.live } : {}),
    ...(programme.isNew ? { isNew: true } : {}),
    ...(programme.premiere ? { premiere: true } : {}),
    ...(programme.finale ? { finale: true } : {}),
    ...(programme.placeholder ? { placeholder: true } : {}),
  };
}

/**
 * Dispatcharr as a live addon: a made-up manifest with one `tv` catalog (its groups, search, ids
 * and a guide by day), and its catalog paths answered from Dispatcharr's own lineup and guide. Every
 * other base goes to the real addons, as before.
 */
export function withDispatcharr(addon: AddonDeps, live: () => DispatcharrLive | null): AddonDeps {
  const manifestOf = (direct: DispatcharrLive): Manifest => {
    const lineup = direct.known();
    const catchupDays = Math.max(0, ...(lineup?.channels ?? []).map((c) => c.catchupDays));
    return {
      id: 'dispatcharr.live',
      name: direct.settings.name,
      catalogs: [
        {
          type: CHANNEL_TYPE,
          id: CATALOG_ID,
          name: direct.settings.name,
          extra: [
            { name: 'genre', options: lineup?.groups ?? [] },
            { name: 'search' },
            { name: 'ids' },
            { name: 'date' },
          ],
        },
      ],
      ...(catchupDays ? { behaviorHints: { catchupDays } } : {}),
    } as Manifest;
  };

  const answer = async (direct: DispatcharrLive, path: string): Promise<any | null> => {
    const query = catalogQuery(path);
    if (!query || query.type !== CHANNEL_TYPE || query.id !== CATALOG_ID) return null;
    const { date, ...rest } = query.extra;
    const metas = await direct.catalog(rest);
    if (!date) return { metas };
    const guide = await direct.guideDay(date, metas.map((meta) => meta.id));
    if (!guide) return null;
    return { metas: metas.map((meta) => ({ ...meta, videos: (guide.get(meta.id) ?? []).map(videoOf) })) };
  };

  return {
    async manifest(base) {
      if (!isDirectBase(base)) return addon.manifest(base);
      const direct = live();
      if (!direct) return null;
      // Its groups come with the lineup; a lineup that can't be read yet still gives the catalog.
      await direct.lineup().catch(() => undefined);
      return manifestOf(direct);
    },
    peek(base) {
      if (!isDirectBase(base)) return addon.peek(base);
      const direct = live();
      return direct ? manifestOf(direct) : undefined;
    },
    async recall(base) {
      if (!isDirectBase(base)) return addon.recall(base);
      // Read for later, so the groups are there by the next ask.
      live()?.lineup().catch(() => undefined);
    },
    async fetchJson(base, path, timeoutMs, until) {
      if (!isDirectBase(base)) return addon.fetchJson(base, path, timeoutMs, until);
      const direct = live();
      if (!direct) return null;
      try {
        return await answer(direct, path);
      } catch (error: any) {
        logger.warn(`Dispatcharr could not answer for Live TV: ${error?.message || error}`);
        return null;
      }
    },
    paused(base) {
      return isDirectBase(base) ? false : (addon.paused?.(base) ?? false);
    },
    now: () => addon.now(),
  };
}
