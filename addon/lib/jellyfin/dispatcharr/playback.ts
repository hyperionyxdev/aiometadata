// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { DispatcharrChannel, Lineup } from './lineup';
import type { DispatcharrSettings } from './settings';

/** The binge group of a source that plays one of a channel's streams; its number is the stream's id. */
export const STREAM_GROUP = /^dispatcharr-stream-(\d+)$/;

/** "1920x1080" as "1080p". */
export function qualityOf(stats: any): string | undefined {
  const match = /(\d+)\s*[x×]\s*(\d+)/.exec(String(stats?.resolution ?? ''));
  if (!match) return undefined;
  const height = Number(match[2]);
  for (const [min, label] of [[2000, '2160p'], [1300, '1440p'], [1000, '1080p'], [700, '720p'], [540, '576p'], [440, '480p']] as const) {
    if (height >= min) return label;
  }
  return `${height}p`;
}

/** The highest quality among a channel's probed streams. */
export function bestQuality(streams: any[]): string | undefined {
  const heights = streams.map((s) => Number(qualityOf(s?.stream_stats)?.replace('p', ''))).filter((h) => h > 0);
  return heights.length ? `${Math.max(...heights)}p` : undefined;
}

/** "H264 · 50fps · AAC 2.0", once Dispatcharr has probed the stream. */
export function detailsOf(stats: any): string | undefined {
  if (!stats) return undefined;
  const parts: string[] = [];
  if (stats.video_codec) parts.push(String(stats.video_codec).toUpperCase());
  if (stats.source_fps) parts.push(`${Math.round(Number(stats.source_fps))}fps`);
  if (stats.audio_codec) parts.push(`${String(stats.audio_codec).toUpperCase()}${stats.audio_channels ? ` ${stats.audio_channels}` : ''}`);
  return parts.length ? parts.join(' · ') : undefined;
}

function extension(settings: DispatcharrSettings): string {
  return ({ hls: 'm3u8', m3u8: 'm3u8', fmp4: 'mp4', mp4: 'mp4' } as Record<string, string>)[settings.outputFormat ?? ''] ?? 'ts';
}

/** Dispatcharr's proxy link for a channel (by uuid) or one stream (by hash). */
function proxyUrl(settings: DispatcharrSettings, key: string): string {
  const url = new URL(`${settings.streamUrl}/proxy/ts/stream/${encodeURIComponent(key)}`);
  if (settings.outputFormat) url.searchParams.set('output_format', settings.outputFormat);
  return url.toString();
}

function xcLiveUrl(settings: DispatcharrSettings, channel: DispatcharrChannel): string {
  const xc = settings.xc!;
  return `${settings.streamUrl}/live/${encodeURIComponent(xc.username)}/${encodeURIComponent(xc.password)}/${channel.id}.${extension(settings)}`;
}

/** The channel's own link, which Dispatcharr plays as the channel (and fails over on): as the XC user when there is one. */
export function channelUrl(settings: DispatcharrSettings, channel: DispatcharrChannel): string {
  return settings.xc ? xcLiveUrl(settings, channel) : proxyUrl(settings, channel.uuid);
}

/** A source in the stream addon's shape, which the Live TV code turns into a version. */
function source(url: string, { name, lines, filename, group, addon, resolution }: { name: string; lines: string[]; filename: string; group: string; addon: string; resolution?: string }): any {
  return {
    url,
    name,
    description: lines.join('\n'),
    behaviorHints: { notWebReady: true, filename, bingeGroup: `dispatcharr-${group}` },
    // What a version picker reads of each version: where it's from, its file name and its quality.
    streamData: { addon: { name: addon }, filename, ...(resolution ? { parsedFile: { resolution } } : {}) },
  };
}

function providerOf(stream: any, index: number, lineup: Lineup): string {
  return lineup.accounts.get(Number(stream?.m3u_account)) ?? (stream?.is_custom ? 'Custom' : `Source ${index + 1}`);
}

/**
 * A channel's sources: Auto first (the channel as it is, Dispatcharr picking and failing over),
 * named with the stream it plays, then each of its streams in Dispatcharr's order. With switching
 * on, a stream's source plays the channel too, and choosing it switches the channel to that stream.
 */
export function liveSources(settings: DispatcharrSettings, lineup: Lineup, channel: DispatcharrChannel, rawStreams: any[], active: Map<string, number> | null): any[] {
  const streams = rawStreams.filter((s) => s && typeof s === 'object' && !lineup.inactive.has(Number(s.m3u_account)));
  const out: any[] = [];
  const activeId = active?.get(channel.uuid);
  if (settings.autoSource || !streams.length) {
    const playing = streams.find((s) => Number(s.id) === activeId);
    const current = playing ?? streams[0];
    const provider = current ? providerOf(current, streams.indexOf(current), lineup) : undefined;
    const best = bestQuality(streams);
    out.push(source(channelUrl(settings, channel), {
      name: [`${settings.name} · Auto`, provider].filter(Boolean).join(' · '),
      lines: [
        provider ? `${playing ? 'Playing' : 'Starts with'} ${provider}${current?.name ? ` (${current.name})` : ''}` : null,
        'Dispatcharr switches stream if it fails',
      ].filter((line): line is string => !!line),
      // The "Dispatcharr Auto" prefix marks the channel's own source for apps that pick versions by file name.
      filename: ['Dispatcharr Auto', provider, best].filter(Boolean).join(' '),
      group: 'auto',
      addon: settings.name,
      resolution: best,
    }));
  }
  streams.forEach((s, i) => {
    if (!s.stream_hash) return;
    const provider = providerOf(s, i, lineup);
    const quality = qualityOf(s.stream_stats);
    out.push(source(settings.switchStreams ? channelUrl(settings, channel) : proxyUrl(settings, String(s.stream_hash)), {
      name: [provider, quality].filter(Boolean).join(' · '),
      lines: [s.name, detailsOf(s.stream_stats), settings.switchStreams && activeId === Number(s.id) ? 'Playing now' : null].filter((line): line is string => !!line),
      filename: [provider, quality, s.name, `#${i + 1}`].filter(Boolean).join(' '),
      group: `stream-${s.id}`,
      addon: settings.name,
      resolution: quality,
    }));
  });
  return out;
}

/** UTC `YYYY-MM-DD:HH-MM`, the start form Dispatcharr's timeshift link takes. */
export function timeshiftStamp(startSeconds: number): string {
  const at = new Date(startSeconds * 1000).toISOString();
  return `${at.slice(0, 10)}:${at.slice(11, 13)}-${at.slice(14, 16)}`;
}

/** A programme that has ended, from Dispatcharr's catch-up (an XC timeshift link), within the channel's catch-up days. */
export function catchupSources(settings: DispatcharrSettings, channel: DispatcharrChannel, start: number, end: number, now: number): any[] {
  const xc = settings.xc;
  if (!xc || !channel.catchupDays || now - start > channel.catchupDays * 86400) return [];
  const minutes = Math.max(1, Math.round((end - start) / 60));
  const stamp = timeshiftStamp(start);
  const url = `${settings.streamUrl}/timeshift/${encodeURIComponent(xc.username)}/${encodeURIComponent(xc.password)}/${minutes}/${stamp}/${channel.id}.ts`;
  return [{
    url,
    name: `${settings.name} · Catch-up`,
    description: 'From Dispatcharr\'s catch-up',
    behaviorHints: { notWebReady: true, filename: `${channel.name} catch-up ${stamp}`, bingeGroup: 'dispatcharr-catchup' },
    streamData: { addon: { name: settings.name }, filename: `${channel.name} catch-up ${stamp}` },
  }];
}
