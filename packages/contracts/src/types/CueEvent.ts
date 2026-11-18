
export type CueEvent = {
  organisationId: string;
  integrationAccountId: string;
  source: string;
  nativeId: string;
  eventType: string;
  payload: unknown;
  at: number;
};
