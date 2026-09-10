# Los Barrios Bot

Telegram bot for running the **Los Barrios** Spanish club game. The interface is
primarily in Russian, while game names and useful expressions remain in Spanish.

The bot supports:

- player registration with unique nicknames;
- separate attendance and balanced barrio assignment for every mission;
- missions with dates, vocabulary and practical examples;
- player profiles, Dinero, Respeto, penalties and Policía status;
- barrio leaders, rankings, Mercado items and live events;
- a 15-zone territory map that changes as barrios win;
- persistent local storage in JSON.

## Requirements

- Node.js 20 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Open `.env` and add the bot token:

```dotenv
TELEGRAM_BOT_TOKEN=your_botfather_token
ADMIN_TELEGRAM_IDS=
BOT_DATA_FILE=./data/game-state.json
CHARACTER_RESET_CODE=0000
```

Start the bot:

```powershell
npm start
```

Send `/myid` to the bot, copy the returned number into
`ADMIN_TELEGRAM_IDS`, and restart it. Separate multiple administrator IDs with
commas.

Only one running process should use the same Telegram token.

## Player flow

1. Send `/start` and choose a unique nickname.
2. Open `📋 Все misiones`.
3. Join with `/missionjoin MISSION_ID`.
4. The bot assigns a barrio for that mission. Assignments are stored independently
   because attendance can change between meetings.
5. Leave with `/missionleave MISSION_ID` if necessary.

To delete a character and register again, use the
`🗑 Перезапустить персонажа` button or send `/restart 0000`. Change
`CHARACTER_RESET_CODE` in `.env` if a different confirmation code is needed.

## Organizer commands

Use `/admin` inside Telegram to see the complete command list.

Create and schedule a mission:

```text
/missionadd intro | 2026-09-20T18:00:00+03:00 | La presentación | Познакомьтесь с тремя игроками | Главный зал
/missiontime intro | 2026-09-20 | 18:30
/missionvocab intro | ¿Cómo te llamas? | Как тебя зовут?
/missionexample intro | Представься трём людям из других barrios
/missionstart intro
/missionfinish intro
```

Appoint a registered player as a barrio leader:

```text
/leader nomadas | El Tigre
/leaderremove nomadas
```

Manage Mercado items:

```text
/shopadd llave | Llave | 300 | 5 | Открывает одну дверь
/shopedit llave | Llave dorada | 450 | all | Открывает тайную дверь
/shopdelete llave
```

Create common game events:

```text
/eventpreset rata | El Tigre
/eventpreset robo | nomadas
/eventpreset guerra | nomadas,navegantes
/eventstart EVENT_ID
/eventfinish EVENT_ID
```

Award or remove territory:

```text
/win nomadas
/territoryremove nomadas
/territoryremove 5
```

## Images

Leader portraits and the territory map are uploaded directly through Telegram.
Run the command, then send the corresponding image:

```text
/leaderphoto nomadas
/leaderphoto navegantes
/leaderphoto lumieres
/leaderphoto panteras
/mapphoto
```

Telegram file IDs are stored in the local runtime state. Los Fuegos currently
shows only the leader name.

## Configuration

Edit `config/game.config.json` to change barrio names, slogans, colors, assignment
thresholds, Policía ratio, economy defaults, dictionary content and timezone.

## Development

```powershell
npm test
npm run typecheck
```

## Deployment with PM2

Install PM2 once on the deployment machine:

```bash
npm install --global pm2
```

Clone the repository, create `.env` from `.env.example`, and run the deployment
script from the project directory. The script keeps the current `.env`, updates
the checked-out branch from GitHub using a fast-forward-only merge, installs the
locked dependencies, runs the checks, and reloads the process.

Linux:

```bash
bash scripts/deploy.sh
```

Windows PowerShell:

```powershell
.\scripts\deploy.cmd
```

The `.cmd` wrapper also works on systems where PowerShell script execution is
disabled by the default policy.

Pass a different branch name as the first argument when needed:

```bash
bash scripts/deploy.sh staging
```

Useful PM2 commands:

```bash
pm2 status
pm2 logs los-barrios-bot
pm2 restart los-barrios-bot
```

Run `pm2 startup` once on a Linux server if the bot should start automatically
after a reboot. Stop any manually running copy of the bot before the first PM2
deployment to avoid two processes polling the same Telegram token.

Local secrets and runtime data are excluded by `.gitignore`. Commit
`.env.example`, but never commit `.env` or `data/game-state.json`.
