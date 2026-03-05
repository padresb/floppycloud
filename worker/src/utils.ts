const ADJECTIVES = [
  "amber", "ancient", "arctic", "autumn", "azure", "blazing", "bold",
  "calm", "cedar", "coastal", "cobalt", "copper", "coral", "cosmic",
  "crimson", "crystal", "curious", "dappled", "dawn", "deep", "desert",
  "distant", "drifting", "dusk", "dusty", "electric", "emerald", "empty",
  "endless", "faded", "fallen", "fern", "fierce", "floating", "foggy",
  "forest", "frosted", "gentle", "gilded", "glacial", "golden", "granite",
  "gravel", "hollow", "horizon", "humble", "indigo", "inland", "iron",
  "ivory", "jade", "jagged", "jasper", "kind", "lavender", "leafy",
  "lemon", "lunar", "marble", "meadow", "misty", "mossy", "narrow",
  "noble", "northern", "obsidian", "ocean", "olive", "onyx", "opal",
  "pale", "patient", "pearl", "pebble", "pine", "plain", "polar",
  "quiet", "radiant", "ragged", "rapid", "raven", "remote", "rocky",
  "rosy", "rough", "russet", "rustic", "sable", "sacred", "saffron",
  "sandy", "sapphire", "scarlet", "serene", "shaded", "shallow", "silver",
  "slate", "slow", "smoky", "snowy", "solar", "somber", "sparse",
  "starlit", "steady", "steep", "still", "stony", "stormy", "sudden",
  "summer", "sunlit", "swift", "tangerine", "teal", "timber", "twilight",
  "upper", "vast", "velvet", "verdant", "violet", "vivid", "wandering",
  "warm", "weathered", "wide", "wild", "winter", "wispy", "wooden",
  "yellow", "zealous", "zenith", "zephyr",
];

const NOUNS = [
  "anchor", "anvil", "apex", "arch", "arrow", "atlas", "bay", "beacon",
  "birch", "blade", "bluff", "boulder", "bridge", "brook", "buoy",
  "cabin", "canopy", "canyon", "cape", "cedar", "channel", "cliff",
  "cloud", "coast", "compass", "cove", "crater", "creek", "crest",
  "delta", "depot", "dune", "eagle", "ember", "falcon", "fern",
  "ferry", "field", "flint", "forge", "fountain", "fox", "gale",
  "gate", "glacier", "gorge", "granite", "grove", "gulf", "harbor",
  "haven", "hawk", "heath", "helm", "heron", "hill", "hollow",
  "horizon", "inlet", "island", "kelp", "keystone", "lagoon", "lantern",
  "larch", "ledge", "lighthouse", "linden", "lodge", "loft", "maple",
  "marsh", "meadow", "mesa", "mill", "mist", "moon", "moor",
  "moss", "moth", "mountain", "narrows", "needle", "nest", "oak",
  "oar", "orbit", "osprey", "outpost", "owl", "peak", "pebble",
  "pier", "pilot", "pine", "pinnacle", "plain", "plateau", "plover",
  "pond", "portal", "prairie", "prism", "quarry", "quartz", "raven",
  "reef", "ridge", "river", "robin", "rock", "rook", "runnel",
  "saddle", "sage", "sail", "salmon", "sandbar", "shelf", "shore",
  "signal", "slope", "snipe", "source", "spar", "spit", "spruce",
  "starling", "stone", "storm", "summit", "swallow", "swift", "talon",
  "thistle", "thorn", "tide", "timber", "torch", "tower", "trail",
  "tundra", "vale", "valley", "vault", "vessel", "vole", "wave",
  "waypoint", "weir", "willow", "wind", "wolf", "wood", "wren",
];

export function generatePhrase(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

export function isValidPhrase(phrase: string): boolean {
  // Matches lowercase adjective-noun format, 6–40 chars
  return /^[a-z]+-[a-z]+$/.test(phrase) && phrase.length >= 6 && phrase.length <= 40;
}

// Display helper — capitalises each word for on-screen verification badge
export function formatPhraseForDisplay(phrase: string): string {
  return phrase
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" \u00B7 ");
  // e.g. "Golden · Harbor"
}
