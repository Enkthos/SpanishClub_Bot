import { activeBarrioCount, assignPlayer, requiredPoliceCount } from "./assignment";
import { gameConfig } from "./config";
import { formatMission } from "./mission";
import { JsonStore, nicknameKey, type GameEvent, type GameState, type MissionRecord, type Player } from "./store";
import type { Messenger, ReplyMarkup, TelegramMessage } from "./telegram";
import { renderTerritoryMap } from "./territory-map";

const MENU: ReplyMarkup = {
  keyboard: [
    [{ text: "👤 Мой персонаж" }, { text: "🎯 Текущая misión" }],
    [{ text: "📋 Все misiones" }, { text: "🎭 События" }],
    [{ text: "🏘 Мой barrio" }, { text: "🛒 Mercado" }],
    [{ text: "🏆 Общий рейтинг" }, { text: "📊 Рейтинг barrios" }],
    [{ text: "🗺 Территории" }, { text: "📚 Словарь" }],
    [{ text: "📜 Правила" }],
    [{ text: "🗑 Перезапустить персонажа" }],
  ],
  resize_keyboard: true,
};

const TERRITORIES = [
  "El Corona", "La Vista", "Los Olvidados", "Santa Fortuna", "Pueblo Viejo",
  "Monte Claro", "Cerro Rojo", "Río Sur", "Las Palmas", "Del Valle",
  "East Heights", "Bahía Flats", "Los Jardines", "Tierra Nueva", "Puerto Sol",
];

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function findPlayer(state: GameState, telegramId: number): Player | undefined {
  return state.players.find((player) => player.telegramId === telegramId);
}

function findByNickname(state: GameState, nickname: string): Player | undefined {
  const key = nicknameKey(nickname);
  return state.players.find((player) => player.nicknameKey === key);
}

function activeMission(state: GameState): MissionRecord | undefined {
  return state.missions.find((mission) => mission.id === state.activeMissionId);
}

function playerBarrioId(state: GameState, player: Player): string | null {
  const mission = activeMission(state);
  if (!mission) return player.barrioId;
  return mission.barrioAssignments[String(player.telegramId)] ?? null;
}

function barrioLabel(id: string | null): string {
  if (!id) return "Не назначен";
  const barrio = gameConfig.barrios.find((item) => item.id === id);
  return barrio ? `${barrio.emoji} ${barrio.name}` : id;
}

function profile(player: Player, state: GameState): string {
  const currentBarrioId = playerBarrioId(state, player);
  const role = player.role === "police" ? "👮 Policía" : barrioLabel(currentBarrioId);
  const penalties = player.penalties.length ? player.penalties.map(escapeHtml).join("; ") : "нет";
  const wanted = player.wantedLevel > 0 ? `уровень ${player.wantedLevel}` : "нет";
  const barrioMoney = currentBarrioId ? state.barrioDinero[currentBarrioId] ?? 0 : null;
  return [
    `👤 <b>${escapeHtml(player.nickname)}</b>`,
    `🏘 Команда: ${role}`,
    `💵 Dinero: ${player.dinero}`,
    ...(barrioMoney === null ? [] : [`🏦 Казна barrio: ${barrioMoney} Barrio$`]),
    `⭐ Respeto: ${player.respeto}`,
    `⚠️ Penitencia: ${penalties}`,
    `🚨 Розыск Policía: ${wanted}`,
  ].join("\n");
}

function missionText(state: GameState): string {
  const configured = gameConfig.event.currentMission;
  const active = state.missions.find((mission) => mission.id === state.activeMissionId);
  const mission = active ?? state.mission ?? {
    ...configured,
    meetingAt: gameConfig.event.meetingAt,
    location: gameConfig.event.location,
  };
  return formatMission(
    { ...mission, meetingAt: new Date(mission.meetingAt) },
    gameConfig.locale,
    gameConfig.timeZone,
  );
}

function missionStatus(status: MissionRecord["status"]): string {
  if (status === "active") return "🟢 Активна";
  if (status === "completed") return "✅ Завершена";
  return "🕒 Запланирована";
}

function missionSchedule(meetingAt: string): string {
  const date = new Date(meetingAt);
  if (Number.isNaN(date.getTime())) return "дата не установлена";
  const day = new Intl.DateTimeFormat(gameConfig.locale, {
    dateStyle: "long",
    timeZone: gameConfig.timeZone,
  }).format(date);
  const time = new Intl.DateTimeFormat(gameConfig.locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: gameConfig.timeZone,
  }).format(date);
  return `${day}, ${time}`;
}

type RegistrationWindow = "upcoming" | "open" | "closed";

function localMissionDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: gameConfig.timeZone,
  }).format(date);
}

function registrationWindow(mission: MissionRecord, now = new Date()): RegistrationWindow {
  const meeting = new Date(mission.meetingAt);
  if (Number.isNaN(meeting.getTime())) return "closed";
  const opensAt = meeting.getTime() - 10 * 60_000;
  if (now.getTime() < opensAt) return "upcoming";
  return localMissionDay(now) === localMissionDay(meeting) ? "open" : "closed";
}

function registrationHint(mission: MissionRecord): string {
  const window = registrationWindow(mission);
  if (window === "open") return "🟢 Запись открыта до конца дня";
  if (window === "upcoming") return `🕒 Запись откроется за 10 минут: ${missionSchedule(new Date(new Date(mission.meetingAt).getTime() - 10 * 60_000).toISOString())}`;
  return "⚫ Запись закрыта";
}

function missionDateTime(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const candidate = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(candidate.getTime())) return null;
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: gameConfig.timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(candidate).find((part) => part.type === "timeZoneName")?.value;
  const offset = offsetName === "GMT" ? "Z" : offsetName?.replace("GMT", "");
  if (!offset || Number.isNaN(Date.parse(`${date}T${time}:00${offset}`))) return null;
  return `${date}T${time}:00${offset}`;
}

function missionsText(state: GameState, includeCompleted = false, player?: Player): string {
  const missions = [...state.missions]
    .filter((mission) => includeCompleted || mission.status !== "completed")
    .sort((a, b) => Date.parse(a.meetingAt) - Date.parse(b.meetingAt));
  if (!missions.length) return "📋 Доступных misiones пока нет.";

  const lines = missions.map((mission) => [
    `${missionStatus(mission.status)} · <b>${escapeHtml(mission.title)}</b>`,
    `📅 ${missionSchedule(mission.meetingAt)}`,
    ...(mission.location ? [`📍 ${escapeHtml(mission.location)}`] : []),
    ...(player ? [mission.participantIds.includes(player.telegramId)
      ? `✅ Вы участвуете · ${barrioLabel(mission.barrioAssignments[String(player.telegramId)] ?? null)}`
      : `➕ Вы ещё не записаны\n${registrationHint(mission)}`] : []),
    `<code>${escapeHtml(mission.id)}</code>`,
  ].join("\n"));
  const adminHint = includeCompleted
    ? ["🛠 Изменить дату и время:", "<code>/missiontime ID | ГГГГ-ММ-ДД | ЧЧ:ММ</code>"]
    : [];
  const playerHint = player
    ? ["Записаться: <code>/missionjoin ID</code>", "Отменить участие: <code>/missionleave ID</code>"]
    : [];
  return ["📋 <b>Misiones</b>", ...lines, ...playerHint, ...adminHint].join("\n\n");
}

function assignMissionBarrio(state: GameState, mission: MissionRecord, player: Player): string {
  const appointed = Object.entries(state.barrioLeaderIds)
    .find(([, telegramId]) => telegramId === player.telegramId)?.[0];
  if (appointed) return appointed;

  const previousBarrio = [...state.missions].reverse()
    .find((item) => item.id !== mission.id && item.barrioAssignments[String(player.telegramId)])
    ?.barrioAssignments[String(player.telegramId)] ?? player.barrioId;
  const desiredCount = Math.min(activeBarrioCount(mission.participantIds.length + 1, gameConfig), gameConfig.barrios.length);
  const activeIds = [...new Set(Object.values(mission.barrioAssignments))];
  const unusedIds = gameConfig.barrios.map((barrio) => barrio.id).filter((id) => !activeIds.includes(id));
  while (activeIds.length < desiredCount && unusedIds.length) {
    const alternatives = unusedIds.filter((id) => id !== previousBarrio);
    const pool = alternatives.length ? alternatives : unusedIds;
    const selected = pool[Math.floor(Math.random() * pool.length)];
    activeIds.push(selected);
    unusedIds.splice(unusedIds.indexOf(selected), 1);
  }
  if (!activeIds.length) activeIds.push(gameConfig.barrios[Math.floor(Math.random() * gameConfig.barrios.length)].id);

  const counts = new Map(activeIds.map((id) => [id, 0]));
  for (const barrioId of Object.values(mission.barrioAssignments)) {
    if (counts.has(barrioId)) counts.set(barrioId, (counts.get(barrioId) ?? 0) + 1);
  }
  const minimum = Math.min(...counts.values());
  let candidates = activeIds.filter((id) => counts.get(id) === minimum);
  const different = candidates.filter((id) => id !== previousBarrio);
  if (different.length) candidates = different;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function eventTargetsPlayer(event: GameEvent, player: Player, state: GameState): boolean {
  if (event.target === "all") return true;
  if (event.target === "police") return player.role === "police";
  const targets = event.target.split(",").map((target) => nicknameKey(target));
  const barrioId = playerBarrioId(state, player);
  return targets.includes(nicknameKey(player.nickname)) || (!!barrioId && targets.includes(barrioId));
}

function eventsText(state: GameState, player: Player): string {
  const events = state.events.filter((event) => event.status === "active" && eventTargetsPlayer(event, player, state));
  if (!events.length) return "🎭 Сейчас для вас нет активных игровых событий.";
  return [
    "🎭 <b>Активные события</b>",
    ...events.map((event) => `<b>${escapeHtml(event.title)}</b> · ${escapeHtml(event.type)}\n${escapeHtml(event.description)}`),
  ].join("\n\n");
}

function generalRanking(state: GameState): string {
  const players = state.players
    .filter((player) => player.role === "player")
    .sort((a, b) => b.respeto - a.respeto || a.registeredAt.localeCompare(b.registeredAt));
  if (!players.length) return "В рейтинге пока никого нет.";
  return ["🏆 <b>Общий рейтинг Respeto</b>", ...players.map((p, i) => `${i + 1}. ${escapeHtml(p.nickname)} — ${p.respeto} ⭐ — ${barrioLabel(playerBarrioId(state, p))}`)].join("\n");
}

function barrioRanking(state: GameState): string {
  const sections = gameConfig.barrios.map((barrio) => {
    const players = state.players
      .filter((player) => playerBarrioId(state, player) === barrio.id && player.role === "player")
      .sort((a, b) => b.respeto - a.respeto || a.registeredAt.localeCompare(b.registeredAt));
    return [`${barrio.emoji} <b>${escapeHtml(barrio.name)}</b>`, ...(players.length ? players.map((p, i) => `${i + 1}. ${escapeHtml(p.nickname)} — ${p.respeto} ⭐`) : ["Пока пусто"])].join("\n");
  });
  return sections.join("\n\n");
}

function rules(): string {
  return [
    "📜 <b>LOS BARRIOS</b>",
    "Главная цель — после семи misiones набрать больше всего Respeto.",
    "Во время ключевых взаимодействий используйте выданные испанские фразы. Ошибаться можно — главное говорить.",
    "Barrio$ можно тратить, передавать и использовать в разрешённых сделках.",
    "Policía может остановить игрока командой ¡Alto! и назначить Penitencia по правилам игры.",
  ].join("\n\n");
}

function marketText(state: GameState): string {
  if (!state.market.length) return "🛒 Mercado пока закрыт. Организатор ещё не добавил товары.";
  return ["🛒 <b>Mercado</b>", ...state.market.map((item) => `${escapeHtml(item.id)} — <b>${escapeHtml(item.name)}</b>: ${item.price} Barrio$${item.stock === null ? "" : ` (осталось ${item.stock})`}\n${escapeHtml(item.description)}`), "", "Для покупки: /buy ID_ТОВАРА"].join("\n");
}

function dictionaryText(): string {
  const sections = gameConfig.dictionary.map((section) => [
    `<b>${escapeHtml(section.title)}</b>`,
    ...section.entries.map((entry) => `• ${escapeHtml(entry.spanish)} — ${escapeHtml(entry.russian)}`),
  ].join("\n"));
  return ["📚 <b>Diccionario LOS BARRIOS</b>", "Самые полезные слова и фразы для игры:", "", ...sections].join("\n\n");
}

function territoryText(state: GameState): string {
  const cells = TERRITORIES.map((_, index) => {
    const owner = state.territories[String(index + 1)];
    const barrio = gameConfig.barrios.find((item) => item.id === owner);
    return `${barrio?.emoji ?? "⚪"}${String(index + 1).padStart(2, "0")}`;
  });
  const grid = [cells.slice(0, 5), cells.slice(5, 10), cells.slice(10, 15)]
    .map((row) => row.join("  "))
    .join("\n");
  const details = gameConfig.barrios.map((barrio) => {
    const owned = TERRITORIES.flatMap((name, index) => state.territories[String(index + 1)] === barrio.id ? [name] : []);
    return `${barrio.emoji} ${escapeHtml(barrio.name)}: ${owned.length} — ${owned.map(escapeHtml).join(", ") || "нет"}`;
  });
  return ["🗺 <b>Карта территорий</b>", grid, "", ...details].join("\n");
}

function parseAdminIds(): Set<number> {
  return new Set((process.env.ADMIN_TELEGRAM_IDS ?? "").split(",").map((id) => Number(id.trim())).filter(Number.isSafeInteger));
}

function characterResetCode(): string {
  return process.env.CHARACTER_RESET_CODE?.trim() || "0000";
}

function adminHelp(): string {
  return [
    "🛠 <b>Команды организатора</b>",
    "/players — участники и потребность Policía",
    "/missionlist, /missionadd, /missionedit, /missionstart, /missionfinish, /missiondelete",
    "/missiontime ID | ГГГГ-ММ-ДД | ЧЧ:ММ — установить дату и время",
    "/missionvocab, /missionexample — наполнить misión",
    "/assign [MISSION_ID |] НИК | ID_BARRIO — вручную назначить команду",
    "/missionroster [ID] — список записанных на misión",
    "/messageuser НИК | ТЕКСТ, /messagebarrio ID_BARRIO | ТЕКСТ, /missionmessage [ID |] ТЕКСТ",
    "/leader ID_BARRIO | НИК — назначить игрока лидером barrio",
    "/leaderremove ID_BARRIO — снять лидера",
    "/eventlist, /eventadd, /eventedit, /eventstart, /eventfinish, /eventdelete",
    "/eventpreset rata|robo|guerra | ЦЕЛЬ — быстро создать событие",
    "/money НИК СУММА — изменить Dinero",
    "/respeto НИК СУММА — изменить Respeto",
    "/wanted НИК УРОВЕНЬ — 0 снимает розыск",
    "/penalty НИК | ТЕКСТ — добавить Penitencia",
    "/penaltylist, /penaltyadd, /penaltyedit, /penaltydelete — каталог Penitencias",
    "/penaltysend НИК | ID, /penaltybarrio ID_BARRIO | ID — выдать из каталога",
    "/clearpenalties НИК",
    "/police НИК — включить/выключить роль Policía",
    "/shoplist, /shopadd, /shopedit, /shopdelete",
    "/leaderphoto ID_BARRIO — затем отправить фото",
    "/mapphoto — затем отправить оригинальную карту",
    "/win ID_BARRIO — выдать территорию победителю",
    "/territoryremove ID_BARRIO или НОМЕР — убрать территорию",
  ].join("\n");
}

export class BotApp {
  private readonly pendingLeaderPhoto = new Map<number, string>();
  private readonly pendingMapPhoto = new Set<number>();
  private readonly pendingCharacterReset = new Set<number>();

  constructor(private readonly store: JsonStore, private readonly messenger: Messenger) {}

  async handle(message: TelegramMessage): Promise<void> {
    if (!message.from || message.chat.type !== "private") return;
    await this.ensureTerritories();
    if (message.photo?.length) {
      await this.receiveLeaderPhoto(message);
      return;
    }
    if (!message.text) return;
    const text = message.text.trim();
    const userId = message.from.id;
    const state = this.store.get();
    const player = findPlayer(state, userId);

    if (text === "/myid") {
      await this.messenger.sendMessage(message.chat.id, `Ваш Telegram ID: <code>${userId}</code>`);
      return;
    }

    if (text === "/start") {
      this.pendingCharacterReset.delete(userId);
      if (player) await this.messenger.sendMessage(message.chat.id, `С возвращением, ${escapeHtml(player.nickname)}!`, MENU);
      else await this.messenger.sendMessage(message.chat.id, "¡Bienvenido в LOS BARRIOS!\n\nНапишите игровой nickname (2–24 символа). Он должен быть уникальным.");
      return;
    }

    if (this.pendingCharacterReset.has(userId)) {
      if (text === "/cancel") {
        this.pendingCharacterReset.delete(userId);
        await this.messenger.sendMessage(message.chat.id, "Перезапуск отменён. Персонаж сохранён.", MENU);
      } else if (player) {
        await this.resetCharacter(message.chat.id, player, text);
      } else {
        this.pendingCharacterReset.delete(userId);
        await this.messenger.sendMessage(message.chat.id, "Персонаж уже удалён. Отправьте /start, чтобы зарегистрироваться снова.");
      }
      return;
    }

    if (text.startsWith("/")) {
      if (await this.handleCommand(message, text, player)) return;
      await this.messenger.sendMessage(
        message.chat.id,
        player ? "Неизвестная команда. Используйте /help." : "Сначала зарегистрируйтесь: отправьте /start.",
        player ? MENU : undefined,
      );
      return;
    }

    if (!player) {
      await this.register(message, text);
      return;
    }

    const actions: Record<string, () => Promise<void>> = {
      "👤 Мой персонаж": () => this.messenger.sendMessage(message.chat.id, profile(player, state), MENU),
      "🏘 Мой barrio": () => this.showBarrio(message.chat.id, player),
      "🎯 Текущая misión": () => this.messenger.sendMessage(message.chat.id, missionText(state), MENU),
      "📋 Все misiones": () => this.messenger.sendMessage(message.chat.id, missionsText(state, parseAdminIds().has(userId), player), MENU),
      "🏆 Общий рейтинг": () => this.messenger.sendMessage(message.chat.id, generalRanking(state), MENU),
      "📊 Рейтинг barrios": () => this.messenger.sendMessage(message.chat.id, barrioRanking(state), MENU),
      "🛒 Mercado": () => this.messenger.sendMessage(message.chat.id, marketText(state), MENU),
      "🗺 Территории": () => this.showTerritories(message.chat.id),
      "📚 Словарь": () => this.messenger.sendMessage(message.chat.id, dictionaryText(), MENU),
      "🎭 События": () => this.messenger.sendMessage(message.chat.id, eventsText(state, player), MENU),
      "📜 Правила": () => this.messenger.sendMessage(message.chat.id, rules(), MENU),
      "🗑 Перезапустить персонажа": async () => {
        this.pendingCharacterReset.add(userId);
        await this.messenger.sendMessage(
          message.chat.id,
          "⚠️ Это удалит персонажа, Dinero, Respeto, инвентарь, участие в misiones и статус лидера.\n\nВведите код подтверждения или отправьте /cancel.",
          MENU,
        );
      },
    };
    const action = actions[text];
    if (action) await action();
    else await this.messenger.sendMessage(message.chat.id, "Используйте кнопки меню или /help.", MENU);
  }

  private async register(message: TelegramMessage, rawNickname: string): Promise<void> {
    const nickname = rawNickname.trim().replace(/\s+/g, " ");
    if (nickname.length < 2 || nickname.length > 24 || /[<>\n\r]/.test(nickname)) {
      await this.messenger.sendMessage(message.chat.id, "Nickname должен содержать 2–24 символа. Попробуйте другой.");
      return;
    }
    if (findByNickname(this.store.get(), nickname)) {
      await this.messenger.sendMessage(message.chat.id, "Этот nickname уже занят. Выберите другой.");
      return;
    }

    const existing = this.store.get().players.filter((p) => p.role === "player" && p.barrioId).map((p) => ({ playerId: String(p.telegramId), barrioId: p.barrioId!, moveCount: p.moveCount }));
    const result = assignPlayer(String(message.from!.id), existing, gameConfig);
    const ownAssignment = result.assignments.find((item) => item.playerId === String(message.from!.id));
    const now = new Date().toISOString();
    await this.store.update((state) => {
      for (const assignment of result.assignments) {
        const registered = state.players.find((p) => String(p.telegramId) === assignment.playerId);
        if (registered) {
          registered.barrioId = assignment.barrioId;
          registered.moveCount = assignment.moveCount ?? registered.moveCount;
        }
      }
      state.players.push({
        telegramId: message.from!.id,
        chatId: message.chat.id,
        nickname,
        nicknameKey: nicknameKey(nickname),
        barrioId: ownAssignment?.barrioId ?? gameConfig.barrios[0].id,
        role: "player",
        dinero: gameConfig.economy.startingPlayerDinero,
        respeto: gameConfig.economy.startingRespeto,
        penalties: [],
        wantedLevel: 0,
        moveCount: 0,
        inventory: [],
        registeredAt: now,
      });
      for (const barrio of gameConfig.barrios) {
        state.barrioDinero[barrio.id] ??= gameConfig.economy.startingBarrioDinero;
      }
      if (!state.market.length) state.market = structuredClone(gameConfig.market);
    });

    const added = findPlayer(this.store.get(), message.from!.id)!;
    await this.messenger.sendMessage(message.chat.id, `Регистрация завершена!\n\n${profile(added, this.store.get())}`, MENU);
    for (const movedId of result.movedPlayerIds) {
      const moved = findPlayer(this.store.get(), Number(movedId));
      if (moved) await this.messenger.sendMessage(moved.chatId, `⚠️ Открылся новый barrio. Для баланса вы переведены в ${barrioLabel(moved.barrioId)}. Это назначение уже сохранено.`);
    }
  }

  private async showBarrio(chatId: number, player: Player): Promise<void> {
    if (player.role === "police") {
      await this.messenger.sendMessage(chatId, "👮 Вы состоите в Policía.", MENU);
      return;
    }
    const state = this.store.get();
    const currentBarrioId = playerBarrioId(state, player);
    const barrio = gameConfig.barrios.find((item) => item.id === currentBarrioId);
    if (!barrio) {
      const active = activeMission(state);
      await this.messenger.sendMessage(chatId, active
        ? `Вы ещё не записаны на текущую misión. Используйте <code>/missionjoin ${escapeHtml(active.id)}</code>.`
        : "Barrio ещё не назначен.", MENU);
      return;
    }
    const appointedLeader = findPlayer(state, state.barrioLeaderIds[barrio.id]);
    const leaderDetails = appointedLeader
      ? `👑 Лидер barrio: <b>${escapeHtml(appointedLeader.nickname)}</b>\n🎭 Персонаж: ${escapeHtml(barrio.leader.name)}`
      : `👑 Лидер: <b>${escapeHtml(barrio.leader.name)}</b>`;
    const details = `${barrio.emoji} <b>${escapeHtml(barrio.name)}</b>\n${escapeHtml(barrio.slogan)}\n${leaderDetails}\nЦвет: <code>${barrio.color}</code>`;
    const photo = state.leaderPhotoFileIds[barrio.id];
    if (photo && !barrio.leader.hidePhoto) await this.messenger.sendPhoto(chatId, photo, details);
    else {
      const photoStatus = barrio.leader.hidePhoto ? "" : "\n📷 Фото лидера пока не загружено организатором.";
      await this.messenger.sendMessage(chatId, `${details}${photoStatus}`, MENU);
    }
  }

  private async handleCommand(message: TelegramMessage, text: string, player?: Player): Promise<boolean> {
    const [commandRaw, ...parts] = text.split(" ");
    const command = commandRaw.split("@")[0].toLowerCase();
    const argument = parts.join(" ").trim();
    const state = this.store.get();
    const isAdmin = parseAdminIds().has(message.from!.id);

    if (command === "/help") {
      await this.messenger.sendMessage(message.chat.id, "Команды: /start, /profile, /mission, /missions, /missionjoin, /missionleave, /events, /dictionary, /ranking, /barrios, /territories, /market, /buy, /restart, /myid" + (isAdmin ? "\n\n" + adminHelp() : ""), MENU);
      return true;
    }
    const adminOnly = new Set([
      "/admin", "/players", "/money", "/respeto", "/wanted", "/penalty", "/clearpenalties", "/police",
      "/assign", "/missionroster", "/messageuser", "/messagebarrio", "/missionmessage",
      "/penaltylist", "/penaltyadd", "/penaltyedit", "/penaltydelete", "/penaltysend", "/penaltybarrio",
      "/shoplist", "/shopadd", "/shopedit", "/shopdelete",
      "/missionlist", "/missionadd", "/missionedit", "/missiontime", "/missionstart", "/missionfinish", "/missiondelete", "/missionvocab", "/missionexample",
      "/eventlist", "/eventadd", "/eventedit", "/eventstart", "/eventfinish", "/eventdelete", "/eventpreset",
      "/leader", "/leaderremove", "/leaderphoto", "/mapphoto", "/win", "/territoryremove",
    ]);
    if (!isAdmin && adminOnly.has(command)) {
      await this.messenger.sendMessage(
        message.chat.id,
        `У вас нет прав организатора. Ваш Telegram ID: <code>${message.from!.id}</code>\nДобавьте его в ADMIN_TELEGRAM_IDS в файле .env и перезапустите бот.`,
        player ? MENU : undefined,
      );
      return true;
    }
    if (isAdmin && (adminOnly.has(command) || (command === "/mission" && argument))) {
      return this.handleAdmin(message.chat.id, command, argument);
    }
    if (!player && !["/admin"].includes(command)) return false;
    if (command === "/profile") await this.messenger.sendMessage(message.chat.id, profile(player!, state), MENU);
    else if (command === "/mission") await this.messenger.sendMessage(message.chat.id, missionText(state), MENU);
    else if (command === "/missions") await this.messenger.sendMessage(message.chat.id, missionsText(state, isAdmin, player!), MENU);
    else if (command === "/missionjoin") await this.joinMission(message.chat.id, player!, argument);
    else if (command === "/missionleave") await this.leaveMission(message.chat.id, player!, argument);
    else if (command === "/events") await this.messenger.sendMessage(message.chat.id, eventsText(state, player!), MENU);
    else if (command === "/ranking") await this.messenger.sendMessage(message.chat.id, generalRanking(state), MENU);
    else if (command === "/barrios") await this.messenger.sendMessage(message.chat.id, barrioRanking(state), MENU);
    else if (command === "/market") await this.messenger.sendMessage(message.chat.id, marketText(state), MENU);
    else if (command === "/dictionary" || command === "/dict") await this.messenger.sendMessage(message.chat.id, dictionaryText(), MENU);
    else if (command === "/territories" || command === "/map") await this.showTerritories(message.chat.id);
    else if (command === "/buy") await this.buy(message.chat.id, player!, argument);
    else if (command === "/restart") {
      if (argument) await this.resetCharacter(message.chat.id, player!, argument);
      else {
        this.pendingCharacterReset.add(message.from!.id);
        await this.messenger.sendMessage(message.chat.id, "Введите код подтверждения для удаления персонажа или отправьте /cancel.", MENU);
      }
    }
    else if (isAdmin) return this.handleAdmin(message.chat.id, command, argument);
    else return false;
    return true;
  }

  private async resetCharacter(chatId: number, player: Player, code: string): Promise<void> {
    if (code !== characterResetCode()) {
      this.pendingCharacterReset.add(player.telegramId);
      await this.messenger.sendMessage(chatId, "Неверный код. Персонаж не удалён. Попробуйте снова или отправьте /cancel.", MENU);
      return;
    }

    await this.store.update((state) => {
      state.players = state.players.filter((item) => item.telegramId !== player.telegramId);
      for (const mission of state.missions) {
        mission.participantIds = mission.participantIds.filter((id) => id !== player.telegramId);
        delete mission.barrioAssignments[String(player.telegramId)];
        delete mission.participantRegisteredAt[String(player.telegramId)];
      }
      for (const [barrioId, leaderId] of Object.entries(state.barrioLeaderIds)) {
        if (leaderId === player.telegramId) delete state.barrioLeaderIds[barrioId];
      }
    });
    this.pendingCharacterReset.delete(player.telegramId);
    await this.messenger.sendMessage(
      chatId,
      "🗑 Персонаж удалён. Отправьте /start, чтобы создать нового персонажа.",
    );
  }

  private async joinMission(chatId: number, player: Player, missionId: string): Promise<void> {
    const state = this.store.get();
    if (player.role === "police") {
      await this.messenger.sendMessage(chatId, "Policía не распределяется по barrios и не должна записываться как игрок.", MENU);
      return;
    }
    const mission = state.missions.find((item) => item.id === (missionId || state.activeMissionId));
    if (!mission) {
      await this.messenger.sendMessage(chatId, "Misión не найдена. Откройте «📋 Все misiones» и используйте её ID.", MENU);
      return;
    }
    if (mission.status === "completed") {
      await this.messenger.sendMessage(chatId, "Эта misión уже завершена.", MENU);
      return;
    }
    if (registrationWindow(mission) !== "open") {
      await this.messenger.sendMessage(chatId, `${registrationHint(mission)}. Записаться можно только в день misión, начиная за 10 минут до встречи.`, MENU);
      return;
    }
    if (mission.participantIds.includes(player.telegramId)) {
      await this.messenger.sendMessage(chatId, `Вы уже участвуете в этой misión: ${barrioLabel(mission.barrioAssignments[String(player.telegramId)] ?? null)}.`, MENU);
      return;
    }

    const barrioId = assignMissionBarrio(state, mission, player);
    await this.store.update(() => {
      mission.participantIds.push(player.telegramId);
      mission.barrioAssignments[String(player.telegramId)] = barrioId;
      mission.participantRegisteredAt[String(player.telegramId)] = new Date().toISOString();
    });
    await this.messenger.sendMessage(
      chatId,
      `✅ Вы записаны на <b>${escapeHtml(mission.title)}</b>.\n📅 ${missionSchedule(mission.meetingAt)}\nВаш barrio для этой misión: ${barrioLabel(barrioId)}.`,
      MENU,
    );
  }

  private async leaveMission(chatId: number, player: Player, missionId: string): Promise<void> {
    const state = this.store.get();
    const mission = state.missions.find((item) => item.id === (missionId || state.activeMissionId));
    if (!mission || !mission.participantIds.includes(player.telegramId)) {
      await this.messenger.sendMessage(chatId, "Вы не записаны на эту misión.", MENU);
      return;
    }
    if (mission.status === "completed") {
      await this.messenger.sendMessage(chatId, "Завершённую misión изменить нельзя.", MENU);
      return;
    }
    await this.store.update(() => {
      mission.participantIds = mission.participantIds.filter((id) => id !== player.telegramId);
      delete mission.barrioAssignments[String(player.telegramId)];
      delete mission.participantRegisteredAt[String(player.telegramId)];
    });
    await this.messenger.sendMessage(chatId, `Вы отменили участие в <b>${escapeHtml(mission.title)}</b>.`, MENU);
  }

  private async buy(chatId: number, player: Player, itemId: string): Promise<void> {
    const item = this.store.get().market.find((entry) => entry.id.toLowerCase() === itemId.toLowerCase());
    if (!item) return this.messenger.sendMessage(chatId, "Товар не найден. Откройте /market.");
    if (item.minimumRespeto && player.respeto < item.minimumRespeto) return this.messenger.sendMessage(chatId, `Нужно минимум ${item.minimumRespeto} Respeto.`);
    if (item.stock !== null && item.stock < 1) return this.messenger.sendMessage(chatId, "Товар закончился.");
    if (player.dinero < item.price) return this.messenger.sendMessage(chatId, "Недостаточно Dinero.");
    await this.store.update(() => {
      player.dinero -= item.price;
      player.inventory.push(item.id);
      if (item.stock !== null) item.stock -= 1;
    });
    await this.messenger.sendMessage(chatId, `Покупка совершена: ${escapeHtml(item.name)}. Осталось ${player.dinero} Dinero.`, MENU);
  }

  private async notifyPlayers(target: "user" | "barrio" | "mission", targetId: string, players: Player[], text: string): Promise<number> {
    let sentCount = 0;
    for (const player of players) {
      try {
        await this.messenger.sendMessage(player.chatId, `📣 <b>LOS BARRIOS</b>\n${escapeHtml(text)}`, MENU);
        sentCount += 1;
      } catch (error) {
        console.error(`Could not notify ${player.telegramId}:`, error);
      }
    }
    await this.store.update((state) => {
      state.notifications.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString(), target, targetId, text, sentCount });
      state.notifications.splice(250);
    });
    return sentCount;
  }

  private missionRoster(mission: MissionRecord, state: GameState): string {
    const participants = mission.participantIds
      .map((id) => findPlayer(state, id))
      .filter((player): player is Player => Boolean(player));
    const lines = gameConfig.barrios.map((barrio) => {
      const names = participants.filter((player) => mission.barrioAssignments[String(player.telegramId)] === barrio.id)
        .map((player) => escapeHtml(player.nickname));
      return `${barrio.emoji} <b>${escapeHtml(barrio.name)}</b>: ${names.join(", ") || "—"}`;
    });
    return [`👥 <b>${escapeHtml(mission.title)}</b>`, `Записано: ${participants.length}`, "", ...lines].join("\n");
  }

  private async handleAdmin(chatId: number, command: string, argument: string): Promise<boolean> {
    const state = this.store.get();
    if (command === "/admin") {
      await this.messenger.sendMessage(chatId, adminHelp());
      return true;
    }
    if (command === "/players") {
      const barrioPlayers = state.players.filter((p) => p.role === "player").length;
      const police = state.players.filter((p) => p.role === "police").length;
      await this.messenger.sendMessage(chatId, `Участники: ${state.players.length}\nВ barrios: ${barrioPlayers}\nPolicía: ${police}/${requiredPoliceCount(barrioPlayers, gameConfig)}\n\n${generalRanking(state)}`);
      return true;
    }
    if (command === "/missionroster") {
      const mission = state.missions.find((item) => item.id === (argument || state.activeMissionId));
      await this.messenger.sendMessage(chatId, mission ? this.missionRoster(mission, state) : "Misión не найдена. Формат: /missionroster ID");
      return true;
    }
    if (command === "/assign") {
      const parts = argument.split("|").map((value) => value.trim());
      const [missionId, nickname, barrioId] = parts.length === 3
        ? parts
        : [state.activeMissionId ?? "", parts[0] ?? "", parts[1] ?? ""];
      const mission = state.missions.find((item) => item.id === missionId);
      const target = findByNickname(state, nickname);
      const barrio = gameConfig.barrios.find((item) => item.id === barrioId);
      if (!mission || !target || !barrio || !mission.participantIds.includes(target.telegramId)) {
        await this.messenger.sendMessage(chatId, "Формат: /assign [MISSION_ID |] НИК | ID_BARRIO\nИгрок должен быть записан на misión.");
        return true;
      }
      await this.store.update(() => { mission.barrioAssignments[String(target.telegramId)] = barrio.id; });
      await this.messenger.sendMessage(chatId, `${escapeHtml(target.nickname)} назначен в ${barrioLabel(barrio.id)} для misión ${escapeHtml(mission.id)}.`);
      await this.messenger.sendMessage(target.chatId, `🏘 Организатор назначил вам barrio для misión «${escapeHtml(mission.title)}»: ${barrioLabel(barrio.id)}.`, MENU);
      return true;
    }
    if (command === "/messageuser" || command === "/messagebarrio" || command === "/missionmessage") {
      const [first, ...rest] = argument.split("|").map((value) => value.trim());
      let recipients: Player[] = [];
      let target: "user" | "barrio" | "mission" = "user";
      let targetId = first ?? "";
      let text = rest.join(" | ");
      if (command === "/messageuser") {
        const player = findByNickname(state, first ?? "");
        recipients = player ? [player] : [];
      } else {
        const mission = state.missions.find((item) => item.id === (command === "/missionmessage" && rest.length > 0 ? first : state.activeMissionId));
        if (command === "/missionmessage" && rest.length === 0) { text = first ?? ""; targetId = mission?.id ?? ""; }
        if (command === "/missionmessage" && rest.length > 0) { text = rest.join(" | "); targetId = first ?? ""; }
        if (command === "/messagebarrio") {
          target = "barrio";
          if (!gameConfig.barrios.some((item) => item.id === first)) recipients = [];
          else recipients = mission ? mission.participantIds.map((id) => findPlayer(state, id)).filter((player): player is Player => Boolean(player) && mission.barrioAssignments[String(player!.telegramId)] === first) : [];
        } else {
          target = "mission";
          recipients = mission ? mission.participantIds.map((id) => findPlayer(state, id)).filter((player): player is Player => Boolean(player)) : [];
        }
      }
      if (!text || !recipients.length) {
        await this.messenger.sendMessage(chatId, command === "/messageuser" ? "Формат: /messageuser НИК | ТЕКСТ" : command === "/messagebarrio" ? "Формат: /messagebarrio ID_BARRIO | ТЕКСТ (только участникам текущей misión)" : "Формат: /missionmessage [ID |] ТЕКСТ");
        return true;
      }
      const sent = await this.notifyPlayers(target, targetId, recipients, text);
      await this.messenger.sendMessage(chatId, `Сообщение отправлено: ${sent}/${recipients.length}.`);
      return true;
    }
    if (command === "/penaltylist") {
      const items = state.penaltyCatalog.map((item) => `<code>${escapeHtml(item.id)}</code> — <b>${escapeHtml(item.name)}</b>\n${escapeHtml(item.description)}`);
      await this.messenger.sendMessage(chatId, items.length ? `⚠️ <b>Каталог Penitencias</b>\n\n${items.join("\n\n")}` : "Каталог Penitencias пока пуст. Добавьте: /penaltyadd ID | НАЗВАНИЕ | ОПИСАНИЕ");
      return true;
    }
    if (command === "/penaltyadd" || command === "/penaltyedit") {
      const [id, name, description] = argument.split("|").map((value) => value.trim());
      const existing = state.penaltyCatalog.find((item) => item.id === id);
      if (!id || !name || !description || (command === "/penaltyadd" && existing) || (command === "/penaltyedit" && !existing)) {
        await this.messenger.sendMessage(chatId, `Формат: ${command} ID | НАЗВАНИЕ | ОПИСАНИЕ`);
        return true;
      }
      await this.store.update((s) => {
        if (existing) Object.assign(existing, { id, name, description });
        else s.penaltyCatalog.push({ id, name, description });
      });
      await this.messenger.sendMessage(chatId, existing ? "Penitencia изменена." : "Penitencia добавлена в каталог.");
      return true;
    }
    if (command === "/penaltydelete") {
      const index = state.penaltyCatalog.findIndex((item) => item.id === argument);
      if (index < 0) await this.messenger.sendMessage(chatId, "Penitencia не найдена.");
      else {
        await this.store.update((s) => { s.penaltyCatalog.splice(index, 1); });
        await this.messenger.sendMessage(chatId, "Penitencia удалена из каталога. Уже выданные записи у игроков сохранены.");
      }
      return true;
    }
    if (command === "/penaltysend" || command === "/penaltybarrio") {
      const [targetId, penaltyId] = argument.split("|").map((value) => value.trim());
      const penalty = state.penaltyCatalog.find((item) => item.id === penaltyId);
      const mission = activeMission(state);
      const recipients = command === "/penaltysend"
        ? [findByNickname(state, targetId)].filter((player): player is Player => Boolean(player))
        : mission && gameConfig.barrios.some((item) => item.id === targetId)
          ? mission.participantIds.map((id) => findPlayer(state, id)).filter((player): player is Player => Boolean(player) && mission.barrioAssignments[String(player!.telegramId)] === targetId)
          : [];
      if (!penalty || !recipients.length) {
        await this.messenger.sendMessage(chatId, command === "/penaltysend" ? "Формат: /penaltysend НИК | ID_ШТРАФА" : "Формат: /penaltybarrio ID_BARRIO | ID_ШТРАФА (для текущей misión)");
        return true;
      }
      const entry = `${penalty.name}: ${penalty.description}`;
      await this.store.update(() => { for (const player of recipients) player.penalties.push(entry); });
      for (const player of recipients) await this.messenger.sendMessage(player.chatId, `🚨 Новая Penitencia: <b>${escapeHtml(penalty.name)}</b>\n${escapeHtml(penalty.description)}`, MENU);
      await this.messenger.sendMessage(chatId, `Penitencia выдана: ${recipients.length} игрокам.`);
      return true;
    }
    if (command === "/leader") {
      const [barrioId, nickname] = argument.split("|").map((value) => value.trim());
      const barrio = gameConfig.barrios.find((item) => item.id === barrioId);
      const target = findByNickname(state, nickname ?? "");
      if (!barrio || !target || target.role !== "player") {
        await this.messenger.sendMessage(chatId, "Формат: /leader ID_BARRIO | НИК\nИгрок должен быть зарегистрирован и не состоять в Policía.");
        return true;
      }
      await this.store.update((s) => {
        for (const [id, telegramId] of Object.entries(s.barrioLeaderIds)) {
          if (telegramId === target.telegramId) delete s.barrioLeaderIds[id];
        }
        s.barrioLeaderIds[barrio.id] = target.telegramId;
        for (const mission of s.missions) {
          if (mission.status !== "completed" && mission.participantIds.includes(target.telegramId)) {
            mission.barrioAssignments[String(target.telegramId)] = barrio.id;
          }
        }
      });
      await this.messenger.sendMessage(chatId, `👑 ${escapeHtml(target.nickname)} назначен лидером ${barrioLabel(barrio.id)}.`);
      await this.messenger.sendMessage(target.chatId, `👑 Вы назначены лидером ${barrioLabel(barrio.id)}. В каждой misión вы будете играть за этот barrio.`, MENU);
      return true;
    }
    if (command === "/leaderremove") {
      const barrio = gameConfig.barrios.find((item) => item.id === argument);
      if (!barrio || !state.barrioLeaderIds[barrio.id]) {
        await this.messenger.sendMessage(chatId, "Лидер не найден. Формат: /leaderremove ID_BARRIO");
        return true;
      }
      const formerLeader = findPlayer(state, state.barrioLeaderIds[barrio.id]);
      await this.store.update((s) => { delete s.barrioLeaderIds[barrio.id]; });
      await this.messenger.sendMessage(chatId, `Лидер ${barrioLabel(barrio.id)} снят.`);
      if (formerLeader) await this.messenger.sendMessage(formerLeader.chatId, `Вы больше не лидер ${barrioLabel(barrio.id)}.`, MENU);
      return true;
    }
    if (command !== "/mission" && command.startsWith("/mission")) {
      return this.handleMissionAdmin(chatId, command, argument);
    }
    if (command.startsWith("/event")) {
      return this.handleEventAdmin(chatId, command, argument);
    }
    if (command.startsWith("/shop")) {
      return this.handleMarketAdmin(chatId, command, argument);
    }
    if (command === "/mission") {
      const [meetingAt, title, description] = argument.split("|").map((value) => value.trim());
      if (!meetingAt || !title || !description || Number.isNaN(Date.parse(meetingAt))) {
        await this.messenger.sendMessage(chatId, "Формат: /mission 2026-09-12T18:00:00+03:00 | Название | Описание");
      } else {
        await this.store.update((s) => {
          s.mission = {
            meetingAt,
            title,
            description,
            location: gameConfig.event.location,
            vocabulary: s.mission?.vocabulary ?? gameConfig.event.currentMission.vocabulary,
            examples: s.mission?.examples ?? gameConfig.event.currentMission.examples,
          };
        });
        await this.messenger.sendMessage(chatId, "Misión обновлена.");
      }
      return true;
    }
    if (command === "/shopadd") {
      const [id, name, priceRaw, description] = argument.split("|").map((value) => value.trim());
      const price = Number(priceRaw);
      if (!id || !name || !description || !Number.isSafeInteger(price) || price < 0) await this.messenger.sendMessage(chatId, "Формат: /shopadd ID | Название | Цена | Описание");
      else if (state.market.some((item) => item.id === id)) await this.messenger.sendMessage(chatId, "Такой ID товара уже существует.");
      else {
        await this.store.update((s) => { s.market.push({ id, name, description, price, stock: null }); });
        await this.messenger.sendMessage(chatId, "Товар добавлен.");
      }
      return true;
    }
    if (command === "/leaderphoto") {
      const barrio = gameConfig.barrios.find((item) => item.id === argument);
      if (!barrio) await this.messenger.sendMessage(chatId, `Неизвестный barrio. ID: ${gameConfig.barrios.map((item) => item.id).join(", ")}`);
      else if (barrio.leader.hidePhoto) await this.messenger.sendMessage(chatId, `${escapeHtml(barrio.name)} настроен без фотографии.`);
      else {
        this.pendingLeaderPhoto.set(chatId, barrio.id);
        await this.messenger.sendMessage(chatId, `Теперь отправьте оригинальное фото лидера ${escapeHtml(barrio.leader.name)} как фотографию.`);
      }
      return true;
    }
    if (command === "/mapphoto") {
      this.pendingMapPhoto.add(chatId);
      await this.messenger.sendMessage(chatId, "Теперь отправьте оригинальную карту как фотографию. Бот сохранит её без генерации и будет накладывать цвета территорий.");
      return true;
    }
    if (command === "/win") {
      const barrio = gameConfig.barrios.find((item) => item.id === argument);
      if (!barrio) await this.messenger.sendMessage(chatId, `Формат: /win ID_BARRIO\nID: ${gameConfig.barrios.map((item) => item.id).join(", ")}`);
      else {
        let wonZone = 0;
        await this.store.update((s) => {
          const neutral = TERRITORIES.map((_, index) => index + 1).filter((zone) => !s.territories[String(zone)]);
          let candidates = neutral;
          if (!candidates.length) {
            const rivalCounts = new Map<string, number>();
            for (const owner of Object.values(s.territories)) {
              if (owner && owner !== barrio.id) rivalCounts.set(owner, (rivalCounts.get(owner) ?? 0) + 1);
            }
            const maximum = Math.max(...rivalCounts.values());
            const largestRivals = new Set([...rivalCounts].filter(([, count]) => count === maximum).map(([id]) => id));
            candidates = TERRITORIES.map((_, index) => index + 1).filter((zone) => largestRivals.has(s.territories[String(zone)] ?? ""));
          }
          wonZone = candidates[Math.floor(Math.random() * candidates.length)] ?? 0;
          if (wonZone) s.territories[String(wonZone)] = barrio.id;
        });
        await this.messenger.sendMessage(chatId, wonZone ? `${barrio.emoji} ${escapeHtml(barrio.name)} получает территорию №${wonZone}: <b>${escapeHtml(TERRITORIES[wonZone - 1])}</b>\n\n${territoryText(state)}` : "Не удалось назначить территорию.");
      }
      return true;
    }
    if (command === "/territoryremove") {
      const zoneNumber = Number(argument);
      let zone = 0;
      if (Number.isSafeInteger(zoneNumber) && zoneNumber >= 1 && zoneNumber <= TERRITORIES.length) {
        zone = zoneNumber;
      } else {
        const barrio = gameConfig.barrios.find((item) => item.id === argument);
        if (!barrio) {
          await this.messenger.sendMessage(chatId, `Формат: /territoryremove ID_BARRIO или НОМЕР_ЗОНЫ\nID: ${gameConfig.barrios.map((item) => item.id).join(", ")}`);
          return true;
        }
        const owned = TERRITORIES.map((_, index) => index + 1).filter(
          (candidate) => state.territories[String(candidate)] === barrio.id,
        );
        zone = owned[Math.floor(Math.random() * owned.length)] ?? 0;
      }
      const previousOwner = zone ? state.territories[String(zone)] : null;
      if (!zone || !previousOwner) {
        await this.messenger.sendMessage(chatId, "У этого barrio нет территории для удаления, либо выбранная зона уже нейтральна.");
        return true;
      }
      await this.store.update((s) => { s.territories[String(zone)] = null; });
      const previousBarrio = gameConfig.barrios.find((item) => item.id === previousOwner);
      await this.messenger.sendMessage(
        chatId,
        `⚪ Территория №${zone} <b>${escapeHtml(TERRITORIES[zone - 1])}</b> больше не принадлежит ${previousBarrio ? `${previousBarrio.emoji} ${escapeHtml(previousBarrio.name)}` : escapeHtml(previousOwner)}.\n\n${territoryText(state)}`,
      );
      return true;
    }

    const match = argument.match(/^(.*?)\s+(-?\d+)$/);
    if (["/money", "/respeto", "/wanted"].includes(command)) {
      if (!match) await this.messenger.sendMessage(chatId, `Формат: ${command} НИК ЧИСЛО`);
      else {
        const target = findByNickname(state, match[1]);
        const amount = Number(match[2]);
        if (!target) await this.messenger.sendMessage(chatId, "Игрок не найден.");
        else {
          await this.store.update(() => {
            if (command === "/money") target.dinero = Math.max(0, target.dinero + amount);
            if (command === "/respeto") target.respeto += amount;
            if (command === "/wanted") target.wantedLevel = Math.max(0, Math.min(3, amount));
          });
          await this.messenger.sendMessage(chatId, `Обновлено: ${escapeHtml(target.nickname)}.`);
          await this.messenger.sendMessage(target.chatId, `⚠️ Организатор обновил ваш статус.\n\n${profile(target, state)}`, MENU);
        }
      }
      return true;
    }
    if (command === "/penalty") {
      const [nickname, penalty] = argument.split("|").map((value) => value.trim());
      const target = findByNickname(state, nickname ?? "");
      if (!target || !penalty) await this.messenger.sendMessage(chatId, "Формат: /penalty НИК | ТЕКСТ");
      else {
        await this.store.update(() => { target.penalties.push(penalty); });
        await this.messenger.sendMessage(chatId, "Penitencia добавлена.");
        await this.messenger.sendMessage(target.chatId, `🚨 Новая Penitencia: ${escapeHtml(penalty)}`, MENU);
      }
      return true;
    }
    if (command === "/clearpenalties" || command === "/police") {
      const target = findByNickname(state, argument);
      if (!target) await this.messenger.sendMessage(chatId, "Игрок не найден.");
      else if (command === "/clearpenalties") {
        await this.store.update(() => { target.penalties = []; });
        await this.messenger.sendMessage(chatId, "Penitencias сняты.");
      } else {
        if (target.role === "player") {
          await this.store.update((s) => {
            target.role = "police";
            target.barrioId = null;
            for (const [barrioId, telegramId] of Object.entries(s.barrioLeaderIds)) {
              if (telegramId === target.telegramId) delete s.barrioLeaderIds[barrioId];
            }
            for (const mission of s.missions) {
              mission.participantIds = mission.participantIds.filter((id) => id !== target.telegramId);
              delete mission.barrioAssignments[String(target.telegramId)];
              delete mission.participantRegisteredAt[String(target.telegramId)];
            }
          });
        } else {
          const existing = state.players
            .filter((p) => p.role === "player" && p.barrioId)
            .map((p) => ({ playerId: String(p.telegramId), barrioId: p.barrioId!, moveCount: p.moveCount }));
          const result = assignPlayer(String(target.telegramId), existing, gameConfig);
          await this.store.update(() => {
            target.role = "player";
            for (const assignment of result.assignments) {
              const assigned = state.players.find((p) => String(p.telegramId) === assignment.playerId);
              if (assigned) {
                assigned.barrioId = assignment.barrioId;
                assigned.moveCount = assignment.moveCount ?? assigned.moveCount;
              }
            }
          });
          for (const movedId of result.movedPlayerIds) {
            const moved = findPlayer(state, Number(movedId));
            if (moved) await this.messenger.sendMessage(moved.chatId, `⚠️ Для баланса вы переведены в ${barrioLabel(moved.barrioId)}.`);
          }
        }
        await this.messenger.sendMessage(chatId, `Роль ${escapeHtml(target.nickname)}: ${target.role === "police" ? "Policía" : barrioLabel(target.barrioId)}.`);
        await this.messenger.sendMessage(target.chatId, `Ваша роль изменена: ${target.role === "police" ? "👮 Policía" : "игрок"}.`, MENU);
      }
      return true;
    }
    return false;
  }

  private async handleMissionAdmin(chatId: number, command: string, argument: string): Promise<boolean> {
    const state = this.store.get();
    if (command === "/missionlist") {
      await this.messenger.sendMessage(chatId, missionsText(state, true));
      return true;
    }
    if (command === "/missionadd" || command === "/missionedit") {
      const [id, meetingAt, title, description, location] = argument.split("|").map((value) => value.trim());
      if (!id || !meetingAt || !title || !description || Number.isNaN(Date.parse(meetingAt))) {
        await this.messenger.sendMessage(chatId, `Формат: ${command} ID | 2026-09-12T18:00:00+03:00 | Название | Описание | Место`);
        return true;
      }
      const existing = state.missions.find((mission) => mission.id === id);
      if (command === "/missionadd" && existing) {
        await this.messenger.sendMessage(chatId, "Misión с таким ID уже существует. Используйте /missionedit.");
        return true;
      }
      if (command === "/missionedit" && !existing) {
        await this.messenger.sendMessage(chatId, "Misión не найдена. Используйте /missionadd.");
        return true;
      }
      await this.store.update((s) => {
        const record: MissionRecord = {
          id,
          meetingAt,
          title,
          description,
          location: location || gameConfig.event.location,
          status: existing?.status ?? "draft",
          vocabulary: existing?.vocabulary ?? [],
          examples: existing?.examples ?? [],
          rewardDinero: existing?.rewardDinero,
          rewardRespeto: existing?.rewardRespeto,
          participantIds: existing?.participantIds ?? [],
          barrioAssignments: existing?.barrioAssignments ?? {},
          participantRegisteredAt: existing?.participantRegisteredAt ?? {},
        };
        if (existing) Object.assign(existing, record);
        else s.missions.push(record);
      });
      await this.messenger.sendMessage(chatId, `Misión <code>${escapeHtml(id)}</code> ${existing ? "изменена" : "создана"}.`);
      return true;
    }
    if (command === "/missiontime") {
      const [id, date, time] = argument.split("|").map((value) => value.trim());
      const mission = state.missions.find((item) => item.id === id);
      const meetingAt = missionDateTime(date, time);
      if (!mission || !meetingAt) {
        await this.messenger.sendMessage(chatId, "Формат: /missiontime ID | ГГГГ-ММ-ДД | ЧЧ:ММ\nПример: /missiontime intro | 2026-09-20 | 18:30");
        return true;
      }
      await this.store.update((s) => {
        mission.meetingAt = meetingAt;
        if (s.activeMissionId === mission.id && s.mission) s.mission.meetingAt = meetingAt;
      });
      await this.messenger.sendMessage(
        chatId,
        `📅 Дата и время misión <code>${escapeHtml(id)}</code> установлены: <b>${missionSchedule(meetingAt)}</b>.`,
      );
      return true;
    }
    if (command === "/missionvocab") {
      const [id, spanish, russian] = argument.split("|").map((value) => value.trim());
      const mission = state.missions.find((item) => item.id === id);
      if (!mission || !spanish || !russian) await this.messenger.sendMessage(chatId, "Формат: /missionvocab ID | Испанская фраза | Русский перевод");
      else {
        await this.store.update(() => { (mission.vocabulary ??= []).push({ spanish, russian }); });
        await this.messenger.sendMessage(chatId, "Фраза добавлена в словарь misión.");
      }
      return true;
    }
    if (command === "/missionexample") {
      const [id, ...exampleParts] = argument.split("|").map((value) => value.trim());
      const example = exampleParts.join(" | ");
      const mission = state.missions.find((item) => item.id === id);
      if (!mission || !example) await this.messenger.sendMessage(chatId, "Формат: /missionexample ID | Что должны сделать игроки");
      else {
        await this.store.update(() => { (mission.examples ??= []).push(example); });
        await this.messenger.sendMessage(chatId, "Пример действия добавлен.");
      }
      return true;
    }
    if (command === "/missionstart") {
      const mission = state.missions.find((item) => item.id === argument);
      if (!mission) await this.messenger.sendMessage(chatId, "Misión не найдена. Откройте /missionlist.");
      else {
        await this.store.update((s) => {
          for (const item of s.missions) if (item.status === "active") item.status = "completed";
          mission.status = "active";
          s.activeMissionId = mission.id;
          s.mission = mission;
        });
        await this.broadcast(`🔔 Началась новая misión!\n\n${missionText(state)}`);
        await this.messenger.sendMessage(chatId, "Misión активирована и отправлена игрокам.");
      }
      return true;
    }
    if (command === "/missionfinish") {
      const mission = state.missions.find((item) => item.id === (argument || state.activeMissionId));
      if (!mission) await this.messenger.sendMessage(chatId, "Активная misión не найдена.");
      else {
        await this.store.update((s) => {
          mission.status = "completed";
          if (s.activeMissionId === mission.id) {
            s.activeMissionId = null;
            s.mission = null;
          }
        });
        await this.messenger.sendMessage(chatId, "Misión завершена.");
      }
      return true;
    }
    if (command === "/missiondelete") {
      const index = state.missions.findIndex((item) => item.id === argument);
      if (index < 0) await this.messenger.sendMessage(chatId, "Misión не найдена.");
      else {
        await this.store.update((s) => {
          const [removed] = s.missions.splice(index, 1);
          if (s.activeMissionId === removed.id) {
            s.activeMissionId = null;
            s.mission = null;
          }
        });
        await this.messenger.sendMessage(chatId, "Misión удалена.");
      }
      return true;
    }
    return false;
  }

  private async handleMarketAdmin(chatId: number, command: string, argument: string): Promise<boolean> {
    const state = this.store.get();
    if (command === "/shoplist") {
      await this.messenger.sendMessage(chatId, marketText(state));
      return true;
    }
    if (command === "/shopadd" || command === "/shopedit") {
      const parts = argument.split("|").map((value) => value.trim());
      const [id, name, priceRaw] = parts;
      const hasStock = parts.length >= 5;
      const stockRaw = hasStock ? parts[3] : "all";
      const description = hasStock ? parts.slice(4).join(" | ") : parts.slice(3).join(" | ");
      const price = Number(priceRaw);
      const stock = stockRaw.toLowerCase() === "all" ? null : Number(stockRaw);
      if (!id || !name || !description || !Number.isSafeInteger(price) || price < 0 || (stock !== null && (!Number.isSafeInteger(stock) || stock < 0))) {
        await this.messenger.sendMessage(chatId, `Формат: ${command} ID | Название | Цена | Остаток/all | Описание`);
        return true;
      }
      const existing = state.market.find((item) => item.id === id);
      if (command === "/shopadd" && existing) await this.messenger.sendMessage(chatId, "Товар уже существует. Используйте /shopedit.");
      else if (command === "/shopedit" && !existing) await this.messenger.sendMessage(chatId, "Товар не найден. Используйте /shopadd.");
      else {
        await this.store.update((s) => {
          const item = { id, name, price, stock, description };
          if (existing) Object.assign(existing, item);
          else s.market.push(item);
        });
        await this.messenger.sendMessage(chatId, `Товар ${existing ? "изменён" : "добавлен"}.`);
      }
      return true;
    }
    if (command === "/shopdelete") {
      const index = state.market.findIndex((item) => item.id === argument);
      if (index < 0) await this.messenger.sendMessage(chatId, "Товар не найден.");
      else {
        await this.store.update((s) => { s.market.splice(index, 1); });
        await this.messenger.sendMessage(chatId, "Товар удалён из Mercado.");
      }
      return true;
    }
    return false;
  }

  private async handleEventAdmin(chatId: number, command: string, argument: string): Promise<boolean> {
    const state = this.store.get();
    if (command === "/eventlist") {
      const lines = state.events.length
        ? state.events.map((event) => `${event.status === "active" ? "🟢" : event.status === "completed" ? "✅" : "⚪"} <code>${escapeHtml(event.id)}</code> — ${escapeHtml(event.title)} → ${escapeHtml(event.target)}`)
        : ["Событий пока нет."];
      await this.messenger.sendMessage(chatId, ["🎭 <b>Игровые события</b>", ...lines].join("\n"));
      return true;
    }
    if (command === "/eventpreset") {
      const [presetRaw, targetRaw] = argument.split("|").map((value) => value.trim());
      const preset = presetRaw?.toLowerCase();
      const definitions: Record<string, { type: GameEvent["type"]; title: string; description: string }> = {
        rata: { type: "la_rata", title: "🐀 La Rata", description: "Найди Espía, купи секретную информацию и передай её Policía, не попавшись во время сделки." },
        robo: { type: "robo", title: "💰 Robo", description: "Произошла кража. Найдите украденный предмет или деньги и установите виновного." },
        guerra: { type: "guerra", title: "⚔️ Guerra entre bandas", description: "Между Barrios объявлена guerra: торговля и официальное сотрудничество между сторонами запрещены до заключения paz." },
      };
      const definition = definitions[preset];
      if (!definition) {
        await this.messenger.sendMessage(chatId, "Формат: /eventpreset rata|robo|guerra | ЦЕЛЬ\nЦель: all, police, nickname или ID barrio; для guerra можно nomadas,navegantes.");
        return true;
      }
      const event: GameEvent = {
        id: `${preset}-${Date.now().toString(36)}`,
        ...definition,
        target: targetRaw || "all",
        status: "draft",
        createdAt: new Date().toISOString(),
      };
      await this.store.update((s) => { s.events.push(event); });
      await this.messenger.sendMessage(chatId, `Создан черновик <code>${event.id}</code>. Запуск: /eventstart ${event.id}`);
      return true;
    }
    if (command === "/eventadd" || command === "/eventedit") {
      const [id, typeRaw, title, description, targetRaw] = argument.split("|").map((value) => value.trim());
      const type = typeRaw as GameEvent["type"];
      if (!id || !["la_rata", "robo", "guerra", "custom"].includes(type) || !title || !description) {
        await this.messenger.sendMessage(chatId, `Формат: ${command} ID | la_rata/robo/guerra/custom | Название | Описание | Цель`);
        return true;
      }
      const existing = state.events.find((event) => event.id === id);
      if (command === "/eventadd" && existing) await this.messenger.sendMessage(chatId, "Событие уже существует. Используйте /eventedit.");
      else if (command === "/eventedit" && !existing) await this.messenger.sendMessage(chatId, "Событие не найдено. Используйте /eventadd.");
      else {
        await this.store.update((s) => {
          const event: GameEvent = { id, type, title, description, target: targetRaw || "all", status: existing?.status ?? "draft", createdAt: existing?.createdAt ?? new Date().toISOString() };
          if (existing) Object.assign(existing, event);
          else s.events.push(event);
        });
        await this.messenger.sendMessage(chatId, `Событие ${existing ? "изменено" : "создано"}.`);
      }
      return true;
    }
    if (command === "/eventstart" || command === "/eventfinish") {
      const event = state.events.find((item) => item.id === argument);
      if (!event) await this.messenger.sendMessage(chatId, "Событие не найдено. Откройте /eventlist.");
      else {
        const starting = command === "/eventstart";
        await this.store.update(() => { event.status = starting ? "active" : "completed"; });
        await this.broadcast(
          starting ? `🔔 Новое событие!\n\n<b>${escapeHtml(event.title)}</b>\n${escapeHtml(event.description)}` : `✅ Событие завершено: <b>${escapeHtml(event.title)}</b>`,
          (player) => eventTargetsPlayer(event, player, this.store.get()),
        );
        await this.messenger.sendMessage(chatId, starting ? "Событие запущено и отправлено целевой аудитории." : "Событие завершено.");
      }
      return true;
    }
    if (command === "/eventdelete") {
      const index = state.events.findIndex((event) => event.id === argument);
      if (index < 0) await this.messenger.sendMessage(chatId, "Событие не найдено.");
      else {
        await this.store.update((s) => { s.events.splice(index, 1); });
        await this.messenger.sendMessage(chatId, "Событие удалено.");
      }
      return true;
    }
    return false;
  }

  private async broadcast(text: string, filter: (player: Player) => boolean = () => true): Promise<void> {
    for (const player of this.store.get().players.filter(filter)) {
      try {
        await this.messenger.sendMessage(player.chatId, text, MENU);
      } catch (error) {
        console.error(`Broadcast to ${player.telegramId} failed:`, error);
      }
    }
  }

  private async ensureTerritories(): Promise<void> {
    const state = this.store.get();
    if (Object.keys(state.territories).length === TERRITORIES.length) return;
    await this.store.update((s) => {
      for (let zone = 1; zone <= TERRITORIES.length; zone += 1) s.territories[String(zone)] ??= null;
      const alreadyAssigned = new Set(Object.values(s.territories).filter(Boolean));
      const freeZones = TERRITORIES.map((_, index) => index + 1).filter((zone) => !s.territories[String(zone)]);
      for (const barrio of gameConfig.barrios) {
        if (alreadyAssigned.has(barrio.id)) continue;
        const selection = Math.floor(Math.random() * freeZones.length);
        const [zone] = freeZones.splice(selection, 1);
        if (zone) s.territories[String(zone)] = barrio.id;
      }
    });
  }

  private async receiveLeaderPhoto(message: TelegramMessage): Promise<void> {
    if (this.pendingMapPhoto.has(message.chat.id) && parseAdminIds().has(message.from!.id)) {
      const photo = message.photo!.at(-1)!;
      await this.store.update((state) => { state.mapPhotoFileId = photo.file_id; });
      this.pendingMapPhoto.delete(message.chat.id);
      await this.messenger.sendMessage(message.chat.id, "Оригинальная карта сохранена. Откройте /map, чтобы увидеть текущие цвета территорий.");
      return;
    }
    const barrioId = this.pendingLeaderPhoto.get(message.chat.id);
    if (!parseAdminIds().has(message.from!.id) || !barrioId) {
      await this.messenger.sendMessage(message.chat.id, "Фотография не ожидается. Организатор должен сначала использовать /leaderphoto ID_BARRIO.");
      return;
    }
    const photo = message.photo!.at(-1)!;
    await this.store.update((state) => { state.leaderPhotoFileIds[barrioId] = photo.file_id; });
    this.pendingLeaderPhoto.delete(message.chat.id);
    const barrio = gameConfig.barrios.find((item) => item.id === barrioId)!;
    await this.messenger.sendMessage(message.chat.id, `Фото лидера ${escapeHtml(barrio.leader.name)} сохранено для ${escapeHtml(barrio.name)}.`);
  }

  private async showTerritories(chatId: number): Promise<void> {
    const state = this.store.get();
    const text = territoryText(state);
    if (!state.mapPhotoFileId) {
      await this.messenger.sendMessage(chatId, `${text}\n\nОрганизатор ещё не загрузил оригинальную карту.`, MENU);
      return;
    }
    try {
      const original = await this.messenger.downloadFile(state.mapPhotoFileId);
      const rendered = await renderTerritoryMap(original, state.territories, gameConfig);
      await this.messenger.sendPhoto(chatId, rendered, text);
    } catch (error) {
      console.error("Map rendering failed:", error);
      await this.messenger.sendMessage(chatId, `${text}\n\nНе удалось обработать карту; показаны актуальные данные текстом.`, MENU);
    }
  }
}
