// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { SettingDefinition } from '../settingsRegistry';

/**
 * This fork's own settings (Live TV read straight from Dispatcharr, recording, and sports), shown in the
 * dashboard in sections of their own, each label marked "Custom". The dashboard puts what is saved
 * there into the environment, which `dispatcharr/settings.ts`, `recordings/settings.ts` and `sports/settings.ts` read each
 * time they are used, so a change applies without a restart.
 *
 * The logins are left out: `JELLYFIN_DISPATCHARR_API_KEY`, `_USERNAME`, `_PASSWORD`, `_XC_USERNAME`
 * and `_XC_PASSWORD` stay in the environment only, so the dashboard neither shows them nor keeps
 * them in its database. The Boxerbook key is in, marked sensitive, so it's set there and kept on this
 * server: the dashboard masks it and leaves it out of exports, as it does the other API keys.
 *
 * Kept in this file, and added to the registry with one line, so a merge of upstream's registry
 * rarely meets these.
 */
const DISPATCHARR = 'Custom: Dispatcharr Live TV';
const RECORDING = 'Custom: Live TV Recording';
const SPORTS = 'Custom: Live TV Sports';

export const CUSTOM_SETTINGS: SettingDefinition[] = [
  {
    key: 'JELLYFIN_DISPATCHARR_ENABLED',
    envVar: 'JELLYFIN_DISPATCHARR_ENABLED',
    label: 'Custom · Live TV from Dispatcharr',
    description:
      "On: Live TV comes straight from Dispatcharr, set up below with a login in the environment. Off: from the stream addon's live catalogs (Live TV must be on there too), and recording through Dispatcharr's DVR is off; its recordings show again when this is back on. Channel ids differ between the two, so favourites and reminders follow the source they were set on.",
    category: DISPATCHARR,
    type: 'boolean',
    default: true,
  },
  {
    key: 'JELLYFIN_DISPATCHARR_URL',
    envVar: 'JELLYFIN_DISPATCHARR_URL',
    label: 'Custom · Dispatcharr Address',
    description:
      "Dispatcharr's address as this server reaches it (http://dispatcharr:9191 on a shared Docker network). With a login in the environment (JELLYFIN_DISPATCHARR_API_KEY, or a username and password), Live TV comes straight from Dispatcharr; empty, from the stream addon.",
    category: DISPATCHARR,
    type: 'string',
    default: '',
  },
  {
    key: 'JELLYFIN_DISPATCHARR_STREAM_URL',
    envVar: 'JELLYFIN_DISPATCHARR_STREAM_URL',
    label: 'Custom · Dispatcharr Stream Address',
    description: "Where players reach Dispatcharr's channels, catch-up and logos. Empty: the address above, which is only right when the apps can reach it too.",
    category: DISPATCHARR,
    type: 'string',
    default: '',
  },
  {
    key: 'JELLYFIN_DISPATCHARR_USERS',
    envVar: 'JELLYFIN_DISPATCHARR_USERS',
    label: 'Custom · Who Gets Dispatcharr Live TV',
    description:
      "Configuration UUIDs, profiles' Jellyfin user ids, or <configuration UUID>/<profile id>. Empty: every configuration on this server. Anyone not listed gets the stream addon's Live TV.",
    category: DISPATCHARR,
    type: 'string',
    default: '',
    uiHint: 'tags',
  },
  {
    key: 'JELLYFIN_DISPATCHARR_GROUPS',
    envVar: 'JELLYFIN_DISPATCHARR_GROUPS',
    label: 'Custom · Dispatcharr Channel Groups',
    description: 'Only these channel groups, in this order. Empty: every group, in channel-number order.',
    category: DISPATCHARR,
    type: 'string',
    default: '',
    uiHint: 'tags',
  },
  {
    key: 'JELLYFIN_DISPATCHARR_OUTPUT_FORMAT',
    envVar: 'JELLYFIN_DISPATCHARR_OUTPUT_FORMAT',
    label: 'Custom · Dispatcharr Stream Format',
    description: "The format asked of Dispatcharr's channel links. default: Dispatcharr's own.",
    category: DISPATCHARR,
    type: 'select',
    default: 'default',
    options: ['default', 'mpegts', 'hls', 'fmp4'],
  },
  {
    key: 'JELLYFIN_DISPATCHARR_AUTO_SOURCE',
    envVar: 'JELLYFIN_DISPATCHARR_AUTO_SOURCE',
    label: 'Custom · Dispatcharr Auto Version',
    description: "A channel's first version is Auto, the channel as it is, which Dispatcharr fails over by itself. Off: only its streams are listed.",
    category: DISPATCHARR,
    type: 'boolean',
    default: true,
  },
  {
    key: 'JELLYFIN_DISPATCHARR_SWITCH_STREAMS',
    envVar: 'JELLYFIN_DISPATCHARR_SWITCH_STREAMS',
    label: 'Custom · Dispatcharr Stream Switching',
    description: "Choosing one of a channel's streams switches the channel to it with Dispatcharr's own switcher. Needs an admin login.",
    category: DISPATCHARR,
    type: 'boolean',
    default: false,
  },
  {
    key: 'JELLYFIN_DISPATCHARR_NAME',
    envVar: 'JELLYFIN_DISPATCHARR_NAME',
    label: 'Custom · Dispatcharr Label',
    description: 'The label in front of Auto and catch-up in the version list ("Dispatcharr · Auto").',
    category: DISPATCHARR,
    type: 'string',
    default: 'Dispatcharr',
  },
  {
    key: 'JELLYFIN_DISPATCHARR_TIMEOUT',
    envVar: 'JELLYFIN_DISPATCHARR_TIMEOUT',
    label: 'Custom · Dispatcharr Timeout (seconds)',
    description: 'How long each request to Dispatcharr may take, its whole answer included. A big lineup takes a while.',
    category: DISPATCHARR,
    type: 'number',
    default: 90,
    min: 5,
  },
  {
    key: 'JELLYFIN_DISPATCHARR_CACHE_SECONDS',
    envVar: 'JELLYFIN_DISPATCHARR_CACHE_SECONDS',
    label: 'Custom · Dispatcharr Cache (seconds)',
    description: 'How long the channel list and a day of the guide are used before they are read again. A kept copy answers at once while a new one is read.',
    category: DISPATCHARR,
    type: 'number',
    default: 300,
    min: 30,
  },
  {
    key: 'JELLYFIN_DISPATCHARR_HOST_HEADER',
    envVar: 'JELLYFIN_DISPATCHARR_HOST_HEADER',
    label: 'Custom · Dispatcharr Host Header',
    description: 'The Host header sent to Dispatcharr. Empty: its address\'s own, or localhost for a host name Dispatcharr refuses (one with an underscore).',
    category: DISPATCHARR,
    type: 'string',
    default: '',
  },
  {
    key: 'JELLYFIN_RECORDINGS',
    envVar: 'JELLYFIN_RECORDINGS',
    label: 'Custom · Live TV Recording',
    description:
      "Who records. dispatcharr: Dispatcharr's own DVR (its padding, folders and file names apply). local: this server records the channel's stream itself. off: no recording. auto: Dispatcharr's DVR where Live TV comes from Dispatcharr, otherwise off.",
    category: RECORDING,
    type: 'select',
    default: 'auto',
    options: ['auto', 'dispatcharr', 'local', 'off'],
  },
  {
    key: 'JELLYFIN_RECORDINGS_USERS',
    envVar: 'JELLYFIN_RECORDINGS_USERS',
    label: 'Custom · Who May Record',
    description: "Configuration UUIDs, profiles' Jellyfin user ids, or <configuration UUID>/<profile id>. Empty: everyone who has Live TV.",
    category: RECORDING,
    type: 'string',
    default: '',
    uiHint: 'tags',
  },
  {
    key: 'JELLYFIN_RECORDINGS_DISPATCHARR_DIR',
    envVar: 'JELLYFIN_RECORDINGS_DISPATCHARR_DIR',
    label: "Custom · Dispatcharr's Recordings Folder",
    description:
      "Dispatcharr's DVR only: where this server sees Dispatcharr's recordings folder, mounted read-only (/dispatcharr-recordings, say). With Dispatcharr's commercial detection on in Mark mode, the ads it marks in each recording are offered to skip. Empty: no ad marks.",
    category: RECORDING,
    type: 'string',
    default: '',
  },
  {
    key: 'JELLYFIN_RECORDINGS_DIR',
    envVar: 'JELLYFIN_RECORDINGS_DIR',
    label: 'Custom · Recordings Folder',
    description: 'Recording on this server (local) only: the folder recordings and their schedule are kept in.',
    category: RECORDING,
    type: 'string',
    default: 'addon/data/recordings',
  },
  {
    key: 'JELLYFIN_RECORDINGS_PRE_MINUTES',
    envVar: 'JELLYFIN_RECORDINGS_PRE_MINUTES',
    label: 'Custom · Minutes Before',
    description: "Recording on this server (local) only: minutes recorded before a programme. Dispatcharr's DVR uses its own.",
    category: RECORDING,
    type: 'number',
    default: 1,
    min: 0,
    max: 120,
  },
  {
    key: 'JELLYFIN_RECORDINGS_POST_MINUTES',
    envVar: 'JELLYFIN_RECORDINGS_POST_MINUTES',
    label: 'Custom · Minutes After',
    description: "Recording on this server (local) only: minutes recorded after a programme. Dispatcharr's DVR uses its own.",
    category: RECORDING,
    type: 'number',
    default: 5,
    min: 0,
    max: 240,
  },
  {
    key: 'JELLYFIN_RECORDINGS_KEEP_DAYS',
    envVar: 'JELLYFIN_RECORDINGS_KEEP_DAYS',
    label: 'Custom · Days Kept',
    description: 'Recording on this server (local) only: days a finished recording is kept. 0 keeps it until it is deleted. Dispatcharr deletes nothing by itself.',
    category: RECORDING,
    type: 'number',
    default: 0,
    min: 0,
    max: 3650,
  },
  {
    key: 'JELLYFIN_RECORDINGS_MAX_AT_ONCE',
    envVar: 'JELLYFIN_RECORDINGS_MAX_AT_ONCE',
    label: 'Custom · Recordings at Once',
    description: 'Recording on this server (local) only: the most recordings made at the same time; one more is turned down.',
    category: RECORDING,
    type: 'number',
    default: 4,
    min: 1,
    max: 50,
  },
  {
    key: 'JELLYFIN_SPORTS',
    envVar: 'JELLYFIN_SPORTS',
    label: 'Custom · Live TV Sports',
    description:
      "Games in the Live TV guide get their teams, score and details from ESPN's public scoreboard, and the apps can list the day's games with the channels showing them. Each request to ESPN names only a league and a date. Off: no requests, and the apps show the guide as it is.",
    category: SPORTS,
    type: 'boolean',
    default: true,
  },
  {
    key: 'JELLYFIN_SPORTS_LEAGUES',
    envVar: 'JELLYFIN_SPORTS_LEAGUES',
    label: 'Custom · Live TV Sports Leagues',
    description:
      'The leagues read, by their keys in docs/live-tv-sports.md (nba, nfl, ncaaf, epl, ligamx…). Empty: all of them.',
    category: SPORTS,
    type: 'string',
    default: '',
    uiHint: 'tags',
  },
  {
    key: 'JELLYFIN_SPORTS_BOXERBOOK_KEY',
    envVar: 'JELLYFIN_SPORTS_BOXERBOOK_KEY',
    label: 'Custom · Boxing Data Key (Boxerbook)',
    description:
      "Boxing cards and results come from Boxerbook (ESPN has no boxing). A free key from boxerbook.com/developers/account lets this server read them more often (100 requests a day rather than 50). Kept on this server: it's never sent to the apps. Empty: boxing is read without a key.",
    category: SPORTS,
    type: 'string',
    default: '',
    sensitive: true,
  },
];
