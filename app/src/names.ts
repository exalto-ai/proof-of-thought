/**
 * Playful, stable names for peers that never introduced themselves.
 *
 * A window has no name of its own, and "Window 72" is worse than useless — it
 * tells you nothing and looks like a bug. A name has to be *stable* for the
 * same peer (so you learn who is who across a session) and *distinct* between
 * peers, which means deriving it from the Yjs client id rather than picking at
 * random.
 *
 * Agents keep whatever name their client sent. Renaming something the user
 * named would be worse than the problem.
 */
const ADJECTIVES = [
  "Amber", "Quiet", "Copper", "Distant", "Patient", "Wandering", "Clever",
  "Gentle", "Restless", "Marbled", "Bright", "Solemn", "Nimble", "Curious",
  "Steady", "Wistful", "Bold", "Drifting", "Keen", "Sunlit",
];

const CREATURES = [
  "Heron", "Marten", "Otter", "Falcon", "Badger", "Wren", "Lynx", "Puffin",
  "Ibis", "Hare", "Kestrel", "Vole", "Auk", "Stoat", "Plover", "Shrike",
  "Sable", "Curlew", "Finch", "Grebe",
];

/** Mixes the bits so nearby client ids do not land on adjacent names. */
function scramble(seed: number): number {
  let x = seed >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

export function playfulName(seed: number): string {
  const mixed = scramble(seed);
  const adjective = ADJECTIVES[mixed % ADJECTIVES.length];
  // A second, independent index, or every "Amber" would share a creature.
  const creature = CREATURES[Math.floor(mixed / ADJECTIVES.length) % CREATURES.length];
  return `${adjective} ${creature}`;
}

const PALETTE = ["#4c8dff", "#e0a44a", "#b98cff", "#5ac88f", "#ff7a6b", "#3fb8b0"];
export const FALLBACK_PRESENCE_COLOR = "#888";

export function colorFor(seed: number): string {
  return PALETTE[scramble(seed) % PALETTE.length];
}

/** Hash a string to a seed, for actors identified by id rather than number. */
export function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * How an actor's name reads in the window: "ChatGPT chat (reported)" or
 * "Suggestion from ChatGPT chat (reported)" as "ChatGPT". The "(reported)"
 * marker records that the name is a claim; the places that show it say so
 * once rather than on every label. Built-in chat (`pro-chat`) drops "chat",
 * which only says where the request came from.
 */
export function actorDisplayName(label: string, builtInChat: boolean): string {
  let name = label.replace(/^Suggestion from /, "").replace(/\s*\(reported\)$/, "").trim();
  if (builtInChat) name = name.replace(/\s+chat$/i, "");
  return name || "AI";
}
