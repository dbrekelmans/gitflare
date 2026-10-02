import { type Id, type IdKind, makeId, ulid } from "../ids";
import type { Clock, IdGenerator } from "./runtime";

export const systemClock: Clock = { now: () => Date.now() };

/** Ids from the clock and the platform's random source: what production uses. */
export function createIdGenerator(clock: Clock = systemClock): IdGenerator {
  return {
    next<K extends IdKind>(kind: K): Id<K> {
      return makeId(
        kind,
        ulid(clock.now(), (length) => crypto.getRandomValues(new Uint8Array(length))),
      );
    },
  };
}
