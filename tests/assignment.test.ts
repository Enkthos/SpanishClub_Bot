import { describe, expect, it } from "vitest";
import { activeBarrioCount, assignPlayer, requiredPoliceCount } from "../src/assignment";
import { gameConfig } from "../src/config";

describe("game assignment", () => {
  it("activates barrios at the configured thresholds", () => {
    expect(activeBarrioCount(1, gameConfig)).toBe(1);
    expect(activeBarrioCount(3, gameConfig)).toBe(3);
    expect(activeBarrioCount(5, gameConfig)).toBe(5);
    expect(activeBarrioCount(17, gameConfig)).toBe(5);
  });

  it("keeps existing players stable between activation thresholds", () => {
    const current = gameConfig.barrios.flatMap((barrio, barrioIndex) => [
      { playerId: String(barrioIndex * 2 + 1), barrioId: barrio.id },
      { playerId: String(barrioIndex * 2 + 2), barrioId: barrio.id },
    ]);
    const result = assignPlayer("11", current, gameConfig, () => 0);
    expect(result.movedPlayerIds).toEqual([]);
    expect(result.assignments.find((item) => item.playerId === "11")?.barrioId).toBe("nomadas");
  });

  it("gives the first five players different barrios without moving anyone", () => {
    let assignments: { playerId: string; barrioId: string; moveCount?: number }[] = [];
    const moved: string[] = [];
    for (let playerNumber = 1; playerNumber <= 5; playerNumber += 1) {
      const result = assignPlayer(String(playerNumber), assignments, gameConfig, () => 0);
      assignments = result.assignments;
      moved.push(...result.movedPlayerIds);
    }
    expect(new Set(assignments.map((item) => item.barrioId)).size).toBe(5);
    expect(moved).toEqual([]);
  });

  it("places three players in three different barrios", () => {
    let assignments: { playerId: string; barrioId: string; moveCount?: number }[] = [];
    for (let playerNumber = 1; playerNumber <= 3; playerNumber += 1) {
      const result = assignPlayer(String(playerNumber), assignments, gameConfig, () => 0);
      assignments = result.assignments;
    }
    expect(assignments.map((item) => item.barrioId)).toEqual(["nomadas", "navegantes", "lumieres"]);
  });

  it("adds later players to a smallest barrio without moving existing players", () => {
    const current = gameConfig.barrios.map((barrio, index) => ({
      playerId: String(index + 1),
      barrioId: barrio.id,
    }));
    const result = assignPlayer("6", current, gameConfig, () => 0);
    expect(result.activatedBarrio).toBe(false);
    expect(result.movedPlayerIds).toEqual([]);
    expect(result.assignments.filter((item) => item.barrioId === "nomadas")).toHaveLength(2);
  });

  it("requires one Policía for every ten barrio players", () => {
    expect(requiredPoliceCount(0, gameConfig)).toBe(0);
    expect(requiredPoliceCount(10, gameConfig)).toBe(1);
    expect(requiredPoliceCount(11, gameConfig)).toBe(2);
    expect(requiredPoliceCount(20, gameConfig)).toBe(2);
  });

  it("distributes twenty sequential registrations across five balanced barrios", () => {
    let assignments: { playerId: string; barrioId: string }[] = [];
    const activations: number[] = [];
    const moves: number[] = [];

    for (let playerNumber = 1; playerNumber <= 20; playerNumber += 1) {
      const result = assignPlayer(String(playerNumber), assignments, gameConfig, () => 0);
      assignments = result.assignments;
      if (result.activatedBarrio) activations.push(playerNumber);
      moves.push(...result.movedPlayerIds.map(Number));
    }

    const sizes = gameConfig.barrios.map(
      (barrio) => assignments.filter((item) => item.barrioId === barrio.id).length,
    );
    expect(activations).toEqual([2, 3, 4, 5]);
    expect(sizes).toEqual([4, 4, 4, 4, 4]);
    expect(moves).toHaveLength(0);
    expect(new Set(moves).size).toBe(moves.length);
    expect(requiredPoliceCount(assignments.length, gameConfig)).toBe(2);
  });
});
