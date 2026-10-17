# Player Odds

Desktop web app for comparing player prop odds across bookmakers using the SportsGameOdds API: pick league → date → market (statID) → bookmakers, and the table updates live. Markets can be collected into a per-league, per-day CSV (rows = players) and exported from the CSV tab.

```
npm install
npm run dev      # http://localhost:3000, restarts when server.js changes
```

`.env` (git-ignored):

```
SPORTS_ODDS_API_KEY_HEADER=<your key>
PORT=3000          # optional
POLL_SECONDS=5     # optional, live re-check interval on Pro/All-Star
```

How it works, the design decisions behind it, and measured API behaviour: [ARCHITECTURE.md](ARCHITECTURE.md).
