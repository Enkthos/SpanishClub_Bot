import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { gameConfig } from "./config";
import { JsonStore, nicknameKey, type Player } from "./store";
import type { Messenger } from "./telegram";

const html = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const nav = `<nav><a href="/">Overview</a><a href="/users">Users</a><a href="/missions">Missions</a><a href="/market">Market</a><a href="/penalties">Penalties</a><a href="/notify">Messages</a></nav>`;

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)} · LOS BARRIOS</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 16px;background:#10151d;color:#edf2f7}a{color:#8dd7ff;margin-right:16px}nav{padding:14px 0;border-bottom:1px solid #334155;margin-bottom:22px}section,form{background:#18212d;padding:16px;margin:14px 0;border-radius:8px}input,textarea,select,button{font:inherit;padding:8px;margin:4px;max-width:100%;box-sizing:border-box}input,textarea,select{background:#fff;color:#111}textarea{width:100%;min-height:76px}button{cursor:pointer}.ok{color:#86efac}.warn{color:#fcd34d}table{width:100%;border-collapse:collapse}td,th{padding:8px;text-align:left;border-bottom:1px solid #334155}</style><h1>LOS BARRIOS · ${html(title)}</h1>${nav}${body}`;
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
          });
          return redirect(response, "/users");
        }
        if (url.pathname === "/missions/assign") {
          const mission = state.missions.find((item) => item.id === form.missionId);
          const player = findPlayer(state.players, form.nickname ?? "");
          if (mission && player && mission.participantIds.includes(player.telegramId) && gameConfig.barrios.some((item) => item.id === form.barrioId)) {
            await store.update(() => { mission.barrioAssignments[String(player.telegramId)] = form.barrioId; });
          }
          return redirect(response, "/missions");
        }
        if (url.pathname === "/missions/save") {
          const id = (form.id ?? "").trim();
          const meetingAt = (form.meetingAt ?? "").trim();
          if (id && form.title?.trim() && form.description?.trim() && !Number.isNaN(Date.parse(meetingAt))) await store.update((next) => {
            const existing = next.missions.find((item) => item.id === id);
            const base = { id, title: form.title.trim(), description: form.description.trim(), meetingAt, location: form.location?.trim() || undefined };
            if (existing) Object.assign(existing, base);
            else next.missions.push({ ...base, status: "draft", participantIds: [], barrioAssignments: {}, participantRegisteredAt: {}, vocabulary: [], examples: [] });
          });
          return redirect(response, "/missions");
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
        response.end(page("Overview", `<section><b class="ok">Dashboard is online</b><p>Players: ${state.players.length} · Missions: ${state.missions.length} · Market items: ${state.market.length}</p><p>Active misión: ${active ? html(active.title) : "none"}</p><p>Bound to ${html(host)}:${port}. Keep it reachable through an SSH tunnel.</p></section>`));
      } else if (url.pathname === "/users") {
        const rows = state.players.map((player) => `<tr><td>${html(player.nickname)}</td><td>${player.role}</td><td>${player.dinero}</td><td>${player.respeto}</td><td>${player.wantedLevel}</td><td>${html(player.penalties.join("; "))}</td></tr>`).join("");
        response.end(page("Users", `<table><tr><th>Nickname</th><th>Role</th><th>Dinero</th><th>Respeto</th><th>Wanted</th><th>Penalties</th></tr>${rows}</table><form method="post" action="/users/update"><h2>Edit user</h2><input name="nickname" placeholder="Nickname" required><input name="dinero" type="number" placeholder="Dinero" required><input name="respeto" type="number" placeholder="Respeto" required><input name="wanted" type="number" min="0" max="3" placeholder="Wanted" required><select name="role"><option value="player">Player</option><option value="police">Police</option></select><button>Save</button></form>`));
      } else if (url.pathname === "/missions") {
        const cards = state.missions.map((mission) => `<section><b>${html(mission.title)}</b> · ${html(mission.status)}<br>${html(mission.meetingAt)}<br>Registered: ${mission.participantIds.length}<br>${mission.participantIds.map((id) => { const p = state.players.find((player) => player.telegramId === id); return p ? `${html(p.nickname)} → ${html(mission.barrioAssignments[String(id)] ?? "unassigned")}` : ""; }).join("<br>")}</section>`).join("");
        const options = state.missions.map((item) => `<option value="${html(item.id)}">${html(item.title)}</option>`).join("");
        const barrios = gameConfig.barrios.map((item) => `<option value="${html(item.id)}">${html(item.name)}</option>`).join("");
        response.end(page("Missions", `${cards || "<section>No missions yet.</section>"}<form method="post" action="/missions/save"><h2>Create or edit misión</h2><input name="id" placeholder="Mission ID" required><input name="title" placeholder="Title" required><input name="meetingAt" placeholder="2026-09-20T18:30:00+03:00" required><input name="location" placeholder="Location"><textarea name="description" placeholder="Description" required></textarea><button>Save</button></form><form method="post" action="/missions/assign"><h2>Manual team assignment</h2><select name="missionId">${options}</select><input name="nickname" placeholder="Registered nickname" required><select name="barrioId">${barrios}</select><button>Assign</button></form>`));
      } else if (url.pathname === "/market") {
        const items = state.market.map((item) => `<section><b>${html(item.name)}</b> · ${item.price} Dinero · stock: ${item.stock ?? "∞"}<br>${html(item.description)}</section>`).join("");
        response.end(page("Market", `${items || "<section>No market items.</section>"}<form method="post" action="/market/save"><h2>Add or edit item</h2><input name="id" placeholder="Item ID" required><input name="name" placeholder="Name" required><input name="price" type="number" min="0" placeholder="Price" required><input name="stock" placeholder="Stock or all" required><textarea name="description" placeholder="Description" required></textarea><button>Save</button></form>`));
      } else if (url.pathname === "/penalties") {
        const list = state.penaltyCatalog.map((item) => `<section><b>${html(item.name)}</b> (<code>${html(item.id)}</code>)<br>${html(item.description)}</section>`).join("");
        response.end(page("Penalties", `${list}<form method="post" action="/penalties/save"><h2>Add or edit definition</h2><input name="id" placeholder="ID" required><input name="name" placeholder="Name" required><textarea name="description" placeholder="Description" required></textarea><button>Save</button></form><form method="post" action="/penalties/apply"><h2>Apply to one user</h2><input name="nickname" placeholder="Nickname" required><input name="penaltyId" placeholder="Penalty ID" required><button>Apply</button></form>`));
      } else if (url.pathname === "/notify") {
        const history = state.notifications.slice(0, 20).map((item) => `<li>${html(item.createdAt)} · ${html(item.target)}:${html(item.targetId)} · ${item.sentCount} recipients — ${html(item.text)}</li>`).join("");
        response.end(page("Messages", `<form method="post" action="/notify/send"><select name="target"><option value="mission">Current mission subscribers</option><option value="barrio">Current mission barrio</option><option value="user">One user</option></select><input name="targetId" placeholder="Barrio ID or nickname (if needed)"><textarea name="text" placeholder="Message" required></textarea><button>Send</button></form><section><h2>Recent sends</h2><ul>${history || "<li>No messages logged.</li>"}</ul></section>`));
      } else { response.writeHead(404); response.end("Not found"); }
    } catch (error) {
      console.error("Dashboard request failed:", error);
      response.writeHead(500); response.end("Dashboard request failed. Check the service log.");
    }
  }).listen(port, host, () => console.log(`Dashboard listening on http://${host}:${port}`));
}
