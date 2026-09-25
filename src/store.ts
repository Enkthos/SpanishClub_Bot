import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MarketItem, VocabularyEntry } from "./types";

export type Player = {
  telegramId: number;
  chatId: number;
  nickname: string;
  realName?: string;
  nicknameKey: string;
  barrioId: string | null;
  role: "player" | "police";
  dinero: number;
  respeto: number;
  penalties: string[];
  wantedLevel: number;
  moveCount: number;
  inventory: string[];
  registeredAt: string;
};

export type MissionState = {
  title: string;
  description: string;
  meetingAt: string;
  location?: string;
  rewardDinero?: number;
  rewardRespeto?: number;
  vocabulary?: VocabularyEntry[];
  phrases?: MissionPhrase[];
  examples?: string[];
};

export type MissionPhrase = {
  text: string;
  translation?: string;
  notes?: string;
};

export type MissionRecord = MissionState & {
  id: string;
  status: "draft" | "active" | "completed";
  participantIds: number[];
  barrioAssignments: Record<string, string>;
  participantRegisteredAt: Record<string, string>;
};

export type PenaltyDefinition = { id: string; name: string; description: string };

export type NotificationLog = {
  id: string;
  createdAt: string;
  target: "user" | "barrio" | "mission";
  targetId: string;
  text: string;
  sentCount: number;
};

export type GameEvent = {
  id: string;
  type: "la_rata" | "robo" | "guerra" | "custom";
  title: string;
  description: string;
  target: string;
  status: "draft" | "active" | "completed";
  createdAt: string;
};

export type GameState = {
  players: Player[];
  missions: MissionRecord[];
  activeMissionId: string | null;
  events: GameEvent[];
  market: MarketItem[];
  barrioMoney: Record<string, number>;
  barrioLeaderIds: Record<string, number>;
  barrioCharacterNames: Record<string, string>;
  leaderPhotoFileIds: Record<string, string>;
  mapPhotoFileId: string | null;
  territories: Record<string, string | null>;
  penaltyCatalog: PenaltyDefinition[];
  notifications: NotificationLog[];
  botInformation?: string;
  botRules?: string;
};

export function emptyState(): GameState {
  return {
    players: [],
    missions: [],
    activeMissionId: null,
    events: [],
    market: [],
    barrioMoney: {},
    barrioLeaderIds: {},
    barrioCharacterNames: {},
    leaderPhotoFileIds: {},
    mapPhotoFileId: null,
    territories: {},
    penaltyCatalog: [],
    notifications: [],
  };
}

export class JsonStore {
  readonly path: string;
  private state: GameState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<GameState> {
    try {
      this.state = JSON.parse(await readFile(this.path, "utf8")) as GameState;
      this.state.leaderPhotoFileIds ??= {};
      this.state.mapPhotoFileId ??= null;
      this.state.territories ??= {};
      this.state.missions ??= [];
      this.state.activeMissionId ??= null;
      this.state.events ??= [];
      this.state.barrioLeaderIds ??= {};
      this.state.barrioCharacterNames ??= {};
      const legacyState = this.state as GameState & { barrioDinero?: Record<string, number> };
      this.state.barrioMoney ??= legacyState.barrioDinero ?? {};
      delete legacyState.barrioDinero;
      this.state.penaltyCatalog ??= [];
      this.state.notifications ??= [];
      for (const mission of this.state.missions) {
        mission.participantIds ??= [];
        mission.barrioAssignments ??= {};
        mission.participantRegisteredAt ??= Object.fromEntries(mission.participantIds.map((id) => [String(id), ""]));
        mission.vocabulary ??= [];
        mission.phrases ??= [];
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save();
    }
    return this.state;
  }

  get(): GameState {
    return this.state;
  }

  async update(change: (state: GameState) => void): Promise<GameState> {
    change(this.state);
    await this.save();
    return this.state;
  }

  async save(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(temporary, this.path);
    });
    return this.writeChain;
  }
}

export function nicknameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}
