# Live TV sports

Games, scores and team details for the channels in a configuration's Live TV guide, read from
ESPN's public scoreboard and matched to the guide by this server. The apps get them on the guide's
programmes and in a list of the day's games; a check in the dashboard shows how well the matching
does on a real guide.

## Settings

In the dashboard's "Custom: Live TV Sports" section, or the environment:

- `JELLYFIN_SPORTS`: on by default. Off: nothing is asked of ESPN and the guide is sent as it is.
- `JELLYFIN_SPORTS_LEAGUES`: the leagues read, by key (below); empty for all.

## What is sent out

One request per league and day, to `site.api.espn.com`, naming only the league and the date
(`/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261127`). Nothing about this server, its
users, its channels or its guide is sent. A day is kept while it can't have changed much: 30 seconds
while a game is on, 2 minutes while one is about to start, an hour otherwise, and 6 hours once all
its games are over.

The scoreboard is public but not documented. Whatever it leaves out is read as missing, and a
league that can't be read is reported as failed.

## Leagues

`addon/lib/jellyfin/sports/leagues.ts`, by key: `nba`, `wnba`, `gleague` (NBA G League), `ncaam` and
`ncaaw` (men's and women's college basketball, all of Division I rather than the scoreboard's few
featured games), `nfl`, `ncaaf` (college football), `nhl`, `mlb`, `mls`, `nwsl`, `epl` (Premier
League), `efl` (EFL Championship), `facup`, `laliga`, `bundesliga`, `seriea`, `ligue1`, `ligamx`,
`ligaexp` (Liga de Expansión MX), `ligamxf` (Liga MX Femenil), `copamx`, `concacaf` (Concacaf Champions
Cup), `leaguescup`, `concacafw` (Concacaf W Championship), `wgoldcup` (Concacaf W Gold Cup), `ucl`
(Champions League), `uel` (Europa League), and the fight cards of `ufc` and `pfl`.

A fight card is one game: its main event's fighters are its two sides, and `bouts` lists every fight
in the order ESPN gives (prelims first), each with its weight class, start, state, fighters (a flag as
the logo, record, winner), and once over its `method` ("KO/TKO", "Submission", "Decision"), `round`
and `time`. While it's on, its `detail` names the fight under way and how many are left. It's found by
its own name ("UFC 334 Prelims", "UFC Fight Night") or both main-event fighters, from just before its
prelims to the end of its main card. ESPN has no boxing.

## How games are matched to channels

A team is known by every name ESPN gives it (full, short, nickname and place: "Philadelphia 76ers",
"76ers", "Philadelphia"), compared without accents, full stops or apostrophes, with "St.",
"Saint" and "State" written one way, and Spanish guides' names for countries read as ESPN's
("Estados Unidos", "Inglaterra", "Corea del Sur"). A programme or a channel names a game when it names both of its
teams. Where one name sits inside a longer one ("Michigan" in "Michigan State"), the longer one wins,
and every team playing that day is known, so a name isn't taken for a team it's only part of.

- **By a programme:** its name and episode name name the game, and it begins up to 75 minutes before
  the game or 90 after (joined late, or a guide an hour out, as some for Mexico's channels are),
  running at least half an hour into it. A preview that ends as the game
  starts, or a replay later on, isn't the game.
- **By a channel:** a channel made for a game ("4K | NBA | 76ers v Pacers | 4:30 PM PST") names it in
  its own name. Where its name fits several games (a series), it's the one under way, else the next.

- **Around a game on its own channel:** the channel's build-up before the game ("Coming up…") and its
  wrap-up after ("Final") are that game's too, within a day of it.

## What the apps get

- **On a programme** (`/LiveTv/Programs`, a programme by id, a channel's programme on now):
  `aiostreams.game`, the game it shows, with `part`: `game` for the game itself, `before` and `after`
  for a game channel's build-up and wrap-up. The game has its `id`, `league` and `leagueName`, `name`,
  `start`, `state` (`pre`, `in` or `post`), `detail` ("Q3 4:12", "Final"), `period` and `clock` while
  it's on, `off` when put off or called off, `venue`, `city`, `broadcasts`, `note`, and `home` and
  `away` teams with `name`, `short`, `abbreviation`, `logo`, `color`, `alternateColor`, `record`,
  `rank`, and `score` and `winner` once begun.
- **The day's games**, `GET /AIOStreams/Games` (signed in): from 6 hours ago to 30 hours ahead, or
  `From` and `To`, and one league by `League`. Each game as above, with `channels`, best first: a
  channel made for the game (4K first), then a programme marked live, then the rest, in channel number
  order. Each channel has its `Id`, `Name`, `Number`, `ChannelPrimaryImageTag` and `by`, and, where the
  guide has the game on it, `ProgramId`, `StartDate`, `EndDate` and `IsLive`. Kept 20 seconds.
- **Team logos**, `GET /AIOStreams/Sports/Logo/{league}/{team}` (the `logo` path): fetched by this
  server from ESPN's image host only, and kept a week, so the apps never ask ESPN.

The guide waits at most a second and a half for games the first time they're read; after that, the
last games found are used while newer ones are read, so it never waits on ESPN.

## The check

In the dashboard: Settings, "Custom: Live TV Sports", **Check the guide**. It shows each league's
games and how many were found on a channel, what matched none, and every game with its channels, and
**Copy the results** copies the summary as text. Behind it, for the administrator:

```
https://<this server>/api/dashboard/jellyfin/sports-check
```

It checks every configuration with Live TV, once for each guide: `guides`, each naming the
`configurations` that share it. One configuration alone, with its own page open with every profile:
`/api/dashboard/jellyfin/<configuration UUID>/sports-check`, the UUID being the one in the server
address the apps use (`/jellyfin/<UUID>`). It reads
the games from 6 hours ago to 30 hours ahead, and the whole guide over that time, and answers with:

- `leagues`: per league, its games and how many were found on at least one channel.
- `games`: each game with the channels found showing it, and whether by a programme or the channel.
- `unmatchedProgrammes`: programmes named like a game ("X at Y", "X v Y") and marked live or as sport
  that matched no game: a league not read, or a team named in a way not yet known.
- `unmatchedChannels`: channels named like a game that matched none.
- `nearMisses`: games found on no channel, each with up to five programmes within three hours of
  its start that name one of its teams: where a guide names a team in a way not yet known, or a game
  is listed at a time too far from ESPN's.
- `failed`: leagues whose scoreboard couldn't be read.

The whole guide is read, a thousand channels at a time.

It reads the whole guide, so on a large one it takes a few seconds.

## Tests

```sh
node node_modules/.bin/ts-node --skip-project --transpile-only \
  --compiler-options '{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0","allowJs":true}' \
  addon/lib/jellyfin/sports/sports.test.ts
```

With Node 24. It runs the scoreboard reader against a fake scoreboard, and the matching and the check
over invented games, channels and guide.
