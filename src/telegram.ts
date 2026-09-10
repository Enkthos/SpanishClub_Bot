export type TelegramUser = {
  id: number;
  first_name: string;
  username?: string;
};

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
  photo?: { file_id: string; width: number; height: number; file_size?: number }[];
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type ApiResponse<T> = { ok: boolean; result: T; description?: string; error_code?: number };

export class TelegramApiError extends Error {
  constructor(readonly errorCode: number | undefined, message: string) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export type ReplyMarkup = {
  keyboard: { text: string }[][];
  resize_keyboard: true;
};

export interface Messenger {
  sendMessage(chatId: number, text: string, replyMarkup?: ReplyMarkup): Promise<void>;
  sendPhoto(chatId: number, photo: string | Uint8Array, caption: string): Promise<void>;
  downloadFile(fileId: string): Promise<Uint8Array>;
}

export class TelegramClient implements Messenger {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    const payload = (await response.json()) as ApiResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new TelegramApiError(payload.error_code ?? response.status, payload.description ?? `Telegram ${method} failed`);
    }
    return payload.result;
  }

  async getMe(): Promise<TelegramUser> {
    return this.call("getMe", {});
  }

  async deleteWebhook(): Promise<void> {
    await this.call("deleteWebhook", { drop_pending_updates: false });
  }

  async setCommands(): Promise<void> {
    await this.call("setMyCommands", {
      commands: [
        { command: "start", description: "Регистрация и главное меню" },
        { command: "profile", description: "Мой персонаж" },
        { command: "mission", description: "Текущая misión" },
        { command: "missions", description: "Все доступные misiones" },
        { command: "missionjoin", description: "Записаться на misión" },
        { command: "missionleave", description: "Отменить участие в misión" },
        { command: "events", description: "Активные игровые события" },
        { command: "dictionary", description: "Испанско-русский словарь" },
        { command: "ranking", description: "Рейтинг Respeto" },
        { command: "map", description: "Карта территорий" },
        { command: "market", description: "Mercado" },
        { command: "myid", description: "Мой Telegram ID" },
        { command: "help", description: "Помощь" },
      ],
    });
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", {
      offset,
      timeout: 30,
      allowed_updates: ["message"],
    });
  }

  async sendMessage(chatId: number, text: string, replyMarkup?: ReplyMarkup): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async sendPhoto(chatId: number, photo: string | Uint8Array, caption: string): Promise<void> {
    if (typeof photo !== "string") {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
      const bytes = new Uint8Array(photo);
      form.append("photo", new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" }), "territories.png");
      const response = await fetch(`${this.baseUrl}/sendPhoto`, { method: "POST", body: form });
      const payload = (await response.json()) as ApiResponse<unknown>;
      if (!response.ok || !payload.ok) throw new Error(payload.description ?? "Telegram sendPhoto failed");
      return;
    }
    await this.call("sendPhoto", {
      chat_id: chatId,
      photo,
      caption,
      parse_mode: "HTML",
    });
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram did not return a file path");
    const response = await fetch(`${this.baseUrl.replace("/bot", "/file/bot")}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
