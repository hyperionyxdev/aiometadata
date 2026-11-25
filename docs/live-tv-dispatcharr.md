# Live TV straight from Dispatcharr

Upstream's Jellyfin Live TV (`addon/lib/jellyfin/livetv/`) reads the stream addon's live catalogs.
With Dispatcharr behind it that is four hops (client → this server → the stream addon → a
Dispatcharr addon → Dispatcharr), each with its own cache, and a channel group with a `/` in its
name can't always be asked for through the stream addon.

On `live-tv-upstream` the server can read Dispatcharr itself: client → this server → Dispatcharr.
It is set up with environment variables only. Without `JELLYFIN_DISPATCHARR_URL` (and a login),
nothing changes: Live TV comes from the stream addon, as upstream has it.

Dispatcharr stands in for a live addon (`dispatcharr/addon.ts`): a configuration it's for gets the
stream base `dispatcharr://live`, whose manifest has one `tv` catalog (Dispatcharr's groups, search,
ids and a guide by day), and whose catalog paths are answered from Dispatcharr's lineup and guide.
Upstream's Live TV code then lists, pages, searches and plays it as it would any addon's; a
channel's or a programme's sources (`dispatcharr:…` ids) come from Dispatcharr too.

The image is built under the tag `live-tv-upstream`. The daily "Follow upstream releases"
workflow merges each new upstream release into this branch and builds it.

## What it reads

| What | From Dispatcharr |
| --- | --- |
| Channels | `GET /api/channels/channels/` (one unpaged read), hidden channels left out, the `effective_*` values used |
| Groups | `GET /api/channels/groups/`, as the Live TV view's genres, in channel-number order |
| Provider names | `GET /api/m3u/accounts/`; streams of a switched-off account aren't offered |
| A channel's streams | `GET /api/channels/channels/<id>/?include_streams=true`, when its sources are asked for |
| Guide | `GET /api/epg/grid/?start&end`, one UTC day at a time, matched through `GET /api/epg/epgdata/` (stored programmes by tvg id, Dispatcharr's placeholders by the channel's uuid) |
| Which stream a running channel is on | `GET /proxy/ts/status` (admin only; without it, Auto names the stream it starts with) |
| Switching (optional) | `POST /proxy/ts/change_stream/<uuid>` (admin only) |
| The XC login's channels and catch-up days (optional) | `GET /player_api.php?action=get_live_streams` |

No group name ever goes into a path: groups, search and ids are all matched in this server, so a
group like `24/7 Films` just works.

Players are sent to Dispatcharr's own links, under `JELLYFIN_DISPATCHARR_STREAM_URL`:

- a channel: `/proxy/ts/stream/<channel uuid>`, or `/live/<xc user>/<xc password>/<channel id>.ts`
  with an XC login (it then plays as that user);
- one stream of a channel: `/proxy/ts/stream/<stream hash>`;
- catch-up: `/timeshift/<xc user>/<xc password>/<minutes>/<YYYY-MM-DD:HH-MM>/<channel id>.ts`;
- a logo: `/api/channels/logos/<id>/cache/`.

Clients other than Hyperion are sent a channel as HLS, as on `live-tv`.

## Settings

| Variable | |
| --- | --- |
| `JELLYFIN_DISPATCHARR_URL` | Required. Dispatcharr's address as this server reaches it, for example `http://dispatcharr:9191` on a shared Docker network. Reached directly, not through `HTTPS_PROXY`, and a private address needs no `OUTBOUND_ALLOWED_PRIVATE_HOSTS` entry. |
| `JELLYFIN_DISPATCHARR_API_KEY` | A Dispatcharr API key, or instead: |
| `JELLYFIN_DISPATCHARR_USERNAME`, `JELLYFIN_DISPATCHARR_PASSWORD` | A Dispatcharr login (a token is asked for, refreshed and asked for again as needed). The user must be Standard or Admin; an Admin also lets Auto name the stream a running channel is on, and lets switching work. |
| `JELLYFIN_DISPATCHARR_STREAM_URL` | Where players reach Dispatcharr's links and logos. Defaults to `JELLYFIN_DISPATCHARR_URL`, which is only right when clients can reach that address too. |
| `JELLYFIN_DISPATCHARR_XC_USERNAME`, `JELLYFIN_DISPATCHARR_XC_PASSWORD` | Optional, recommended: an XC login (a Dispatcharr username and that user's XC password). Only that user's channels are listed (their level, adult setting and channel profiles), Auto plays as that user, and a programme that has ended plays from catch-up on channels that have it, within their catch-up days. Without it there is no catch-up. |
| `JELLYFIN_DISPATCHARR_OUTPUT_FORMAT` | Optional: `mpegts`, `hls` or `fmp4` (`ts`, `m3u8`, `mp4` too), asked of Dispatcharr's links. Empty for Dispatcharr's own. |
| `JELLYFIN_DISPATCHARR_USERS` | Optional: who gets this Live TV, comma separated. Each entry is a configuration UUID (every profile in it), a profile's Jellyfin user id (the id clients see, which the server makes from the configuration and the profile), or `<configuration UUID>/<profile id>`. A profile id on its own isn't accepted: any configuration can give one of its profiles the same id. Empty: every configuration on this server. Anyone not listed gets the stream addon's Live TV, as on `live-tv`. |
| `JELLYFIN_DISPATCHARR_GROUPS` | Optional: only these channel groups, comma separated, in this order. Empty: all, in channel-number order. |
| `JELLYFIN_DISPATCHARR_AUTO_SOURCE` | `true` (default): a channel's first version is "Auto", the channel as it is, which Dispatcharr fails over by itself. `false` lists only the streams (Auto stays for a channel with none). |
| `JELLYFIN_DISPATCHARR_SWITCH_STREAMS` | `false` (default). `true`: every version of a channel plays the channel itself, and choosing one of its streams switches the channel to it with Dispatcharr's own switcher (a running channel before playback starts, one that isn't running yet once it does). The answer waits at most three seconds for a switch; a slower one finishes afterwards. Needs an Admin login. |
| `JELLYFIN_DISPATCHARR_NAME` | The label in front of Auto and catch-up ("Dispatcharr · Auto"). Default `Dispatcharr`. |
| `JELLYFIN_DISPATCHARR_TIMEOUT` | Seconds to wait for each request to Dispatcharr, its whole answer included. Default 90: a big lineup takes a while. |
| `JELLYFIN_DISPATCHARR_CACHE_SECONDS` | How long the channel list and a day of the guide are used before they are read again. Default 300. A kept copy answers at once while a new one is read; a guide day kept for over 30 minutes waits for the new read instead. Only the days from a week back to a week ahead (the window `/LiveTv/GuideInfo` reports) are read; others answer with no programmes. |
| `JELLYFIN_DISPATCHARR_HOST_HEADER` | Optional: the Host header to send. Dispatcharr refuses a host name with an underscore (a container named `dispatcharr_vpn`); for one, `localhost` is sent unless this is set. |

Live TV itself is switched on with upstream's `JELLYFIN_LIVETV_ENABLED=true` (off by default), and
the Jellyfin API with `JELLYFIN_API_ENABLED=true`.

### Who should get it

The Dispatcharr login and the XC login are the server's, not a profile's: everyone who gets this
Live TV sees the same channels and plays as the same XC user. On a server only you and your
household use, leave `JELLYFIN_DISPATCHARR_USERS` empty. On a server other people can sign up to,
list your own configuration (or profiles), or they will get your channels too.

## Setting it up with Docker Compose

1. In Dispatcharr, make an API key for a Standard or Admin user (Admin if you want Auto to name the
   running stream, or switching), and note the XC login you use today.
2. Put both containers on one Docker network, or use an address the server can reach.
3. Use the `live-tv-upstream` image and add the settings. Keep the secrets in an `.env` file next
   to the compose file rather than in the compose file itself:

   ```yaml
   services:
     aiometadata:
       image: ghcr.io/<owner>/aiometadata:live-tv-upstream
       env_file: .env
       environment:
         JELLYFIN_DISPATCHARR_URL: http://dispatcharr:9191
         JELLYFIN_DISPATCHARR_STREAM_URL: https://tv.example.com
         JELLYFIN_DISPATCHARR_API_KEY: ${DISPATCHARR_API_KEY}
         JELLYFIN_DISPATCHARR_XC_USERNAME: ${DISPATCHARR_XC_USERNAME}
         JELLYFIN_DISPATCHARR_XC_PASSWORD: ${DISPATCHARR_XC_PASSWORD}
         # JELLYFIN_DISPATCHARR_USERS: <your configuration UUID>
       networks: [default, dispatcharr]
   networks:
     dispatcharr:
       external: true
       name: <the network Dispatcharr is on>
   ```

4. `docker compose up -d`, then check the log: it says `Live TV comes straight from Dispatcharr`,
   then `Read N channels in M groups from Dispatcharr` when a client first opens Live TV.
5. Once you're happy, the stream addon's Dispatcharr addon (and its live catalogs) can go: they
   are no longer read for anyone this Live TV covers.

Channel and programme ids are made from the same meta ids the Dispatcharr addon gave
(`dispatcharr:<channel id>`, type `tv`), so favourite channels carry over where the stream addon
passed those ids on unchanged. A configuration that still gets the stream addon's channels under
the same ids is kept apart: the server holds each source's channels separately.

## What clients get

Everything `live-tv` serves keeps its shape: the Live TV view and its genres, `/LiveTv/Channels`
(groups, favourites, search, paging, the current programme), `/LiveTv/Programs` (GET and POST),
`/LiveTv/Programs/Recommended`, PlaybackInfo with a version per stream, catch-up and favourites. A
Dispatcharr that can't be reached answers 503, as an unreachable addon does.

What the guide adds, which the addon chain lost:

- `Name` is the programme's title, and `EpisodeTitle` its subtitle (the episode's name). A
  subtitle that only says what kind of channel it is is left out: Dispatcharr's "24/7 Channel", or
  one that is the channel's own group name.
- `Genres` from the programme's categories, where Dispatcharr gives them (its placeholder
  programmes from a custom placeholder source with categories; the grid gives none for stored
  programmes), with `IsSports`, `IsNews`, `IsMovie` and `IsKids` read from them.
- `IsLive`, `IsNew` and `IsPremiere` from Dispatcharr's own marks.
- In the `aiostreams` object, beside `catchup`:
  - `placeholder: true` on a programme Dispatcharr made up for a channel without a real guide;
  - `finale: true` on a season or series finale.
- A placeholder's picture (its custom source's poster), as the programme's image.

Each version's `aiostreams` object carries `addon` (the label), `filename`, `resolution` where
Dispatcharr has probed the stream, and `bingeGroup` (`dispatcharr-auto`, `dispatcharr-stream-<id>`
or `dispatcharr-catchup`).

## Tests

```sh
for test in dispatcharr addon; do
  node node_modules/.bin/ts-node --skip-project --transpile-only \
    --compiler-options '{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0","allowJs":true}' \
    addon/lib/jellyfin/dispatcharr/$test.test.ts
done
```

With Node 24, as upstream needs. The first runs the Dispatcharr code against a fake Dispatcharr;
the second runs upstream's Live TV code (the gate, lineup, guide and items) over Dispatcharr as a
live addon, against a fake Dispatcharr, and checks that a configuration on a stream addon still
reads the stream addon. Both use invented channels.
