import rawConfig from "../config/game.config.json";
import type { GameConfig } from "./types";

function fail(message: string): never {
  throw new Error(`Invalid game configuration: ${message}`);
}

export function validateConfig(value: unknown): GameConfig {
  const config = value as GameConfig;

  if (!config || typeof config !== "object") fail("root must be an object");
  if (!config.locale) fail("locale is required");
  if (!config.timeZone) fail("timeZone is required");
  if (!config.event?.name || !config.event.meetingAt || !config.event.location) {
    fail("event name, meetingAt and location are required");
  }
  if (Number.isNaN(Date.parse(config.event.meetingAt))) fail("event meetingAt must be an ISO date");
  if (!config.economy || config.economy.startingPlayerDinero < 0 || config.economy.startingRespeto < 0) {
    fail("starting economy values must be non-negative");
  }
  if (!Array.isArray(config.dictionary) || config.dictionary.some((section) => !section.title || !section.entries?.length)) {
    fail("dictionary must contain titled sections with entries");
  }
  if (!Array.isArray(config.barrios) || config.barrios.length < 1 || config.barrios.length > 5) {
    fail("barrios must contain between 1 and 5 entries");
  }

  const ids = new Set<string>();
  for (const barrio of config.barrios) {
    if (!barrio.id || !barrio.name || !barrio.slogan || !barrio.emoji || !barrio.leader?.name) {
      fail("every barrio needs id, name, slogan, emoji and leader name");
    }
    if (!/^#[0-9a-f]{6}$/i.test(barrio.color)) fail(`${barrio.id} has an invalid color`);
    if (ids.has(barrio.id)) fail(`duplicate barrio id: ${barrio.id}`);
    ids.add(barrio.id);
  }

  const thresholds = config.assignment?.activationThresholds;
  if (!Array.isArray(thresholds) || thresholds.length === 0) fail("activation thresholds are required");

  let lastMinimum = 0;
  let lastCount = 0;
  for (const threshold of thresholds) {
    if (threshold.minimumBarrioPlayers <= lastMinimum) fail("threshold minimums must increase");
    if (threshold.activeBarrios <= lastCount) fail("active barrio counts must increase");
    if (threshold.activeBarrios > config.barrios.length) fail("threshold activates an unknown barrio");
    lastMinimum = threshold.minimumBarrioPlayers;
    lastCount = threshold.activeBarrios;
  }

  if (config.police?.barrioPlayersPerOfficer < 1) fail("police ratio must be positive");
  if (!Array.isArray(config.market)) fail("market must be an array");
  return config;
}

export const gameConfig = validateConfig(rawConfig);
