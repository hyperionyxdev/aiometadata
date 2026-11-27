# Recording Live TV

Live TV can be recorded from a Jellyfin client: one programme, a time window on a channel (with a
name, if wanted), a series (every airing of a programme's title), or, with Dispatcharr's DVR, a
repeating recording (a time slot on a channel on chosen weekdays). Recordings list, play with
seeking (while they record too) and can be deleted, through Jellyfin's own recording calls
(`/LiveTv/Timers`, `/LiveTv/SeriesTimers`, `/LiveTv/Recordings`). A programme set to record carries
a `TimerId` (and a `SeriesTimerId` for a series) wherever the guide lists it.

There are two recorders. One is chosen for the whole server.

## Dispatcharr's DVR (`JELLYFIN_RECORDINGS=dispatcharr`)

The default where Live TV comes from Dispatcharr (see [live-tv-dispatcharr.md](live-tv-dispatcharr.md)).
Dispatcharr records, keeps and plays the recordings, and every call is the one its own web app
makes, so a recording set here is the same as one set in Dispatcharr, and the other way round:

| Here | Dispatcharr |
|---|---|
| Record a programme | `POST /api/channels/recordings/` with the programme's own times and guide details (`custom_properties.program`); Dispatcharr adds its padding |
| Record a window by hand | the same, with only the channel and times (no padding) |
| Record a window by hand, named | the same, with the name as its programme (`custom_properties.program`) and the times drawn in by Dispatcharr's padding, which it adds back |
| Record a series | `POST /api/channels/series-rules/` with the programme's tvg id, title and guide source, then `POST /api/channels/series-rules/evaluate/` |
| Record a time slot on weekdays (repeating) | `POST /api/channels/recurring-rules/` with the channel, name, weekdays, times of day and first and last days, in Dispatcharr's time zone |
| List repeating recordings | `GET /api/channels/recurring-rules/`, and the time zone from `GET /api/core/settings/` (`system_settings`) |
| Cancel one still to start | `DELETE /api/channels/recordings/{id}/` |
| Stop one recording (what was recorded is kept) | `POST /api/channels/recordings/{id}/stop/` |
| Delete a recording (and its file) | `DELETE /api/channels/recordings/{id}/` |
| Delete a series (and its recordings still to start) | `DELETE /api/channels/series-rules/?tvg_id&title&epg_source_id` |
| Delete a repeating recording (and its recordings still to start) | `DELETE /api/channels/recurring-rules/{id}/` |
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

## Recordings set by hand, and repeating ones

A window set by hand (`POST /LiveTv/Timers` with `ChannelId`, `StartDate` and `EndDate`, no
`ProgramId`) records exactly that window, with no padding. With a `Name`, Dispatcharr's DVR keeps
it as the recording's title, shown in its web app too: it's sent as a programme of that name, and
as Dispatcharr pads a programme, its times are sent drawn in by the padding, so what is recorded is
still the window asked for. A window no longer than the padding (or with Dispatcharr's settings
unreadable, so its padding unknown) goes without its name. This server's own recorder keeps the
name as the recording's title.

A repeating recording is a time slot on a channel, on chosen weekdays, until a last day; only
Dispatcharr's DVR makes them (its recurring rules). A client sets one with
`POST /LiveTv/SeriesTimers` carrying a `ChannelId` and no `ProgramId`:

```json
{ "ChannelId": "…", "Name": "Morning News",
  "StartDate": "2026-11-30T17:30:00.000Z", "EndDate": "2026-11-30T18:30:00.000Z",
  "Days": ["Monday", "Friday"], "TimeZone": "America/Los_Angeles", "RepeatUntil": "2027-02-28" }
```

`StartDate` and `EndDate` are the first recording's window (any padding already in it); `Days`
and `RepeatUntil` are in the client's `TimeZone`. Dispatcharr keeps a schedule in its own time zone
(its System Settings), so the times of day become that zone's, and the weekdays move with the date
where the two zones are on different days at that time. With no `RepeatUntil`, it repeats for 90
days, and at most for 400: Dispatcharr sets every recording up to the last day at once. One needs a
day, a window of at most 24 hours, and a recording still to come; otherwise it's turned down (400)
with the reason in `Message`. This server's own recorder turns one down: "Repeating recordings need
Dispatcharr's DVR".

Listed with the series (`GET /LiveTv/SeriesTimers`), each is a series timer with `Days`,
`DayPattern` (`Daily`, `Weekdays` or `Weekends`, where it's one), its next recording as
`StartDate` and `EndDate` (its last, once none is left), and in `aiostreams.repeats` the days
(0 for Monday), times, first and last days and time zone as Dispatcharr keeps them, with `next` and
`nextEnd` (null once none is left). The recordings it sets carry its id as `SeriesTimerId` and are
its owners'. Deleting it is as deleting a series: one of several owners only leaves it.
`GET /LiveTv/Timers/Defaults` answers without a `ProgramId` too (the padding alone), and says in
`aiostreams.repeats` whether the recorder makes repeating recordings.

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

Each recording, series and repeating recording remembers the profiles that set it, in
`addon/data/recording-owners.json` (beside the database, on the data volume in the usual setup):
neither recorder keeps who asked. Two profiles recording the same programme share the one
recording; a series' recordings, and a repeating recording's, are its owners'. Timers, recordings
and series carry it for a client to read, in `aiostreams`: `owners` (the profiles' Jellyfin user
ids), `mine` (the caller is one of them) and `manage` (the caller may stop, cancel or delete it for
everyone).

- One of several owners stopping, cancelling or deleting it only leaves it; it goes once nobody
  wants it.
- Who set it alone, or the main profile of its household, acts on it for everyone. The main profile,
  one of several owners itself, does so with `ForEveryone=true`; otherwise it leaves it too.
- Anyone else is turned down (403). One with no owner (set before this, or in Dispatcharr's own web
  app) is the household's: any main profile may delete it.

`JELLYFIN_RECORDINGS=off` turns recording off.

## Skipping ads

Dispatcharr's commercial detection (Comskip, in its DVR settings) runs on each recording once it
ends. In its **Cut** mode the ads are taken out of the file itself, and nothing more is needed. In
its **Mark** mode the file stays as it was and Dispatcharr writes the ads' times in an edit list
(`.edl`) beside it; a recording's ads are then answered here as Jellyfin's own commercial segments
(`GET /MediaSegments/{recordingId}`, `Type: Commercial`), which a player offers to skip and marks on
its seek bar as it does an intro.

Dispatcharr has no call for that list, so this server reads it from disk:

- Share Dispatcharr's recordings folder with this server's container, read-only (in its compose
  file, under `volumes:`, the folder Dispatcharr's `/data/recordings` is on, mounted at
  `/dispatcharr-recordings:ro`, say).
- Set `JELLYFIN_RECORDINGS_DISPATCHARR_DIR` to where it's mounted (`/dispatcharr-recordings`), or
  **Custom · Dispatcharr's Recordings Folder** in the dashboard.

The list is found by the end of the path Dispatcharr gives for it, so the folder shared may be its
recordings folder or one above it; nothing outside it is read. Only a recording Dispatcharr marked
in Mark mode has ads: one whose ads were cut out, one never checked, and one still recording have
none. A list that changes (the detection run again from Dispatcharr's web app) is read again.

## Tests

```sh
for test in dispatcharr local owners adMarks repeats; do
  node node_modules/.bin/ts-node --skip-project --transpile-only \
    --compiler-options '{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0","allowJs":true}' \
    addon/lib/jellyfin/recordings/$test.test.ts
done
```

The first runs Dispatcharr's DVR, and the Jellyfin routes over it, against a fake Dispatcharr that
answers as Dispatcharr's code does. The second records from fake streams to a folder of its own.
The third gives recordings to profiles and takes them back; the fourth reads edit lists from a
folder of its own; the fifth turns repeating recordings between time zones on fixed dates. All use
invented channels and programmes.
