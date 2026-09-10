export type Barrio = {
  id: string;
  name: string;
  slogan: string;
  color: string;
  emoji: string;
  leader: {
    name: string;
    hidePhoto?: boolean;
  };
};

export type VocabularyEntry = {
  spanish: string;
  russian: string;
};

export type ActivationThreshold = {
  minimumBarrioPlayers: number;
  activeBarrios: number;
};

export type GameConfig = {
  locale: string;
  timeZone: string;
  event: {
    name: string;
    meetingAt: string;
    location: string;
    currentMission: Omit<Mission, "meetingAt" | "location">;
  };
  economy: {
    startingPlayerDinero: number;
    startingBarrioDinero: number;
    startingRespeto: number;
  };
  dictionary: {
    title: string;
    entries: VocabularyEntry[];
  }[];
  assignment: {
    activationThresholds: ActivationThreshold[];
    rebalanceOnlyWhenBarrioActivates: boolean;
    maximumSizeDifference: number;
  };
  police: {
    barrioPlayersPerOfficer: number;
    minimumOfficers: number;
    assignmentMode: "manual";
  };
  barrios: Barrio[];
  market: MarketItem[];
};

export type PlayerAssignment = {
  playerId: string;
  barrioId: string;
  moveCount?: number;
};

export type Mission = {
  title: string;
  description: string;
  meetingAt: Date;
  location?: string;
  rewardDinero?: number;
  rewardRespeto?: number;
  vocabulary?: VocabularyEntry[];
  examples?: string[];
};

export type MarketItem = {
  id: string;
  name: string;
  description: string;
  price: number;
  stock: number | null;
  minimumRespeto?: number;
};
