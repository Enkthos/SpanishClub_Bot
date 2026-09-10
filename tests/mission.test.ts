import { describe, expect, it } from "vitest";
import { formatMission } from "../src/mission";

describe("mission presentation", () => {
  it("shows the meeting day and time in Russian", () => {
    const text = formatMission({
      title: "Первая встреча",
      description: "Познакомьтесь со своим barrio.",
      meetingAt: new Date("2026-09-12T15:30:00+03:00"),
      location: "Главный зал",
    });
    expect(text).toContain("12 сентября 2026 г.");
    expect(text).toContain("15:30");
    expect(text).toContain("Главный зал");
  });
});
