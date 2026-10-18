/** Application turn routing, independent of the runtime's request transport. */
export type TurnHandle = {
  start(turnId: string): Promise<unknown>;
  stream(turnId: string, after: number): Promise<Response>;
  stop(turnId: string): Promise<boolean>;
  purge?(turnId: string): Promise<void>;
};
export type TurnRouter = { get(turnId: string): TurnHandle };
