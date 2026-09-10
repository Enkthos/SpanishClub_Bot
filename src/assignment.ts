import type { GameConfig, PlayerAssignment } from "./types";

export function activeBarrioCount(playerCount: number, config: GameConfig): number {
  let active = config.assignment.activationThresholds[0]?.activeBarrios ?? 1;
  for (const threshold of config.assignment.activationThresholds) {
    if (playerCount >= threshold.minimumBarrioPlayers) active = threshold.activeBarrios;
  }
  return Math.min(active, config.barrios.length);
}

export function requiredPoliceCount(barrioPlayerCount: number, config: GameConfig): number {
  if (barrioPlayerCount === 0) return 0;
  return Math.max(
    config.police.minimumOfficers,
    Math.ceil(barrioPlayerCount / config.police.barrioPlayersPerOfficer),
  );
}

function countsFor(assignments: PlayerAssignment[], barrioIds: string[]): Map<string, number> {
  const counts = new Map(barrioIds.map((id) => [id, 0]));
  for (const assignment of assignments) {
    if (counts.has(assignment.barrioId)) {
      counts.set(assignment.barrioId, (counts.get(assignment.barrioId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Preserves every assignment during normal registration. When a threshold opens a
 * new barrio, only the minimum number of players needed for a balanced layout move.
 */
export function assignPlayer(
  playerId: string,
  current: PlayerAssignment[],
  config: GameConfig,
  random: () => number = Math.random,
): { assignments: PlayerAssignment[]; movedPlayerIds: string[]; activatedBarrio: boolean } {
  if (current.some((item) => item.playerId === playerId)) {
    return { assignments: [...current], movedPlayerIds: [], activatedBarrio: false };
  }

  const beforeCount = activeBarrioCount(current.length, config);
  const afterCount = activeBarrioCount(current.length + 1, config);
  const activeIds = config.barrios.slice(0, afterCount).map((barrio) => barrio.id);
  const activatedBarrio = afterCount > beforeCount;
  const assignments = [...current, { playerId, barrioId: activeIds[afterCount - 1] }];
  const movedPlayerIds: string[] = [];

  if (activatedBarrio && config.assignment.rebalanceOnlyWhenBarrioActivates) {
    while (true) {
      const counts = countsFor(assignments, activeIds);
      const sizes = activeIds.map((id) => counts.get(id) ?? 0);
      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      if (max - min <= config.assignment.maximumSizeDifference) break;

      const largest = activeIds.filter((id) => counts.get(id) === max);
      const smallest = activeIds.filter((id) => counts.get(id) === min);
      const from = largest[Math.floor(random() * largest.length)];
      const to = smallest[Math.floor(random() * smallest.length)];
      const eligible = assignments.filter(
        (item) => item.barrioId === from && item.playerId !== playerId && !movedPlayerIds.includes(item.playerId),
      );
      const lowestMoveCount = Math.min(...eligible.map((item) => item.moveCount ?? 0));
      const candidates = eligible.filter((item) => (item.moveCount ?? 0) === lowestMoveCount);
      const selected = candidates[Math.floor(random() * candidates.length)];
      if (!selected) break;
      selected.barrioId = to;
      selected.moveCount = (selected.moveCount ?? 0) + 1;
      movedPlayerIds.push(selected.playerId);
    }
  } else {
    const counts = countsFor(current, activeIds);
    const minimum = Math.min(...activeIds.map((id) => counts.get(id) ?? 0));
    const smallest = activeIds.filter((id) => (counts.get(id) ?? 0) === minimum);
    assignments[assignments.length - 1].barrioId = smallest[Math.floor(random() * smallest.length)];
  }

  return { assignments, movedPlayerIds, activatedBarrio };
}
