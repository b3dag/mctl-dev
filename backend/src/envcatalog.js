/**
 * The subset of itzg/docker-minecraft-server environment variables the UI
 * exposes as a form. Anything not listed here can still be set through the
 * "advanced" raw editor, but these get proper widgets and validation.
 */
export const ENV_CATALOG = [
  {
    group: 'Gameplay',
    vars: [
      { key: 'DIFFICULTY', label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'], default: 'easy' },
      { key: 'MODE', label: 'Game mode', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'], default: 'survival' },
      { key: 'HARDCORE', label: 'Hardcore', type: 'bool', default: 'false' },
      { key: 'PVP', label: 'PvP', type: 'bool', default: 'true' },
      { key: 'FORCE_GAMEMODE', label: 'Force gamemode on join', type: 'bool', default: 'false' },
      { key: 'ALLOW_FLIGHT', label: 'Allow flight', type: 'bool', default: 'false' },
      { key: 'SPAWN_PROTECTION', label: 'Spawn protection (blocks)', type: 'number', default: '16' },
      { key: 'ALLOW_NETHER', label: 'Allow Nether', type: 'bool', default: 'true' },
      { key: 'GENERATE_STRUCTURES', label: 'Generate structures', type: 'bool', default: 'true' },
      { key: 'SPAWN_ANIMALS', label: 'Spawn animals', type: 'bool', default: 'true' },
      { key: 'SPAWN_MONSTERS', label: 'Spawn monsters', type: 'bool', default: 'true' },
      { key: 'SPAWN_NPCS', label: 'Spawn villagers', type: 'bool', default: 'true' },
    ],
  },
  {
    group: 'World',
    vars: [
      { key: 'LEVEL', label: 'World folder name', type: 'text', default: 'world' },
      { key: 'LEVEL_TYPE', label: 'Level type', type: 'text', default: 'minecraft:normal', hint: 'e.g. minecraft:normal, minecraft:flat, minecraft:amplified' },
      { key: 'SEED', label: 'Seed', type: 'text' },
      { key: 'MAX_WORLD_SIZE', label: 'Max world size (blocks)', type: 'number' },
    ],
  },
  {
    group: 'Server',
    vars: [
      { key: 'MOTD', label: 'MOTD', type: 'text', default: 'A Minecraft Server' },
      { key: 'MAX_PLAYERS', label: 'Max players', type: 'number', default: '20' },
      { key: 'VIEW_DISTANCE', label: 'View distance', type: 'number', default: '10' },
      { key: 'SIMULATION_DISTANCE', label: 'Simulation distance', type: 'number', default: '10' },
      { key: 'ONLINE_MODE', label: 'Online mode (Mojang auth)', type: 'bool', default: 'true' },
      { key: 'ENABLE_WHITELIST', label: 'Enable whitelist', type: 'bool', default: 'false' },
      { key: 'ENFORCE_WHITELIST', label: 'Enforce whitelist', type: 'bool', default: 'false' },
      { key: 'MAX_TICK_TIME', label: 'Max tick time (ms, -1 disables watchdog)', type: 'number' },
      { key: 'ENABLE_COMMAND_BLOCK', label: 'Enable command blocks', type: 'bool', default: 'false' },
      { key: 'ICON', label: 'Server icon URL', type: 'text' },
      { key: 'OVERRIDE_SERVER_PROPERTIES', label: 'Re-apply env to server.properties on boot', type: 'bool', default: 'true' },
    ],
  },
  {
    group: 'Performance',
    vars: [
      { key: 'USE_AIKAR_FLAGS', label: 'Aikar JVM flags', type: 'bool', default: 'true' },
      { key: 'JVM_XX_OPTS', label: 'Extra JVM -XX options', type: 'text' },
    ],
  },
];

/**
 * OPS, WHITELIST and MEMORY are deliberately absent: the Players tab owns the
 * first two live, and the dedicated Memory field on Settings owns the third.
 * Any of them living a second life in the environment too would just be a
 * stale value away from quietly overriding the real one on the next recreate.
 */
export const SERVER_TYPES = [
  { value: 'VANILLA', label: 'Vanilla', mods: null },
  { value: 'PAPER', label: 'Paper', mods: 'plugins' },
  { value: 'SPIGOT', label: 'Spigot', mods: 'plugins' },
  { value: 'PURPUR', label: 'Purpur', mods: 'plugins' },
  { value: 'FABRIC', label: 'Fabric', mods: 'mods' },
  { value: 'FORGE', label: 'Forge', mods: 'mods' },
  { value: 'NEOFORGE', label: 'NeoForge', mods: 'mods' },
  { value: 'QUILT', label: 'Quilt', mods: 'mods' },
];

export const modDirFor = (type) =>
  SERVER_TYPES.find((t) => t.value === type)?.mods || null;

const CATALOG_KEYS = new Set(ENV_CATALOG.flatMap((g) => g.vars.map((v) => v.key)));

/** Env keys the manager owns; user input for these is ignored. */
export const RESERVED_ENV = new Set([
  'EULA',
  'TYPE',
  'VERSION',
  'ENABLE_RCON',
  'RCON_PASSWORD',
  'RCON_PORT',
  'SERVER_PORT',
  'UID',
  'GID',
  // The Players tab owns these lists live. Letting one through here means the
  // itzg image re-applies its own copy on every recreate, resolving UUIDs its
  // own way (offline UUIDs when ONLINE_MODE=false) - which then collides with
  // whatever UUID mctl already put in the file, as two entries for one name.
  'WHITELIST',
  'OPS',
  'MEMORY',
]);

export function sanitizeEnv(input = {}) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const key = String(k).toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (!key || RESERVED_ENV.has(key)) continue;
    if (v === null || v === undefined || v === '') continue;
    out[key] = String(v);
  }
  return out;
}

export const isCatalogKey = (k) => CATALOG_KEYS.has(k);
