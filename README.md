[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/Rizaltri13/cbbtc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/Rizaltri13/cbbtc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

# BRAKE — a cbBTC race bot for make.fun

Entry for the make.fun bounty **btc-race-24h-20261117-0603** — "Race a BTC trading bot live for 24 hours". The bot trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars with $1,000 of paper money, over the `agent-fun/bars-replay/v1` protocol. Nothing is traded for real.

## The idea

On this venue a full-size round trip costs roughly 0.35–0.40%: 4 bps fee + 2 bps slippage per side, plus constant-product price impact against the pool depth. That cost sets the whole game on 1-minute bars — active strategies bleed it away trade after trade (the kit's EMA-cross baseline loses ~10% of its stake on the dev window). BRAKE therefore makes as few decisions as possible:

- **Early exposure.** It buys at bar 12 with 97% of its cash and holds, unless the window opened with a dump (≥ 0.4% under the first close) — then it waits for a confirmed uptrend (fast EMA over slow EMA, price over slow EMA, positive 2.5-hour momentum) instead.
- **Disaster brake.** Ordinary dips are ridden out. It exits only on a hard stop 3.0% under the entry reference, a trailing stop 4.5% under the post-entry peak (armed after a ≥ 2% gain), or a deep regime break (close 2% under the slow EMA after bar 400). No re-entry: a stopped-out day is a finished day.
- **Activity probe.** If nothing has traded by bar 1250, it buys a small 12% slice so the race's minimum-activity bar (≥ 1 trade) is met even on a day that never trends, and lets the end-of-window flatten close it. On a strongly falling day that probe is nearly the whole loss.

Dev-window grade (kit grader, dev dataset): **net PnL +$3.99 on $1,000, 1 trade, max drawdown 2.06%** — it passes the dev gate (net PnL > $0) and stays far inside the race's 25% drawdown bar.

## Files

- `main.ts` — the bot: strategy + wire adapter (Node 22, standard library only at runtime).
- `vendor/makefun-bars.ts` — the competition SDK shim, vendored byte-identical from the kit.
- `LICENSE` — MIT.

## Running it

The grader runs `node main.ts` and speaks the bars-replay protocol on stdio: one JSON line per minute in, one reply line out. The bot is pure and deterministic — no clock, no randomness, no network, no files — so two runs on the same bars produce byte-identical orders.
