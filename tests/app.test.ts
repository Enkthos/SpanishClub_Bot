import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotApp } from "../src/app";
import { JsonStore } from "../src/store";
import type { InlineKeyboardMarkup, MessageMarkup, Messenger, ReplyMarkup, TelegramMessage } from "../src/telegram";

class FakeMessenger implements Messenger {
  messages: { chatId: number; text: string; replyMarkup?: ReplyMarkup | InlineKeyboardMarkup }[] = [];
  photos: { chatId: number; photo: string; caption: string }[] = [];
  async sendMessage(chatId: number, text: string, replyMarkup?: MessageMarkup): Promise<void> {
    this.messages.push({ chatId, text, replyMarkup });
  }
  async sendPhoto(chatId: number, photo: string | Uint8Array, caption: string): Promise<void> {
    this.photos.push({ chatId, photo: typeof photo === "string" ? photo : "rendered-map", caption });
  }
  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async answerCallbackQuery(): Promise<void> {}
}

const temporaryDirectories: string[] = [];

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "los-barrios-test-"));
  temporaryDirectories.push(directory);
  const store = new JsonStore(join(directory, "state.json"));
  await store.load();
  const messenger = new FakeMessenger();
  return { app: new BotApp(store, messenger), store, messenger };
}

function message(userId: number, text: string): TelegramMessage {
  return {
    message_id: 1,
    from: { id: userId, first_name: `User ${userId}` },
    chat: { id: userId, type: "private" },
    text,
  };
}

afterEach(async () => {
  delete process.env.ADMIN_TELEGRAM_IDS;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Telegram conversation", () => {
  it("registers a nickname and shows the Russian player menu", async () => {
    const { app, store, messenger } = await harness();
    await app.handle(message(101, "/start"));
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(101, "Алексей"));

    expect(store.get().players[0]).toMatchObject({ nickname: "El_Tigre", realName: "Алексей", barrioId: null });
    expect(messenger.messages.at(-1)?.text).toContain("Регистрация завершена");
    const menuMarkup = messenger.messages.at(-1)?.replyMarkup as ReplyMarkup;
    expect(menuMarkup.keyboard.flat().map((item) => item.text)).toContain("📋 Misiones");
  });

  it("rejects duplicate nicknames regardless of case and spaces", async () => {
    const { app, store, messenger } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(202, "el_tigre"));

    expect(store.get().players).toHaveLength(1);
    expect(messenger.messages.at(-1)?.text).toContain("уже занят");
  });

  it("shows mission meeting date and time", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, messenger } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(999, "/missionadd intro | 2026-09-20T18:00:00+03:00 | La presentaciÃ³n | Habla con tres personas | Club"));
    await app.handle(message(999, "/missionvocab intro | Hola | Privet"));
    await app.handle(message(999, "/missionexample intro | Presentate a tres jugadores"));
    await app.handle(message(999, "/missionstart intro"));
    await app.handle(message(101, "/mission"));

    expect(messenger.messages.at(-1)?.text).toContain("Встреча:");
    expect(messenger.messages.at(-1)?.text).toContain("Время:");
    expect(messenger.messages.at(-1)?.text).toContain("📚 Словарь:");
    expect(messenger.messages.at(-1)?.text).toContain("💡 Что делать:");
  });

  it("shows the Spanish-Russian dictionary from the menu", async () => {
    const { app, messenger } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(101, "📚 Словарь"));

    const dictionary = messenger.messages.at(-1);
    expect(dictionary?.text).toContain("Diccionario LOS BARRIOS");
    const keyboard = dictionary?.replyMarkup as InlineKeyboardMarkup;
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe("vocab:basics");
    await app.handleCallback({ id: "callback-basics", from: { id: 101, first_name: "User 101" }, data: "vocab:basics", message: { chat: { id: 101, type: "private" } } });
    expect(messenger.messages.at(-1)?.text).toContain("¿Cuánto cuesta? — Сколько это стоит?");
    expect(messenger.messages.at(-1)?.text).toContain("¡Alto! — Стой!");
  });

  it("assigns and remembers one initial territory per barrio", async () => {
    const { app, store } = await harness();
    await app.handle(message(101, "/start"));

    const owners = Object.values(store.get().territories).filter(Boolean);
    expect(owners).toHaveLength(5);
    expect(new Set(owners)).toEqual(new Set(["nomadas", "navegantes", "lumieres", "fuegos", "panteras"]));
  });

  it("grants a new territory when a barrio wins", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store } = await harness();
    await app.handle(message(999, "/win nomadas"));

    expect(Object.values(store.get().territories).filter((owner) => owner === "nomadas")).toHaveLength(2);
  });

  it("removes a territory from a barrio", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store } = await harness();
    await app.handle(message(999, "/win nomadas"));
    expect(Object.values(store.get().territories).filter((owner) => owner === "nomadas")).toHaveLength(2);

    await app.handle(message(999, "/territoryremove nomadas"));
    expect(Object.values(store.get().territories).filter((owner) => owner === "nomadas")).toHaveLength(1);
  });

  it("stores the exact Telegram leader photo file and displays it", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store, messenger } = await harness();
    await app.handle(message(999, "/leaderphoto nomadas"));
    await app.handle({
      message_id: 2,
      from: { id: 999, first_name: "Admin" },
      chat: { id: 999, type: "private" },
      photo: [{ file_id: "original-telegram-file-id", width: 1024, height: 1024 }],
    });
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(999, "/leader nomadas | El_Tigre"));
    store.get().players[0].realName = "Алексей";
    await app.handle(message(101, "👤 Мой персонаж"));
    await app.handleCallback({ id: "callback-barrio-photo", from: { id: 101, first_name: "User 101" }, data: "character:barrio", message: { chat: { id: 101, type: "private" } } });

    expect(store.get().leaderPhotoFileIds.nomadas).toBe("original-telegram-file-id");
    expect(messenger.photos.at(-1)).toMatchObject({ photo: "original-telegram-file-id" });
    expect(messenger.photos.at(-1)?.caption).toContain("El_Tigre");
    expect(messenger.photos.at(-1)?.caption).toContain("[Алексей]");
  });

  it("stores the exact uploaded map file id", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store } = await harness();
    await app.handle(message(999, "/mapphoto"));
    await app.handle({
      message_id: 3,
      from: { id: 999, first_name: "Admin" },
      chat: { id: 999, type: "private" },
      photo: [{ file_id: "original-map-file-id", width: 1312, height: 1200 }],
    });

    expect(store.get().mapPhotoFileId).toBe("original-map-file-id");
  });

  it("lets an admin create, enrich, edit and activate missions", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store, messenger } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(999, "/missionadd intro | 2026-09-20T18:00:00+03:00 | Introducción | Habla con tres personas | Club"));
    await app.handle(message(999, "/missionvocab intro | ¿Cómo te llamas? | Как тебя зовут?"));
    await app.handle(message(999, "/missionexample intro | Познакомься с тремя игроками"));
    await app.handle(message(999, "/missionedit intro | 2026-09-20T19:00:00+03:00 | Introducción nueva | Habla con cuatro personas | Sala grande"));
    await app.handle(message(999, "/missionstart intro"));

    const mission = store.get().missions[0];
    expect(mission).toMatchObject({ id: "intro", status: "active", title: "Introducción nueva" });
    expect(mission.vocabulary).toHaveLength(1);
    expect(mission.examples).toHaveLength(1);
    expect(messenger.messages.some((entry) => entry.chatId === 101 && entry.text.includes("Началась новая misión"))).toBe(true);
  });

  it("shows the active mission from the player menu", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, messenger } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(999, "/missionadd intro | 2026-09-20T18:00:00+03:00 | Introducción | Primera misión | Club"));
    await app.handle(message(999, "/missionadd final | 2026-09-20T21:00:00+03:00 | La Final | Última misión | Plaza"));
      await app.handle(message(999, "/missionstart intro"));
      await app.handle(message(101, "📋 Misiones"));

    const response = messenger.messages.at(-1);
      expect(response?.text).not.toContain("La Final");
      expect(response?.text).toContain("Introducción");
      expect(response?.text).toContain("20 сентября 2026 г.");
    const missionMarkup = response?.replyMarkup as InlineKeyboardMarkup;
    expect(missionMarkup.inline_keyboard.flat().map((item) => item.text)).toContain("➕ Записаться: Introducción");
    expect(missionMarkup.inline_keyboard.flat().map((item) => item.text)).toContain("ℹ️ Полная информация");

    await app.handleCallback({
      id: "callback-info",
      from: { id: 101, first_name: "User 101" },
      data: "mission_info:intro",
      message: { chat: { id: 101, type: "private" } },
    });
    expect(messenger.messages.at(-1)?.text).toContain("Primera misión");
  });

  it("lets a player subscribe to a mission with an inline button", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store, messenger } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(999, `/missionadd intro | ${new Date(Date.now() + 60_000).toISOString()} | Introducción | Primera misión | Club`));
    await app.handle(message(999, "/missionstart intro"));
    await app.handle(message(101, "/missions"));

    const keyboard = messenger.messages.at(-1)?.replyMarkup as InlineKeyboardMarkup;
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe("mission_join:intro");

    await app.handleCallback({ id: "callback-1", from: { id: 101, first_name: "User 101" }, data: "mission_join:intro", message: { chat: { id: 101, type: "private" } } });
    expect(store.get().missions[0].participantIds).toContain(101);
    expect(store.get().missions[0].barrioAssignments["101"]).toBeDefined();

    await app.handleCallback({ id: "callback-2", from: { id: 101, first_name: "User 101" }, data: "mission_leave:intro", message: { chat: { id: 101, type: "private" } } });
    expect(store.get().missions[0].participantIds).not.toContain(101);
    expect(store.get().missions[0].barrioAssignments["101"]).toBeUndefined();
  });

  it("opens vocabulary for a selected mission", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store, messenger } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(999, "/missionadd intro | 2026-09-20T18:00:00+03:00 | Introducción | Primera misión | Club"));
    await app.handle(message(999, "/missionvocab intro | Hola | Привет"));
    store.get().missions[0].phrases = [{ text: "¿Qué sabes?", translation: "Что ты знаешь?", notes: "Ask for information" }];
    await app.handle(message(101, "/dictionary"));

    const keyboard = messenger.messages.at(-1)?.replyMarkup as InlineKeyboardMarkup;
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe("vocab:basics");
    expect(keyboard.inline_keyboard[1][0].callback_data).toBe("vocab:intro");
    await app.handleCallback({ id: "callback-vocab", from: { id: 101, first_name: "User 101" }, data: "vocab:intro", message: { chat: { id: 101, type: "private" } } });
    const missionKeyboard = messenger.messages.at(-1)?.replyMarkup as InlineKeyboardMarkup;
    expect(missionKeyboard.inline_keyboard[0].map((item) => item.callback_data)).toEqual(["vocab_words:intro", "vocab_phrases:intro"]);
    await app.handleCallback({ id: "callback-words", from: { id: 101, first_name: "User 101" }, data: "vocab_words:intro", message: { chat: { id: 101, type: "private" } } });
    expect(messenger.messages.at(-1)?.text).toContain("Hola — Привет");
    await app.handleCallback({ id: "callback-phrases", from: { id: 101, first_name: "User 101" }, data: "vocab_phrases:intro", message: { chat: { id: 101, type: "private" } } });
    expect(messenger.messages.at(-1)?.text).toContain("¿Qué sabes?");
  });

  it("lets an admin set a mission date and time", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store, messenger } = await harness();
    await app.handle(message(999, "/missionadd intro | 2026-09-20T18:00:00+03:00 | Introducción | Primera misión | Club"));
    await app.handle(message(999, "/missiontime intro | 2026-10-03 | 19:45"));

    expect(store.get().missions[0].meetingAt).toBe("2026-10-03T19:45:00+03:00");
    expect(messenger.messages.at(-1)?.text).toContain("19:45");
  });

  it("assigns different balanced barrios for each mission's attendees", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(202, "La_Rosa"));
    await app.handle(message(303, "El_Sol"));
    const meetingAt = new Date(Date.now() + 60_000).toISOString();
    await app.handle(message(999, `/missionadd day1 | ${meetingAt} | Día uno | Primera misión | Club`));
    await app.handle(message(999, `/missionadd day2 | ${meetingAt} | Día dos | Segunda misión | Club`));

    for (const id of [101, 202, 303]) await app.handle(message(id, "/missionjoin day1"));
    for (const id of [101, 202, 303]) await app.handle(message(id, "/missionjoin day2"));

    const [day1, day2] = store.get().missions;
    expect(day1.participantIds).toEqual([101, 202, 303]);
    expect(new Set(Object.values(day1.barrioAssignments))).toHaveLength(3);
    expect(new Set(Object.values(day2.barrioAssignments))).toHaveLength(3);
    for (const id of [101, 202, 303]) {
      expect(day2.barrioAssignments[String(id)]).not.toBe(day1.barrioAssignments[String(id)]);
    }
  });

  it("lets an admin appoint a player as a barrio leader", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store, messenger } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(999, "/leader nomadas | El_Tigre"));
    await app.handle(message(999, `/missionadd intro | ${new Date(Date.now() + 60_000).toISOString()} | Introducción | Primera misión | Club`));
    await app.handle(message(101, "/missionjoin intro"));
    await app.handle(message(999, "/assign intro | El_Tigre | nomadas"));
    await app.handle(message(999, "/missionstart intro"));
    await app.handle(message(101, "👤 Мой персонаж"));
    await app.handleCallback({ id: "callback-barrio-leader", from: { id: 101, first_name: "User 101" }, data: "character:barrio", message: { chat: { id: 101, type: "private" } } });

    expect(store.get().barrioLeaderIds.nomadas).toBe(101);
    expect(store.get().missions[0].barrioAssignments["101"]).toBe("nomadas");
    expect(messenger.messages.at(-1)?.text).toContain("Лидер barrio: <b>El_Tigre</b>");
  });

  it("requires code 0000 to delete a character and removes its references", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store, messenger } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(999, "/leader nomadas | El_Tigre"));
    await app.handle(message(999, "/missionadd intro | 2026-09-20T18:00:00+03:00 | Introducción | Primera misión | Club"));
    await app.handle(message(101, "/missionjoin intro"));

    await app.handle(message(101, "⚙️ Настройки"));
    await app.handleCallback({ id: "callback-reset", from: { id: 101, first_name: "User 101" }, data: "settings:reset", message: { chat: { id: 101, type: "private" } } });
    await app.handle(message(101, "1234"));
    expect(store.get().players).toHaveLength(1);
    expect(messenger.messages.at(-1)?.text).toContain("Неверный код");

    await app.handle(message(101, "0000"));
    expect(store.get().players).toHaveLength(0);
    expect(store.get().missions[0].participantIds).not.toContain(101);
    expect(store.get().missions[0].barrioAssignments["101"]).toBeUndefined();
    expect(store.get().barrioLeaderIds.nomadas).toBeUndefined();
    expect(messenger.messages.at(-1)?.text).toContain("Персонаж удалён");

    await app.handle(message(101, "/start"));
    await app.handle(message(101, "El_Nuevo"));
    await app.handle(message(101, "Новый игрок"));
    expect(store.get().players[0]?.nickname).toBe("El_Nuevo");
  });

  it("lets an admin create, edit and delete Mercado objects", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store } = await harness();
    await app.handle(message(999, "/shopadd llave | Llave | 300 | 5 | Открывает дверь"));
    expect(store.get().market[0]).toMatchObject({ id: "llave", price: 300, stock: 5 });
    await app.handle(message(999, "/shopedit llave | Llave dorada | 450 | all | Открывает тайную дверь"));
    expect(store.get().market[0]).toMatchObject({ name: "Llave dorada", price: 450, stock: null });
    await app.handle(message(999, "/shopdelete llave"));
    expect(store.get().market).toHaveLength(0);
  });

  it("creates and starts a targeted La Rata event", async () => {
    process.env.ADMIN_TELEGRAM_IDS = "999";
    const { app, store, messenger } = await harness();
    await app.handle(message(101, "El_Tigre"));
    await app.handle(message(202, "La_Rosa"));
    await app.handle(message(999, "/eventpreset rata | El_Tigre"));
    const event = store.get().events[0];
    await app.handle(message(999, `/eventstart ${event.id}`));

    expect(event).toMatchObject({ type: "la_rata", target: "El_Tigre", status: "active" });
    expect(messenger.messages.some((entry) => entry.chatId === 101 && entry.text.includes("La Rata"))).toBe(true);
    expect(messenger.messages.some((entry) => entry.chatId === 202 && entry.text.includes("La Rata"))).toBe(false);
  });
});
