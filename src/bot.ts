import { setDefaultResultOrder } from "node:dns";
import { BotApp } from "./app";
import { startDashboard } from "./dashboard";
import { JsonStore } from "./store";
import { TelegramApiError, TelegramClient, type TelegramUser } from "./telegram";

// Some VPS networks advertise an unreliable IPv6 route to Telegram.
// Prefer IPv4 while retaining IPv6 as a fallback.
setDefaultResultOrder("ipv4first");

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing. Copy .env.example to .env and add a fresh BotFather token.");
if (!(process.env.ADMIN_TELEGRAM_IDS ?? "").trim()) {
  console.warn("ADMIN_TELEGRAM_IDS is empty. Send /myid, add that numeric ID to .env, and restart before uploading leader photos.");
}

let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(failures: number): number {
  return Math.min(30_000, 2_000 * (2 ** Math.min(failures - 1, 4)));
}

function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${error.message} (${detail})` : error.message;
}

function isFatalTelegramError(error: unknown): boolean {
  return error instanceof TelegramApiError && error.errorCode !== 429 && (error.errorCode ?? 0) < 500;
}

const store = new JsonStore(process.env.BOT_DATA_FILE ?? "./data/game-state.json");
await store.load();
const telegram = new TelegramClient(token);
const app = new BotApp(store, telegram);
startDashboard(store, telegram);

let me: TelegramUser | undefined;
let startupFailures = 0;
while (!stopping && !me) {
  try {
    me = await telegram.getMe();
    await telegram.deleteWebhook();
    await telegram.setCommands();
  } catch (error) {
    if (isFatalTelegramError(error)) throw error;
    startupFailures += 1;
    const wait = retryDelay(startupFailures);
    console.error(`Telegram is unreachable: ${errorSummary(error)}. Retrying in ${wait / 1000}s…`);
    await delay(wait);
  }
}

if (!me) {
  console.log("LOS BARRIOS stopped before connecting.");
  process.exit(0);
}

console.log(`LOS BARRIOS started as @${me.username ?? me.first_name}. Press Ctrl+C to stop.`);

let offset = 0;
let pollingFailures = 0;
while (!stopping) {
  try {
    const updates = await telegram.getUpdates(offset);
    pollingFailures = 0;
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      if (update.message) {
        try {
          await app.handle(update.message);
        } catch (error) {
          console.error(`Update ${update.update_id} failed: ${errorSummary(error)}`);
          try {
            await telegram.sendMessage(update.message.chat.id, "Произошла ошибка. Попробуйте ещё раз или сообщите организатору.");
          } catch (sendError) {
            console.error(`Could not send the error notice: ${errorSummary(sendError)}`);
          }
        }
      }
      if (update.callback_query) {
        try {
          await app.handleCallback(update.callback_query);
        } catch (error) {
          console.error(`Callback ${update.callback_query.id} failed: ${errorSummary(error)}`);
        }
      }
    }
  } catch (error) {
    if (error instanceof TelegramApiError && error.errorCode === 409) {
      console.error("Another @LosBarriosBot instance is already running. Stop it with Ctrl+C before starting this one.");
      stopping = true;
      process.exitCode = 1;
      continue;
    }
    if (isFatalTelegramError(error)) {
      console.error(`Telegram rejected the request: ${errorSummary(error)}`);
      stopping = true;
      process.exitCode = 1;
      continue;
    }
    pollingFailures += 1;
    const wait = retryDelay(pollingFailures);
    console.error(`Telegram connection lost: ${errorSummary(error)}. Retrying in ${wait / 1000}s…`);
    await delay(wait);
  }
}

console.log("LOS BARRIOS stopped.");
