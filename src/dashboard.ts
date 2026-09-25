import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gameConfig } from "./config";
import { JsonStore, nicknameKey, type GameEvent, type Player } from "./store";
import type { Messenger } from "./telegram";

const html = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const nav = `<nav><a href="/">Overview</a><a href="/users">Users</a><a href="/barrios">Barrios</a><a href="/information">Information</a><a href="/missions">Missions</a><a href="/vocabulary">Vocabulary</a><a href="/events">Events</a><a href="/ratings">Ratings</a><a href="/territories">Territories</a><a href="/market">Market</a><a href="/penalties">Penalties</a><a href="/notify">Messages</a></nav>`;

const TERRITORIES = [
  "El Corona", "La Vista", "Los Olvidados", "Santa Fortuna", "Pueblo Viejo",
  "Monte Claro", "Cerro Rojo", "Río Sur", "Las Palmas", "Del Valle",
  "East Heights", "Bahía Flats", "Los Jardines", "Tierra Nueva", "Puerto Sol",
];

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)} - LOS BARRIOS</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 16px;background:#10151d;color:#edf2f7}a{color:#8dd7ff;margin-right:16px}nav{padding:14px 0;border-bottom:1px solid #334155;margin-bottom:22px}section,form{background:#18212d;padding:16px;margin:14px 0;border-radius:8px}input,textarea,select,button{font:inherit;padding:8px;margin:4px;max-width:100%;box-sizing:border-box}input,textarea,select{background:#fff;color:#111}textarea{width:100%;min-height:76px}button{cursor:pointer}.ok{color:#86efac}.warn{color:#fcd34d}table{width:100%;border-collapse:collapse}td,th{padding:8px;text-align:left;border-bottom:1px solid #334155}.inline-form{background:transparent;padding:0;margin:12px 0 0}</style><h1>LOS BARRIOS - ${html(title)}</h1>${nav}${body}`;
}

async function body(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

function authorized(request: IncomingMessage, password: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith("Basic ")) return false;
  const received = Buffer.from(value.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
  const a = Buffer.from(received);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

function redirect(response: ServerResponse, destination: string): void {
  response.writeHead(303, { location: destination });
  response.end();
}

function findPlayer(players: Player[], nickname: string): Player | undefined {
  return players.find((player) => player.nicknameKey === nicknameKey(nickname));
}

function textInput(name: string, value: string, placeholder: string, required = true): string {
  return `<input name="${html(name)}" value="${html(value)}" placeholder="${html(placeholder)}"${required ? " required" : ""}>`;
}

function textareaInput(name: string, value: string, placeholder: string, required = true): string {
  return `<textarea name="${html(name)}" placeholder="${html(placeholder)}"${required ? " required" : ""}>${html(value)}</textarea>`;
}

function barrioOptions(): string {
  return gameConfig.barrios.map((item) => `<option value="${html(item.id)}">${html(item.name)}</option>`).join("");
}

function datetimeLocal(value: string): string {
  return value.replace(/Z$/, "").slice(0, 16);
}

function missionDateTime(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

export function startDashboard(store: JsonStore, messenger: Messenger): void {
  if (process.env.DASHBOARD_ENABLED?.toLowerCase() === "false") return;
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) {
    console.log("Dashboard disabled: set DASHBOARD_PASSWORD to enable it.");
    return;
  }
  const host = process.env.DASHBOARD_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.DASHBOARD_PORT ?? 3100);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("DASHBOARD_PORT must be a valid TCP port.");

  createServer(async (request, response) => {
    if (!authorized(request, password)) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="LOS BARRIOS"' });
      response.end("Authentication required");
      return;
    }

    const url = new URL(request.url ?? "/", "http://dashboard.local");
    const state = store.get();

    try {
      if (request.method === "POST") {
        const form = await body(request);

        if (url.pathname === "/users/update") {
          const player = findPlayer(state.players, form.nickname ?? "");
          if (player) await store.update(() => {
            player.dinero = Math.max(0, Number(form.dinero) || 0);
            player.respeto = Number(form.respeto) || 0;
            player.wantedLevel = Math.max(0, Math.min(3, Number(form.wanted) || 0));
            player.role = form.role === "police" ? "police" : "player";
            player.realName = form.realName?.trim() || undefined;
          });
          return redirect(response, "/users");
        }

        if (url.pathname === "/information/save") {
          await store.update((next) => {
            next.botInformation = (form.information ?? "").trim();
            next.botRules = (form.rules ?? "").trim();
          });
          return redirect(response, "/information");
        }

        if (url.pathname === "/barrios/save") {
          const barrioId = form.barrioId ?? "";
          const leaderId = Number(form.leaderId);
          const characterName = (form.characterName ?? "").trim();
          if (gameConfig.barrios.some((item) => item.id === barrioId) && characterName) await store.update((next) => {
            if (form.leaderId === "") delete next.barrioLeaderIds[barrioId];
            else if (Number.isSafeInteger(leaderId) && next.players.some((player) => player.telegramId === leaderId && player.role === "player")) next.barrioLeaderIds[barrioId] = leaderId;
            next.barrioCharacterNames[barrioId] = characterName;
          });
          return redirect(response, "/barrios");
        }

        if (url.pathname === "/missions/current") {
          const mission = state.missions.find((item) => item.id === form.missionId);
          if (mission) await store.update((next) => {
            for (const item of next.missions) {
              if (item.id === mission.id) item.status = "active";
              else if (item.status === "active") item.status = "draft";
            }
            next.activeMissionId = mission.id;
          });
          return redirect(response, "/missions");
        }

        if (url.pathname === "/missions/assign") {
          const mission = state.missions.find((item) => item.id === form.missionId);
          const player = findPlayer(state.players, form.nickname ?? "");
          if (mission && player && mission.participantIds.includes(player.telegramId) && gameConfig.barrios.some((item) => item.id === form.barrioId)) {
            await store.update(() => {
              mission.barrioAssignments[String(player.telegramId)] = form.barrioId;
            });
          }
          return redirect(response, "/missions");
        }

        if (url.pathname === "/missions/save") {
          const id = (form.id ?? "").trim();
          const meetingAt = missionDateTime(form.meetingAt);
          if (id && form.title?.trim() && form.description?.trim() && meetingAt) await store.update((next) => {
            const existing = next.missions.find((item) => item.id === id);
            const base = { id, title: form.title.trim(), description: form.description.trim(), meetingAt, location: form.location?.trim() || undefined };
            if (existing) Object.assign(existing, base);
            else next.missions.push({ ...base, status: "draft", participantIds: [], barrioAssignments: {}, participantRegisteredAt: {}, vocabulary: [], phrases: [], examples: [] });
          });
          return redirect(response, "/missions");
        }

        if (url.pathname === "/missions/vocabulary") {
          const mission = state.missions.find((item) => item.id === form.missionId);
          const spanish = (form.spanish ?? "").trim();
          const russian = (form.russian ?? "").trim();
          const index = form.index === undefined || form.index === "" ? -1 : Number(form.index);
          if (mission && spanish && russian && Number.isInteger(index)) await store.update(() => {
            const entry = { spanish, russian };
            if (index >= 0 && index < (mission.vocabulary ?? []).length) mission.vocabulary![index] = entry;
            else if (index < 0) (mission.vocabulary ??= []).push(entry);
          });
          return redirect(response, "/missions");
        }

        if (url.pathname === "/missions/phrases") {
          const mission = state.missions.find((item) => item.id === form.missionId);
          const text = (form.text ?? "").trim();
          const translation = (form.translation ?? "").trim();
          const notes = (form.notes ?? "").trim();
          const index = form.index === undefined || form.index === "" ? -1 : Number(form.index);
          if (mission && text && Number.isInteger(index)) await store.update(() => {
            const phrase = { text, ...(translation ? { translation } : {}), ...(notes ? { notes } : {}) };
            if (index >= 0 && index < (mission.phrases ?? []).length) mission.phrases![index] = phrase;
            else if (index < 0) (mission.phrases ??= []).push(phrase);
          });
          return redirect(response, "/vocabulary");
        }

        if (url.pathname === "/events/save") {
          const id = (form.id ?? "").trim();
          const type: GameEvent["type"] = form.type === "la_rata" || form.type === "robo" || form.type === "guerra" ? form.type : "custom";
          if (id && form.title?.trim() && form.description?.trim() && form.target?.trim()) await store.update((next) => {
            const existing = next.events.find((item) => item.id === id);
            const values = { id, type, title: form.title.trim(), description: form.description.trim(), target: form.target.trim() };
            if (existing) Object.assign(existing, values);
            else next.events.push({ ...values, status: "draft", createdAt: new Date().toISOString() });
          });
          return redirect(response, "/events");
        }

        if (url.pathname === "/events/status") {
          const event = state.events.find((item) => item.id === form.id);
          const status = form.status === "active" || form.status === "completed" ? form.status : "draft";
          if (event) await store.update(() => { event.status = status; });
          return redirect(response, "/events");
        }

        if (url.pathname === "/territories/save") {
          const zone = Number(form.zone);
          const owner = form.owner === "neutral" ? null : form.owner;
          if (Number.isInteger(zone) && zone >= 1 && zone <= TERRITORIES.length && (owner === null || gameConfig.barrios.some((item) => item.id === owner))) {
            await store.update((next) => { next.territories[String(zone)] = owner; });
          }
          return redirect(response, "/territories");
        }

        if (url.pathname === "/market/save") {
          const id = (form.id ?? "").trim();
          const price = Number(form.price);
          const stock = form.stock === "all" ? null : Number(form.stock);
          if (id && form.name?.trim() && form.description?.trim() && Number.isSafeInteger(price) && price >= 0 && (stock === null || (Number.isSafeInteger(stock) && stock >= 0))) await store.update((next) => {
            const item = next.market.find((entry) => entry.id === id);
            const values = { id, name: form.name.trim(), description: form.description.trim(), price, stock };
            if (item) Object.assign(item, values); else next.market.push(values);
          });
          return redirect(response, "/market");
        }

        if (url.pathname === "/penalties/save") {
          const id = (form.id ?? "").trim();
          if (id && form.name?.trim() && form.description?.trim()) await store.update((next) => {
            const item = next.penaltyCatalog.find((entry) => entry.id === id);
            if (item) Object.assign(item, { name: form.name.trim(), description: form.description.trim() });
            else next.penaltyCatalog.push({ id, name: form.name.trim(), description: form.description.trim() });
          });
          return redirect(response, "/penalties");
        }

        if (url.pathname === "/penalties/apply") {
          const penalty = state.penaltyCatalog.find((item) => item.id === form.penaltyId);
          const player = findPlayer(state.players, form.nickname ?? "");
          if (penalty && player) await store.update(() => { player.penalties.push(`${penalty.name}: ${penalty.description}`); });
          if (penalty && player) await messenger.sendMessage(player.chatId, `🚨 Новая Penitencia: <b>${html(penalty.name)}</b>\n${html(penalty.description)}`);
          return redirect(response, "/penalties");
        }

        if (url.pathname === "/notify/send") {
          const text = (form.text ?? "").trim();
          const target = form.target ?? "mission";
          const active = state.missions.find((item) => item.id === state.activeMissionId);
          const recipients = target === "user" ? [findPlayer(state.players, form.targetId ?? "")].filter((item): item is Player => Boolean(item))
            : target === "barrio" && active ? active.participantIds.map((id) => state.players.find((item) => item.telegramId === id)).filter((item): item is Player => Boolean(item) && active.barrioAssignments[String(item!.telegramId)] === form.targetId)
            : active ? active.participantIds.map((id) => state.players.find((item) => item.telegramId === id)).filter((item): item is Player => Boolean(item)) : [];
          let sentCount = 0;
          for (const player of recipients) { await messenger.sendMessage(player.chatId, `📣 <b>LOS BARRIOS</b>\n${html(text)}`); sentCount += 1; }
          if (text) await store.update((next) => { next.notifications.unshift({ id: `${Date.now()}`, createdAt: new Date().toISOString(), target: target === "user" ? "user" : target === "barrio" ? "barrio" : "mission", targetId: form.targetId ?? active?.id ?? "", text, sentCount }); next.notifications.splice(250); });
          return redirect(response, "/notify");
        }
      }

      if (url.pathname === "/") {
        const active = state.missions.find((item) => item.id === state.activeMissionId);
        response.end(page("Overview", `<section><b class="ok">Dashboard is online</b><p>Players: ${state.players.length} - Missions: ${state.missions.length} - Market items: ${state.market.length}</p><p>Active misión: ${active ? html(active.title) : "none"}</p><p>Data file: <code>${html(store.path)}</code></p><p>Bound to ${html(host)}:${port}. Keep it reachable through an SSH tunnel.</p></section>`));
      } else if (url.pathname === "/users") {
        const rows = state.players.map((player) => `<tr><td>${html(player.nickname)}</td><td>${html(player.realName ?? "")}</td><td>${player.role}</td><td>${player.dinero}</td><td>${player.respeto}</td><td>${player.wantedLevel}</td><td>${html(player.penalties.join("; "))}</td></tr>`).join("");
        response.end(page("Users", `<table><tr><th>Nickname</th><th>Real name</th><th>Role</th><th>Dinero</th><th>Respeto</th><th>Wanted</th><th>Penalties</th></tr>${rows}</table><form method="post" action="/users/update"><h2>Edit user</h2><input name="nickname" placeholder="Nickname" required><input name="realName" placeholder="Real name"><input name="dinero" type="number" placeholder="Dinero" required><input name="respeto" type="number" placeholder="Respeto" required><input name="wanted" type="number" min="0" max="3" placeholder="Wanted" required><select name="role"><option value="player">Player</option><option value="police">Police</option></select><button>Save</button></form>`));
      } else if (url.pathname === "/information") {
        response.end(page("Information", `<form method="post" action="/information/save"><h2>Bot information</h2>${textareaInput("information", state.botInformation ?? "", "Description shown in the bot. Leave blank to use the default.", false)}<h2>Rules</h2>${textareaInput("rules", state.botRules ?? "", "Rules shown in the bot. Leave blank to use the default.", false)}<button>Save information</button></form>`));
      } else if (url.pathname === "/barrios") {
        const playerOptions = state.players.filter((player) => player.role === "player").map((player) => `<option value="${player.telegramId}">${html(player.nickname)}</option>`).join("");
        const cards = gameConfig.barrios.map((barrio) => {
          const leader = state.players.find((player) => player.telegramId === state.barrioLeaderIds[barrio.id]);
          const characterName = state.barrioCharacterNames[barrio.id] ?? barrio.leader.name;
          return `<section><h2>${html(barrio.emoji)} ${html(barrio.name)}</h2><p>${html(barrio.slogan)}</p><p>Current leader: ${html(leader?.nickname ?? "none")}<br>Character: ${html(characterName)}</p><form method="post" action="/barrios/save"><input type="hidden" name="barrioId" value="${html(barrio.id)}"><label>Leader <select name="leaderId"><option value="">No leader</option>${playerOptions.replace(`value="${leader?.telegramId}">`, `value="${leader?.telegramId}" selected>` )}</select></label>${textInput("characterName", characterName, "Character name")}<button>Save barrio</button></form></section>`;
        }).join("");
        response.end(page("Barrios", cards));
      } else if (url.pathname === "/missions") {
        const cards = state.missions.map((mission) => {
          const participants = mission.participantIds.map((id) => {
            const player = state.players.find((item) => item.telegramId === id);
            if (!player) return "";
            const registeredAt = mission.participantRegisteredAt[String(id)] ?? "";
            return `<tr><td>${html(player.nickname)}</td><td>${html(registeredAt ? new Date(registeredAt).toLocaleString() : "" )}</td><td>${html(mission.barrioAssignments[String(id)] ?? "unassigned")}</td></tr>`;
          }).filter(Boolean).join("");
          const currentForm = mission.id === state.activeMissionId
            ? `<p class="ok">Current misión</p>`
            : `<form class="inline-form" method="post" action="/missions/current"><input type="hidden" name="missionId" value="${html(mission.id)}"><button>Set current</button></form>`;
          return `<section><h2>${html(mission.title)}</h2><p>${html(mission.status)} · ${html(mission.meetingAt)} · Registered: ${mission.participantIds.length}</p>${currentForm}<h3>Subscribed users</h3>${participants ? `<table><tr><th>Nickname</th><th>Subscribed</th><th>Barrio</th></tr>${participants}</table>` : "<p>No subscribers yet.</p>"}<p><a href="/vocabulary">Edit vocabulary for this mission</a></p><form class="inline-form" method="post" action="/missions/save"><h3>Edit misión</h3>${textInput("id", mission.id, "Mission ID")}${textInput("title", mission.title, "Title")}${`<input type="datetime-local" name="meetingAt" value="${html(datetimeLocal(mission.meetingAt))}" required>`}${textInput("location", mission.location ?? "", "Location", false)}${textareaInput("description", mission.description, "Description")}<button>Save changes</button></form></section>`;
        }).join("");
        const options = state.missions.map((item) => `<option value="${html(item.id)}">${html(item.title)}</option>`).join("");
        response.end(page("Missions", `${cards || "<section>No saved missions yet. Create one here, then press Set current.</section>"}<form method="post" action="/missions/save"><h2>Create misión</h2><input name="id" placeholder="Mission ID" required><input name="title" placeholder="Title" required><input type="datetime-local" name="meetingAt" required><input name="location" placeholder="Location"><textarea name="description" placeholder="Description" required></textarea><button>Create</button></form><form method="post" action="/missions/current"><h2>Choose current misión</h2><select name="missionId">${options}</select><button>Set current</button></form><form method="post" action="/missions/assign"><h2>Manual team assignment</h2><select name="missionId">${options}</select><input name="nickname" placeholder="Subscribed nickname" required><select name="barrioId">${barrioOptions()}</select><button>Assign</button></form>`));
      } else if (url.pathname === "/vocabulary") {
        const sections = state.missions.map((mission) => {
          const words = (mission.vocabulary ?? []).map((entry, index) => `<form class="inline-form" method="post" action="/missions/vocabulary"><input type="hidden" name="missionId" value="${html(mission.id)}"><input type="hidden" name="index" value="${index}">${textInput("spanish", entry.spanish, "Spanish")}${textInput("russian", entry.russian, "Russian")}<button>Save word</button></form>`).join("");
          const phrases = (mission.phrases ?? []).map((phrase, index) => `<form class="inline-form" method="post" action="/missions/phrases"><input type="hidden" name="missionId" value="${html(mission.id)}"><input type="hidden" name="index" value="${index}">${textareaInput("text", phrase.text, "Phrase or text")}${textInput("translation", phrase.translation ?? "", "Translation", false)}${textInput("notes", phrase.notes ?? "", "Notes or specification", false)}<button>Save phrase</button></form>`).join("");
          return `<section><h2>${html(mission.title)}</h2><p><code>${html(mission.id)}</code></p><h3>Words</h3>${words || "<p>No words yet.</p>"}<form class="inline-form" method="post" action="/missions/vocabulary"><input type="hidden" name="missionId" value="${html(mission.id)}">${textInput("spanish", "", "Spanish")}${textInput("russian", "", "Russian")}<button>Add word</button></form><h3>Phrases and text</h3>${phrases || "<p>No phrases yet.</p>"}<form class="inline-form" method="post" action="/missions/phrases"><input type="hidden" name="missionId" value="${html(mission.id)}">${textareaInput("text", "", "Phrase or text")}${textInput("translation", "", "Translation", false)}${textInput("notes", "", "Notes or specification", false)}<button>Add phrase</button></form></section>`;
        }).join("");
        response.end(page("Vocabulary", `${sections || "<section>No saved missions yet.</section>"}`));
      } else if (url.pathname === "/events") {
        const events = state.events.map((event) => `<section><h2>${html(event.title)}</h2><p>${html(event.status)} · ${html(event.type)} · target: ${html(event.target)}</p><p>${html(event.description)}</p><form class="inline-form" method="post" action="/events/save">${textInput("id", event.id, "Event ID")}${textInput("title", event.title, "Title")}${textInput("target", event.target, "Target: all, police, barrio ID or nickname")}${textareaInput("description", event.description, "Description")}<select name="type"><option value="custom">custom</option><option value="la_rata">la_rata</option><option value="robo">robo</option><option value="guerra">guerra</option></select><button>Save event</button></form><form class="inline-form" method="post" action="/events/status"><input type="hidden" name="id" value="${html(event.id)}"><select name="status"><option value="draft">draft</option><option value="active">active</option><option value="completed">completed</option></select><button>Change status</button></form></section>`).join("");
        response.end(page("Events", `${events || "<section>No events yet.</section>"}<form method="post" action="/events/save"><h2>Add event</h2>${textInput("id", "", "Event ID")}${textInput("title", "", "Title")}${textInput("target", "all", "Target: all, police, barrio ID or nickname")}${textareaInput("description", "", "Description")}<select name="type"><option value="custom">custom</option><option value="la_rata">la_rata</option><option value="robo">robo</option><option value="guerra">guerra</option></select><button>Add event</button></form>`));
      } else if (url.pathname === "/ratings") {
        const active = state.missions.find((item) => item.id === state.activeMissionId);
        const players = [...state.players].filter((player) => player.role === "player").sort((a, b) => b.respeto - a.respeto || a.nickname.localeCompare(b.nickname));
        const playerBarrio = (player: Player) => active?.barrioAssignments[String(player.telegramId)] ?? player.barrioId;
        const rows = players.map((player, index) => `<tr><td>${index + 1}</td><td>${html(player.nickname)}</td><td>${html(playerBarrio(player) ?? "unassigned")}</td><td>${player.respeto}</td><td>${player.dinero}</td></tr>`).join("");
        const barrioRows = gameConfig.barrios.map((barrio) => { const members = players.filter((player) => playerBarrio(player) === barrio.id); return `<tr><td>${html(barrio.name)}</td><td>${members.length}</td><td>${members.reduce((total, player) => total + player.respeto, 0)}</td><td>${members.length ? Math.round(members.reduce((total, player) => total + player.respeto, 0) / members.length) : 0}</td></tr>`; }).join("");
        response.end(page("Ratings", `<section><h2>General rating</h2><table><tr><th>#</th><th>Nickname</th><th>Barrio</th><th>Respeto</th><th>Dinero</th></tr>${rows || '<tr><td colspan="5">No players yet.</td></tr>'}</table></section><section><h2>Rating by barrio</h2><table><tr><th>Barrio</th><th>Players</th><th>Total respeto</th><th>Average respeto</th></tr>${barrioRows}</table></section>`));
      } else if (url.pathname === "/territories") {
        const rows = TERRITORIES.map((name, index) => { const zone = String(index + 1); const owner = state.territories[zone] ?? "neutral"; return `<tr><td>${index + 1}</td><td>${html(name)}</td><td>${html(owner)}</td><td><form class="inline-form" method="post" action="/territories/save"><input type="hidden" name="zone" value="${index + 1}"><select name="owner"><option value="neutral">Neutral</option>${gameConfig.barrios.map((barrio) => `<option value="${html(barrio.id)}"${owner === barrio.id ? " selected" : ""}>${html(barrio.name)}</option>`).join("")}</select><button>Save</button></form></td></tr>`; }).join("");
        response.end(page("Territories", `<section><h2>Territory control</h2><table><tr><th>Zone</th><th>Name</th><th>Owner</th><th>Change</th></tr>${rows}</table></section>`));
      } else if (url.pathname === "/market") {
        const items = state.market.map((item) => `<section><b>${html(item.name)}</b> - ${item.price} Dinero - stock: ${item.stock ?? "all"}<br>${html(item.description)}</section>`).join("");
        response.end(page("Market", `${items || "<section>No market items.</section>"}<form method="post" action="/market/save"><h2>Add or edit item</h2><input name="id" placeholder="Item ID" required><input name="name" placeholder="Name" required><input name="price" type="number" min="0" placeholder="Price" required><input name="stock" placeholder="Stock or all" required><textarea name="description" placeholder="Description" required></textarea><button>Save</button></form>`));
      } else if (url.pathname === "/penalties") {
        const list = state.penaltyCatalog.map((item) => `<section><b>${html(item.name)}</b> (<code>${html(item.id)}</code>)<br>${html(item.description)}<form class="inline-form" method="post" action="/penalties/save"><h2>Edit definition</h2>${textInput("id", item.id, "ID")}${textInput("name", item.name, "Name")}${textareaInput("description", item.description, "Description")}<button>Save changes</button></form></section>`).join("");
        response.end(page("Penalties", `${list || "<section>No penalties yet.</section>"}<form method="post" action="/penalties/save"><h2>Add definition</h2><input name="id" placeholder="ID" required><input name="name" placeholder="Name" required><textarea name="description" placeholder="Description" required></textarea><button>Add</button></form><form method="post" action="/penalties/apply"><h2>Apply to one user</h2><input name="nickname" placeholder="Nickname" required><input name="penaltyId" placeholder="Penalty ID" required><button>Apply</button></form>`));
      } else if (url.pathname === "/notify") {
        const history = state.notifications.slice(0, 20).map((item) => `<li>${html(item.createdAt)} - ${html(item.target)}:${html(item.targetId)} - ${item.sentCount} recipients - ${html(item.text)}</li>`).join("");
        response.end(page("Messages", `<form method="post" action="/notify/send"><select name="target"><option value="mission">Current mission subscribers</option><option value="barrio">Current mission barrio</option><option value="user">One user</option></select><input name="targetId" placeholder="Barrio ID or nickname (if needed)"><textarea name="text" placeholder="Message" required></textarea><button>Send</button></form><section><h2>Recent sends</h2><ul>${history || "<li>No messages logged.</li>"}</ul></section>`));
      } else {
        response.writeHead(404);
        response.end("Not found");
      }
    } catch (error) {
      console.error("Dashboard request failed:", error);
      response.writeHead(500);
      response.end("Dashboard request failed. Check the service log.");
    }
  }).listen(port, host, () => console.log(`Dashboard listening on http://${host}:${port}`));
}
