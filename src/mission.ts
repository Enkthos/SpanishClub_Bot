import type { Mission } from "./types";

export function formatMission(mission: Mission, locale = "ru-RU", timeZone = "Europe/Moscow"): string {
  const date = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(mission.meetingAt);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(mission.meetingAt);

  const lines = [
    `🎯 Misión: ${mission.title}`,
    mission.description,
    "",
    `📅 Встреча: ${date}`,
    `🕒 Время: ${time}`,
  ];
  if (mission.location) lines.push(`📍 Место: ${mission.location}`);
  if (mission.rewardDinero !== undefined) lines.push(`💵 Награда: ${mission.rewardDinero} dinero`);
  if (mission.rewardRespeto !== undefined) lines.push(`⭐ Respeto: +${mission.rewardRespeto}`);
  if (mission.vocabulary?.length) {
    lines.push("", "📚 Словарь:", ...mission.vocabulary.map((word) => `• ${word.spanish} — ${word.russian}`));
  }
  if (mission.examples?.length) {
    lines.push("", "💡 Что делать:", ...mission.examples.map((example, index) => `${index + 1}. ${example}`));
  }
  return lines.join("\n");
}
