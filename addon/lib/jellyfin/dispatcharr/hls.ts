// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { clientInfo } from '../context';

/**
 * Dispatcharr's channel link sends one long MPEG-TS stream, which Apple's player (and a browser)
 * can't open. Asked with `output_format=hls`, or as an XC link ending in .m3u8 (Dispatcharr 0.33
 * and later), the same channel comes as HLS instead, which they can. Hyperion reads MPEG-TS itself
 * and starts sooner on it, so it keeps the link as it is; every other client gets HLS. Links that
 * aren't Dispatcharr's channel links are left alone.
 */
export function wantsHls(req: any): boolean {
  return !/^hyperion\b/i.test(clientInfo(req).client);
}

export function liveUrlFor(req: any, url: string): string {
  if (typeof url !== 'string' || !wantsHls(req)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  // An XC channel link (/live/<user>/<pass>/<id>.ts): the same link ending in .m3u8 is HLS.
  const xc = /^(.*\/live\/[^/]+\/[^/]+\/[^/.]+)(\.(?:ts|mp4))?$/.exec(parsed.pathname);
  if (xc) {
    parsed.pathname = `${xc[1]}.m3u8`;
    return parsed.toString();
  }
  if (!/\/proxy\/ts\/stream\/[^/]+\/?$/.test(parsed.pathname)) return url;
  parsed.searchParams.delete('output');
  parsed.searchParams.set('output_format', 'hls');
  return parsed.toString();
}
