import { setTimeout as sleep } from "node:timers/promises";
import { type TransportHealth, describeError } from "@oguri/core";
import { ulid } from "@oguri/protocol";
import { out } from "../output.ts";

import { type InboxRow, readScope } from "./inbox.ts";
import { type Ctx, bool, list, num, str } from "../context.ts";
import { withBackend } from "../with-backend.ts";

/**
 * Identifier for THIS process's attachment to the network.
 *
 * The agent id stays stable and routable, so two windows of one tool are the
 * same participant; this is what distinguishes them. Taken from the
 * environment when a host supplies one — so a tool that already knows its own
 * session can reuse that id across commands — and minted per process otherwise.
 *
 * It is an opaque tag, never an identity: nothing authenticates it, and it
 * grants nothing.
 */
function sessionTag(): string {
  const supplied = process.env["OGURI_SESSION"];
  if (supplied !== undefined && supplied.trim() !== "") return supplied.trim().slice(0, 64);
  return ulid();
}

/** The network beside this agent's inbox. See `Network.surroundings`. */
export interface Surroundings {
  rooms: string[];
  threads: { room: string; thread: string; from: string; kind: string; needs: string }[];
}

/**
 * Report what is going on next to this agent, once per fact.
 *
 * An agent that joins one room and waits is structurally blind to the rest of
 * the network: routing keeps other rooms out of its inbox, and a conversation
 * started beside it was addressed to somebody else. Both of those are things it
 * would want to know, and neither has ever been said out loud — so waiting has
 * been indistinguishable from there being nothing to know.
 *
 * Metadata only, like every other line here: a room id and a thread id, never a
 * body. This tells an agent where to look; deciding to look is still its call,
 * and `oguri room join` / `oguri read --thread` are the deliberate next step.
 */
function reportSurroundings(
  around: Surroundings | null,
  rooms: Set<string>,
  threads: Set<string>,
): void {
  if (around === null) return;

  // Bounded, because the first poll on an established network would otherwise
  // list every room and every recent thread at once — a wall of context for an
  // agent that asked to be told when something happens. The count still says
  // how much was left out, and `oguri room list` is the full answer.
  const newRooms = around.rooms.filter((room) => !rooms.has(room));
  for (const room of newRooms.slice(0, WATCH_SURROUNDINGS_CAP)) {
    remember(rooms, room);
    out(
      `oguri-room id=${field(room, 60)} state=not-joined` +
        ` join=${field(`oguri room join ${room}`, 80)}`,
    );
  }
  if (newRooms.length > WATCH_SURROUNDINGS_CAP) {
    for (const room of newRooms.slice(WATCH_SURROUNDINGS_CAP)) remember(rooms, room);
    out(
      `oguri-room state=not-joined more=${String(newRooms.length - WATCH_SURROUNDINGS_CAP)}` +
        ` list=oguri+room+list`,
    );
  }

  // Newest first: a conversation that started a minute ago is likelier to still
  // be worth joining than one from this morning.
  const fresh = around.threads.filter((start) => !threads.has(start.thread)).reverse();
  for (const start of fresh.slice(0, WATCH_SURROUNDINGS_CAP)) {
    remember(threads, start.thread);
    out(
      `oguri-thread state=started room=${field(start.room, 60)}` +
        ` thread=${field(start.thread, 40)} from=${field(start.from, 60)}` +
        ` kind=${field(start.kind, 16)} needs=${field(start.needs, 12)} addressed-to=other`,
    );
  }
  if (fresh.length > WATCH_SURROUNDINGS_CAP) {
    for (const start of fresh.slice(WATCH_SURROUNDINGS_CAP)) remember(threads, start.thread);
    out(
      `oguri-thread state=started more=${String(fresh.length - WATCH_SURROUNDINGS_CAP)}` +
        ` read=oguri+room+list`,
    );
  }
}

/** How many surrounding rooms/threads one watcher names before summarising. */
const WATCH_SURROUNDINGS_CAP = 5;

const WATCH_DEFAULT_INTERVAL_S = 15;
const WATCH_MIN_INTERVAL_S = 2;
/**
 * Bounds the ids remembered for deduplication. Items leave the inbox when
 * drained, so the live set is small; this only caps the tail of parked
 * `needs: human` ids, which an agent structurally cannot drain (ADR 0012).
 */
const WATCH_SEEN_CAP = 5000;

/**
 * Stream inbox arrivals as one line each, for an agent to run as a monitor.
 *
 * **Metadata only, never a body.** Every line here becomes a notification in a
 * live agent session, and bodies are text written on other machines. Emitting
 * one would mean remote text entering an agent's context through a notification
 * that arrived on its own — the exact shape of injection the rest of this
 * design avoids. The agent fetches bodies deliberately, with `oguri inbox`,
 * at a point where it has already framed them as data.
 *
 * Failure is announced rather than swallowed: a watcher that goes quiet when
 * `oguri` starts failing is indistinguishable from a network with nothing to
 * say, and the agent would wait forever on a reply that can never arrive.
 *
 * Two properties this has to keep, both learned from watchers that lied:
 *
 * **Silence is only reported when it was checked.** A poll that could not reach
 * the remote knows nothing about the room, so every line carries whether the
 * view behind it was confirmed, and a `--wait` that expires says which kind of
 * nothing it found. "No new messages" from a watcher that has not synced in an
 * hour is a false negative, and an agent acts on it exactly as it would on the
 * truth.
 *
 * **An item already in the inbox is not an arrival.** `--wait` fires on
 * anything matching, including items pending since before it started, so a
 * watcher relaunched on an undrained inbox reported the same message as "just
 * arrived" three times running. Each line now says which it is, and
 * `--new-only` waits for a genuine arrival.
 */
export async function cmdWatch(ctx: Ctx): Promise<number> {
  const room = str(ctx, "room");
  const thread = str(ctx, "thread");
  const tag = list(ctx, "tag")[0];
  const needs = str(ctx, "needs");
  const once = bool(ctx, "once");
  const newOnly = bool(ctx, "new-only");
  const wait = num(ctx, "wait");
  const interval = Math.max(WATCH_MIN_INTERVAL_S, num(ctx, "interval") ?? WATCH_DEFAULT_INTERVAL_S);

  return await withBackend(
    ctx,
    async (be) => {
      const seen = new Set<string>();
      let consecutiveFailures = 0;
      let announcedFailure = false;
      // `--wait` turns the stream into a single blocking question: "tell me when
      // one matching thing arrives". An agent turn cannot spin, so without this
      // the only options were to burn turns polling or hand back to the human.
      let matched = 0;
      // Whether the most recent poll actually reached the remote. `--wait`
      // reports it on timeout so "nothing came" cannot be confused with
      // "nothing could be checked".
      let confirmed = false;
      // Reported once each per watcher, not once per poll: a room that exists
      // and a conversation that started are standing facts, and repeating them
      // every fifteen seconds would cost an agent tokens to be told nothing.
      const announcedRooms = new Set<string>();
      const announcedThreads = new Set<string>();
      /** Items already pending when a `--new-only` watcher armed. */
      let backlog = 0;
      // Everything already pending when the watcher armed. Those are backlog,
      // not arrivals, and saying so is what stops a relaunched watcher
      // announcing week-old mail as news.
      let armed = false;

      // Which networks this watcher covers. An agent waiting for work should
      // not have to know which transport repo the answer will arrive on, and
      // picking one was previously the price of waiting at all.
      const scope = await readScope(ctx, be);

      const pollOne = async (network: string | undefined): Promise<void> => {
        try {
          // In direct mode nothing else is pulling, so the watcher has to. A
          // watching session does not need to: opening it wakes the daemon into
          // its hot cadence, and syncing here would only fight that. `--once` is
          // not a session, though — it asks "what is there right now", and
          // answering that from the cache would report a stale inbox as empty.
          if (be.mode !== "daemon" || once) await be.call("sync", {}, network);

          const [health, items, around] = await Promise.all([
            be.call<TransportHealth>("health", {}, network),
            be.call<InboxRow[]>(
              "inbox",
              {
                ...(room === undefined ? {} : { room }),
                ...(needs === undefined ? {} : { needs }),
                ...(tag === undefined ? {} : { tag }),
              },
              network,
            ),
            // What is happening beside this agent's inbox. Free — the room list
            // rides on the same poll — and the reason an agent that joined one
            // room and waited had no way to learn the team had started another.
            be.call<Surroundings>("surroundings", {}, network).catch(() => null),
          ]);
          reportSurroundings(around, announcedRooms, announcedThreads);

          // With a daemon the watcher does not sync itself, so "did anyone
          // look" is a question about the daemon's last sync, not about this
          // process. A degraded transport means this poll saw a cache nobody
          // has refreshed — the silence it would otherwise report is unearned.
          confirmed = !health.degraded;
          if (!confirmed && !announcedFailure) {
            announcedFailure = true;
            out(
              `watch-degraded reason=${field(health.reason ?? "sync has not succeeded", 120)}` +
                ` last-sync=${field(health.lastSyncAt ?? "never", 40)}`,
            );
          } else if (confirmed && announcedFailure) {
            out("watch-recovered oguri reachable again");
            announcedFailure = false;
          }
          consecutiveFailures = 0;

          for (const item of items) {
            if (seen.has(item.id)) continue;
            remember(seen, item.id);
            if (thread !== undefined && item.thread !== thread) continue;
            // Pending before this watcher existed, versus arrived while it was
            // watching. Only the second is news.
            const state = armed ? "new" : "pending";
            if (state === "new" || !newOnly) matched += 1;
            // `--new-only` says the backlog is not what this watcher is for, so
            // it does not list it either. Printing it and then refusing to wake
            // on it was the worst of both: an agent read the same items again
            // and could not tell why they had not satisfied the wait.
            if (newOnly && state === "pending") {
              backlog += 1;
              continue;
            }
            out(
              `oguri-inbox state=${state} id=${field(item.id, 40)} room=${field(item.room, 60)}` +
                // Named only when this watcher spans several: acting on the item
                // means answering on that network, so a merged stream that hid
                // which one it came from would be worse than not merging.
                (network === undefined ? "" : ` network=${field(network, 60)}`) +
                ` from=${field(item.from, 60)} needs=${field(item.needs, 12)}` +
                ` priority=${field(item.priority, 12)} kind=${field(item.kind, 16)}` +
                ` thread=${field(item.thread, 40)} tags=${field((item.tags ?? []).join(","), 80)}`,
            );
          }
          // Said once, as a number: the agent should know a backlog exists
          // without being handed it again on a watcher that asked for arrivals.
          if (!armed && backlog > 0) {
            out(`watch-backlog pending=${String(backlog)} read=oguri+inbox`);
          }
          armed = true;
        } catch (error) {
          confirmed = false;
          consecutiveFailures += 1;
          // One line after a sustained outage, then silence until it recovers:
          // enough for the agent to notice and run `oguri doctor`, not enough to
          // flood a session while a laptop is asleep.
          if (consecutiveFailures >= 3 && !announcedFailure) {
            announcedFailure = true;
            out(
              `watch-degraded consecutive-failures=${String(consecutiveFailures)}` +
                ` reason=${field(describeError(error), 120)}`,
            );
          }
        }
      };

      /** One pass over every network in scope. Sequential: the daemon is one socket. */
      const poll = async (): Promise<void> => {
        for (const network of scope) await pollOne(network);
      };

      const filters = [
        room === undefined ? null : `room:${room}`,
        thread === undefined ? null : `thread:${thread}`,
        tag === undefined ? null : `tag:${tag}`,
        needs === undefined ? null : `needs:${needs}`,
      ].filter((f) => f !== null);
      // The effective context, printed before anything else. A watcher armed on
      // the wrong network reports the right answer about the wrong place, and
      // that reads exactly like a quiet room — so which network and identity
      // this process resolved is the first thing its reader has to be able to
      // check, not something to reconstruct from a bug report afterwards.
      const context = await be
        .call<{ networkId: string; agentId: string; subscriptions: string[] }>("status")
        .catch(() => null);
      out(
        `watch-armed poll=${String(interval)}s mode=${be.mode}` +
          ` sync=${be.mode === "daemon" ? "daemon" : "self"}` +
          ` network=${field(
            scope.length > 1 ? `all(${scope.join(",")})` : (context?.networkId ?? "unknown"),
            120,
          )}` +
          ` agent=${field(context?.agentId ?? "unknown", 60)}` +
          `${wait === undefined ? "" : ` wait=${String(wait)}s`}` +
          `${newOnly ? " new-only=true" : ""}` +
          ` filter=${filters.length === 0 ? "none" : filters.join(",")}`,
      );
      if (room !== undefined && context !== null && !context.subscriptions.includes(room)) {
        // Watching a room this agent does not follow can only ever report
        // nothing: routing never files it into this inbox in the first place.
        out(
          `watch-degraded reason=${field(`not subscribed to #${room} — oguri room join ${room}`, 120)}`,
        );
      }

      await poll();
      if (once) return 0;

      // A watching agent IS a live session, and in direct mode nothing else says
      // so — the daemon publishes presence on session open, but there is no
      // daemon here. Without this a peer blocked on `--wait` reads as `away`, and
      // the agent that greeted it is told "nobody is live, the reply may take
      // hours" about a peer that is listening right now.
      //
      // `--once` is excluded deliberately: it is a peek, not a session, and
      // claiming presence for the length of one poll would be the same kind of
      // overclaim in the other direction.
      const announcing = be.mode !== "daemon";
      const session = sessionTag();
      if (announcing) {
        await be.call("announce", { status: "live", session }).catch(() => undefined);
      }
      const standDown = async (): Promise<void> => {
        // Names this session, so leaving takes only this one away. Another window
        // of the same agent still watching keeps the agent live.
        if (announcing)
          await be.call("announce", { status: "away", session }).catch(() => undefined);
      };

      // Blocking mode: return as soon as one matching item lands, or when the
      // bound expires. Exit 3 for the timeout so a caller can tell "nothing came"
      // from "the command failed" without parsing output.
      if (wait !== undefined) {
        const deadline = Date.now() + wait * 1000;
        while (matched === 0 && Date.now() < deadline) {
          await sleep(Math.min(interval * 1000, Math.max(0, deadline - Date.now())));
          if (matched > 0) break;
          await poll();
        }
        await standDown();
        if (matched === 0) {
          // `checked` is the difference between "the room is quiet" and "this
          // watcher never managed to look". Both produce no lines; only one of
          // them is evidence, and an agent that treats the second as the first
          // reports a colleague as silent while their message sits unfetched.
          out(
            `watch-timeout after=${String(wait)}s nothing matched` +
              ` checked=${confirmed ? "confirmed" : "UNCONFIRMED"}`,
          );
          return confirmed ? 3 : 4;
        }
        return 0;
      }

      // Chained timeout rather than an interval: a slow poll must not let the
      // next one stack up behind it.
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        // Clearing the timer is not enough on its own. A signal arriving while a
        // poll is in flight would still run the `.then(schedule)` below, arming a
        // fresh timer after this promise resolved — which keeps the event loop
        // alive past shutdown and then fires against a closed backend.
        let stopped = false;
        const stop = () => {
          stopped = true;
          clearTimeout(timer);
          resolve();
        };
        const schedule = () => {
          if (stopped) return;
          timer = setTimeout(() => {
            void poll().then(schedule);
          }, interval * 1000);
        };
        schedule();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      await standDown();
      return 0;
    },
    // A watcher keeps running, so it is a session in the sense the daemon
    // means: it publishes `live` on arrival and `away` on exit, once. `--once`
    // is a peek — it must not write a transition pair for a single poll.
    { session: !once },
  );
}

/**
 * Sanitise one field for an event line.
 *
 * Values reach a notification in an agent session, so they get the treatment
 * the daemon's notifier gives text bound for AppleScript: no control
 * characters, no newlines, bounded length. Ids and room names are
 * protocol-shaped, but "should be" is not a validation strategy for input that
 * arrived from another machine.
 */
function field(value: unknown, max: number): string {
  const text = String(value ?? "")
    // Stripping control characters is precisely the intent here: they arrive
    // inside text written on another machine, so the rule below is matching
    // them on purpose rather than assuming they will not be present.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || "-";
}

function remember(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size <= WATCH_SEEN_CAP) return;
  // Set iteration is insertion-ordered, so this evicts oldest-first.
  let excess = seen.size - WATCH_SEEN_CAP;
  for (const key of seen) {
    seen.delete(key);
    if (--excess <= 0) break;
  }
}
