# Recording Live TV

Live TV can be recorded from a Jellyfin client: one programme, a time window on a channel, or a
series (every airing of a programme's title). Recordings list, play with seeking (while they record
too) and can be deleted, through Jellyfin's own recording calls (`/LiveTv/Timers`,
`/LiveTv/SeriesTimers`, `/LiveTv/Recordings`). A programme set to record carries a `TimerId` (and
a `SeriesTimerId` for a series) wherever the guide lists it.

There are two recorders. One is chosen for the whole server.

## Dispatcharr's DVR (`JELLYFIN_RECORDINGS=dispatcharr`)

The default where Live TV comes from Dispatcharr (see [live-tv-dispatcharr.md](live-tv-dispatcharr.md)).
Dispatcharr records, keeps and plays the recordings, and every call is the one its own web app
makes, so a recording set here is the same as one set in Dispatcharr, and the other way round:

| Here | Dispatcharr |
|---|---|
| Record a programme | `POST /api/channels/recordings/` with the programme's own times and guide details (`custom_properties.program`); Dispatcharr adds its padding |
| Record a window by hand | the same, with only the channel and times (no padding) |
| Record a series | `POST /api/channels/series-rules/` with the programme's tvg id, title and guide source, then `POST /api/channels/series-rules/evaluate/` |
| Cancel one still to start | `DELETE /api/channels/recordings/{id}/` |
| Stop one recording (what was recorded is kept) | `POST /api/channels/recordings/{id}/stop/` |
| Delete a recording (and its file) | `DELETE /api/channels/recordings/{id}/` |
| Delete a series (and its recordings still to start) | `DELETE /api/channels/series-rules/?tvg_id&title&epg_source_id` |
| Play a recording | `GET /api/channels/recordings/{id}/file/` with the player's range; one under way, its `hls/index.m3u8` |

Dispatcharr's own settings apply: its padding (DVR settings, before and after), its folders and
file names, its output profile and comskip. Dispatcharr deletes nothing by itself, so recordings
stay until they are deleted, here or in Dispatcharr.

What it needs:

- Dispatcharr 0.31 or later (0.33 or later for recordings limited to the channels a login sees).
- A login that may manage recordings: an admin, or a standard user whose DVR access is *manage*.
  With *view*, recordings list and play but none can be set. A refusal says so.
- Playback goes through this server, which signs in to Dispatcharr itself: a player never gets
  Dispatcharr's address or login.

A recording uses one of the provider's connections while it runs, as watching does; recording a
channel already being watched shares that one. Dispatcharr turns no recording down for overlapping
others: one with no free connection ends as interrupted ("The channel couldn't be played").

## In the dashboard

Every recording setting can also be set in the dashboard, in its **Custom: Live TV Recording**
section (each label marked "Custom"), and a change there applies without a restart. A value saved
there wins over the environment until it's reset. `JELLYFIN_RECORDINGS=auto` is the same as leaving
it unset: Dispatcharr's DVR where Live TV comes from Dispatcharr, otherwise off.

## On this server (`JELLYFIN_RECORDINGS=local`)

This server records the channel's stream itself, from any Live TV source (Dispatcharr or a stream
addon), into a folder of its own. The stream is saved as it comes (MPEG-TS, or an HLS stream's
parts joined), without converting it.

| Variable | Default | |
|---|---|---|
| `JELLYFIN_RECORDINGS_DIR` | `addon/data/recordings` | where recordings go, and the schedule (`recordings.json`). Put it on a volume. |
| `JELLYFIN_RECORDINGS_PRE_MINUTES` | `1` | minutes recorded before a programme |
| `JELLYFIN_RECORDINGS_POST_MINUTES` | `5` | minutes recorded after it |
| `JELLYFIN_RECORDINGS_KEEP_DAYS` | `0` | days a finished recording is kept; 0 keeps it until it's deleted |
| `JELLYFIN_RECORDINGS_MAX_AT_ONCE` | `4` | the most recorded at the same time |

A recording under way when the server stops carries on when it starts again, in the same file.
A series rule looks two days ahead each hour.

## Who may record

`JELLYFIN_RECORDINGS_USERS` lists who may, as `JELLYFIN_DISPATCHARR_USERS` does (configuration
UUIDs, profiles' Jellyfin user ids, or `<configuration UUID>/<profile id>`). Empty, everyone with
Live TV may. Everyone who may record sees every recording, and can play it. A user who may record
has `EnableLiveTvManagement` in their policy, which clients read to offer it.

## Whose recordings they are

Each recording and series remembers the profiles that set it, in `addon/data/recording-owners.json`
(beside the database, on the data volume in the usual setup): neither recorder keeps who asked.
Two profiles recording the same programme share the one recording; a series' recordings are its
owners'. Timers, recordings and series carry it for a client to read, in `aiostreams`:
`owners` (the profiles' Jellyfin user ids), `mine` (the caller is one of them) and `manage` (the
caller may stop, cancel or delete it for everyone).

- One of several owners stopping, cancelling or deleting it only leaves it; it goes once nobody
  wants it.
- Who set it alone, or the main profile of its household, acts on it for everyone. The main profile,
  one of several owners itself, does so with `ForEveryone=true`; otherwise it leaves it too.
- Anyone else is turned down (403). One with no owner (set before this, or in Dispatcharr's own web
  app) is the household's: any main profile may delete it.

`JELLYFIN_RECORDINGS=off` turns recording off.

## Tests

```sh
for test in dispatcharr local; do
  node node_modules/.bin/ts-node --skip-project --transpile-only \
    --compiler-options '{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0","allowJs":true}' \
    addon/lib/jellyfin/recordings/$test.test.ts
done
```

The first runs Dispatcharr's DVR, and the Jellyfin routes over it, against a fake Dispatcharr that
answers as Dispatcharr's code does. The second records from fake streams to a folder of its own.
Both use invented channels and programmes.
