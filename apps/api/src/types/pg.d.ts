/**
 * The few parts of `pg` the live-update listener uses (roadmap #39). `pg` is already installed as
 * pg-boss's driver; these declarations stand in for @types/pg rather than adding a package for them.
 */
declare module 'pg' {
  export interface Notification { channel: string; payload?: string; processId: number }
  export interface ClientConfig { connectionString?: string; application_name?: string }
  export class Client {
    constructor(config?: ClientConfig);
    connect(): Promise<void>;
    query(text: string): Promise<unknown>;
    end(): Promise<void>;
    on(event: 'notification', listener: (msg: Notification) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'end', listener: () => void): this;
  }
  const pg: { Client: typeof Client };
  export default pg;
}
