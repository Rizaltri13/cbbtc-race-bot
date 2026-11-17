// cbBTC bars-replay race bot: early exposure, disaster brake, no churn.
//
// The bot trades the universe's first symbol (cbBTC) long-only against
// USDC paper money on 1-minute bars, over the agent-fun/bars-replay/v1
// wire (vendored shim in vendor/makefun-bars.ts).
//
// Why it trades the way it does: on this venue a full-size round trip
// costs roughly 0.35-0.40% (4 bps fee + 2 bps slippage per side, plus
// constant-product impact against the pool depth). That cost sets the
// whole game on 1-minute bars. The kit's active baselines (EMA cross,
// ADX momentum, RSI Bollinger) lose 2.5-10% of the stake on the dev
// window through fee bleed and whipsaw timing, and two generations of
// trend-following logic written for this entry lost on every simulated
// regime the same way: by the time a 1-minute trend is "confirmed", the
// move it confirmed is mostly over.
//
// What survives the cost structure is exposure with a disaster brake:
//
//   * Enter almost immediately (bar 12) at near-full size, like the
//     kit's buy-and-hold baseline — the only baseline besides 24-bar
//     momentum that passes the dev gate — unless the window opened
//     with a dump (>= 0.4% under the first close), in which case fall
//     back to waiting for a confirmed uptrend (fast EMA over slow EMA,
//     price over slow EMA, positive 2.5-hour momentum).
//   * While holding, ordinary dips are ridden out. Only a disaster
//     exits: a hard stop 3.0% under the entry reference, a trailing
//     stop 4.5% under the post-entry peak (armed only after a >= 2%
//     gain), or a deep regime break (close 2% under the slow EMA,
//     after bar 400). No re-entry: a stopped-out day is a finished
//     day, so the worst case is one round trip of costs plus one stop.
//   * One small late "probe" trade guarantees the race's minimum
//     activity bar (>= 1 trade) even on a day where neither entry
//     fires: if nothing has traded by bar 1250, buy a small slice and
//     let the end-of-window flatten close it. On a strongly falling
//     day that probe is nearly the whole loss — the cheapest
//     qualifying result a long-only bot can post.
//
// Warm-up handling: when the harness opens with warm-up bars (the bars
// before the scored window, whose orders are all rejected), the adapter
// feeds their closes into the bot's history via noteClose() without
// asking for decisions. The EMAs and the momentum lookback therefore
// start the scored window already warm instead of blind, while every
// seq-based rule (entry bar, probe bar, break bar) still counts scored
// bars only, and the opening-dump veto still anchors on the first
// scored close.
//
// Pure and deterministic: no clock, no randomness, no I/O beyond the
// wire. The same bars always produce the same orders.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

// --- parameters (bars are 1 minute) ---------------------------------------
const ENTRY_BAR = 12; // take exposure this early (fills at the next open)
const DUMP_VETO = 0.004; // skip the early entry if already down this much
const EMA_FAST = 45; // fallback trend entry: ~45 minutes
const EMA_SLOW = 150; // fallback trend entry: ~2.5 hours
const MOM_BARS = 150;
const MOM_MIN = 0.0008; // fallback entry needs momentum above +0.08%
const HARD_STOP = 0.03; // exit if close falls 3.0% below entry reference
const TRAIL_ARM = 0.02; // trailing stop arms after a 2.0% gain
const TRAIL_STOP = 0.045; // exit if close falls 4.5% below post-entry peak
const BREAK_DEPTH = 0.02; // regime break: close this far below the slow EMA
const BREAK_AFTER = 400; // regime break only counts after this bar
const SPEND_FRAC = 0.97; // share of cash deployed on an entry
const PROBE_AT = 1250; // bar by which a first trade must have happened
const PROBE_FRAC = 0.12; // probe size as a share of cash
const MAX_SLIPPAGE_BPS = 1000;

/** The last value of an EMA over `closes` with the given span (seeded with the first close). */
function emaLast(closes: number[], span: number): number {
  const k = 2 / (span + 1);
  let e = closes[0];
  for (let i = 1; i < closes.length; i++) e += k * (closes[i] - e);
  return e;
}

type Action = 'buy' | 'sell' | 'probe' | null;

/** Stateful long-only holder over a single symbol's closes. */
class TrendBot {
  closes: number[] = [];
  inPosition = false;
  entryRef = 0;
  peak = 0;
  probe = false;
  trades = 0;
  done = false; // exited a real position: the window is over
  vetoed = false; // early entry skipped (opening dump)
  anchor = 0; // first scored close: the opening-dump veto compares against it

  /**
   * Record a warm-up bar's close as history only: no decision is taken
   * on it and it consumes no scored seq, but the EMAs and the momentum
   * lookback see it, so the scored window starts with warm indicators.
   */
  noteClose(close: number): void {
    this.closes.push(close);
  }

  /** Feed one scored bar's close (seq is its 0-based scored index). */
  onClose(seq: number, close: number): Action {
    this.closes.push(close);
    if (seq === 0) this.anchor = close;
    const n = this.closes.length;

    if (this.inPosition) {
      if (close > this.peak) this.peak = close;
      if (this.probe) {
        if (close < this.entryRef * (1 - HARD_STOP)) return this.exit(true);
        return null;
      }
      const hard = close < this.entryRef * (1 - HARD_STOP);
      const trailing =
        this.peak > this.entryRef * (1 + TRAIL_ARM) &&
        close < this.peak * (1 - TRAIL_STOP);
      let deepBreak = false;
      if (seq >= BREAK_AFTER && n > EMA_SLOW) {
        const slow = emaLast(this.closes, EMA_SLOW);
        deepBreak = close < slow * (1 - BREAK_DEPTH);
      }
      if (hard || trailing || deepBreak) return this.exit(false);
      return null;
    }

    if (this.done) return null;

    // Minimum-activity probe near the end of the window.
    if (this.trades === 0 && seq >= PROBE_AT) return this.enter(close, true);

    // Early entry: take exposure unless the window opened with a dump.
    if (seq === ENTRY_BAR && this.trades === 0) {
      if (close < this.anchor * (1 - DUMP_VETO)) {
        this.vetoed = true;
        return null;
      }
      return this.enter(close, false);
    }

    // Fallback: confirmed-uptrend entry (only after a veto).
    if (this.vetoed && n > MOM_BARS) {
      const fast = emaLast(this.closes, EMA_FAST);
      const slow = emaLast(this.closes, EMA_SLOW);
      const mom = close / this.closes[n - 1 - MOM_BARS] - 1;
      if (fast > slow && close > slow && mom > MOM_MIN) {
        return this.enter(close, false);
      }
    }
    return null;
  }

  private enter(close: number, probe: boolean): Action {
    this.inPosition = true;
    this.probe = probe;
    this.entryRef = close;
    this.peak = close;
    this.trades += 1;
    return probe ? 'probe' : 'buy';
  }

  private exit(probe: boolean): Action {
    this.inPosition = false;
    this.probe = false;
    this.entryRef = 0;
    this.peak = 0;
    if (!probe) this.done = true;
    return 'sell';
  }
}

// --- wire adapter -----------------------------------------------------------

const bot = new TrendBot();
let symbol = '';
let priceScale = 0;
let counter = 0; // scored bars fed to the strategy so far

await runBars({
  onHello(state: BarsState) {
    const first = state.hello.symbols[0];
    symbol = first.symbol;
    priceScale = first.price_scale;
  },
  onBatch(state: BarsState): OrderInput[] {
    const rawClose = state.close(symbol);
    if (rawClose === null) return [];
    const close = Number(rawClose) / 10 ** priceScale;
    if (state.warmingUp) {
      // History only: warm the indicators, never trade a warm-up bar.
      bot.noteClose(close);
      return [];
    }
    const action = bot.onClose(counter, close);
    counter += 1;
    if (action === null) return [];
    if (action === 'sell') {
      const held = state.positions.get(symbol);
      if (held === undefined || held.qty <= 0n) return [];
      return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    const frac = action === 'buy' ? SPEND_FRAC : PROBE_FRAC;
    let notional = BigInt(Math.floor(Number(state.cash) * frac));
    const room = state.weightRoom(symbol);
    if (room < notional) notional = room;
    if (notional < state.hello.fees.min_notional_quote_units || notional <= 0n) return [];
    return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
