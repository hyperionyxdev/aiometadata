# Live TV sports

Games, scores and team details for the channels in a configuration's Live TV guide, read from
ESPN's public scoreboard. This first part reads the scoreboard and matches its games to the guide,
and reports how well that matching does, so it can be checked on a real guide before any app shows
it.

## What is sent out

One request per league and day, to `site.api.espn.com`, naming only the league and the date
(`/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261127`). Nothing about this server, its
users, its channels or its guide is sent. A day is kept while it can't have changed much: 30 seconds
while a game is on, 2 minutes while one is about to start, an hour otherwise, and 6 hours once all
its games are over.

The scoreboard is public but not documented. Whatever it leaves out is read as missing, and a
league that can't be read is reported as failed.

## Leagues

`addon/lib/jellyfin/sports/leagues.ts`: NBA, WNBA, men's and women's college basketball, NFL,
college football, NHL, MLB, MLS, NWSL, the Premier League, EFL Championship, FA Cup, LaLiga,
Bundesliga, Serie A, Ligue 1, Liga MX, Liga de Expansión MX, Liga MX Femenil, Copa MX, the
Concacaf Champions Cup, the Leagues Cup, the Champions League and the Europa League.

## How games are matched to channels

A team is known by every name ESPN gives it (full, short, nickname and place: "Philadelphia 76ers",
"76ers", "Philadelphia"), compared without accents, full stops or apostrophes, and with "St.",
"Saint" and "State" written one way. A programme or a channel names a game when it names both of its
teams. Where one name sits inside a longer one ("Michigan" in "Michigan State"), the longer one wins,
and every team playing that day is known, so a name isn't taken for a team it's only part of.

- **By a programme:** its name and episode name name the game, and it begins up to 75 minutes before
  the game or 45 after, running at least half an hour into it. A preview that ends as the game
  starts, or a replay later on, isn't the game.
- **By a channel:** a channel made for a game ("4K | NBA | 76ers v Pacers | 4:30 PM PST") names it in
  its own name. Where its name fits several games (a series), it's the one under way, else the next.

## The check

Open, signed in to the dashboard as its administrator (or with the configuration's own page open
with every profile):

```
https://<this server>/api/dashboard/jellyfin/<configuration UUID>/sports-check
```

The configuration UUID is the one in the server address the apps use (`/jellyfin/<UUID>`). It reads
the games from 6 hours ago to 30 hours ahead, and the whole guide over that time, and answers with:

- `leagues`: per league, its games and how many were found on at least one channel.
- `games`: each game with the channels found showing it, and whether by a programme or the channel.
- `unmatchedProgrammes`: programmes named like a game ("X at Y", "X v Y") and marked live or as sport
  that matched no game: a league not read, or a team named in a way not yet known.
- `unmatchedChannels`: channels named like a game that matched none.
- `failed`: leagues whose scoreboard couldn't be read.

It reads the whole guide, so on a large one it takes a few seconds.

## Tests

```sh
node node_modules/.bin/ts-node --skip-project --transpile-only \
  --compiler-options '{"module":"commonjs","target":"es2022","esModuleInterop":true,"ignoreDeprecations":"6.0","allowJs":true}' \
  addon/lib/jellyfin/sports/sports.test.ts
```

With Node 24. It runs the scoreboard reader against a fake scoreboard, and the matching and the check
over invented games, channels and guide.
