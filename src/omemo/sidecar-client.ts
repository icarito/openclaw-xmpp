import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Omemo2Callback =
  | "upload_bundle"
  | "download_bundle"
  | "delete_bundle"
  | "upload_device_list"
  | "download_device_list"
  | "send_message";

export type Omemo2CallbackHandler = (
  method: Omemo2Callback,
  params: Record<string, unknown>,
) => Promise<unknown>;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type SidecarMessage = {
  type: "response" | "callback";
  id: string;
  method?: Omemo2Callback;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export class Omemo2SidecarClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private requestTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly python: string,
    private readonly script: string,
    private readonly callback: Omemo2CallbackHandler,
  ) {}

  start(): void {
    if (this.child) return;
    const child = spawn(this.python, [this.script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => void this.onLine(line));
    child.stderr.on("data", (chunk) => process.stderr.write(`[omemo2-sidecar] ${chunk}`));
    child.once("exit", (code, signal) => {
      const error = new Error(`OMEMO 2 sidecar exited (code=${code}, signal=${signal})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.child = null;
    });
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const execute = (): Promise<T> => {
      this.start();
      const child = this.child;
      if (!child) return Promise.reject(new Error("OMEMO 2 sidecar failed to start"));
      const id = `req-${++this.nextId}`;
      const promise = new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return promise;
    };
    const operation = this.requestTail.then(execute, execute);
    this.requestTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async onLine(line: string): Promise<void> {
    let message: SidecarMessage;
    try {
      message = JSON.parse(line) as SidecarMessage;
    } catch {
      process.stderr.write(`[omemo2-sidecar] invalid JSON: ${line}\n`);
      return;
    }

    if (message.type === "callback" && message.method) {
      try {
        const result = await this.callback(message.method, message.params ?? {});
        this.child?.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
      } catch (error) {
        this.child?.stdin.write(`${JSON.stringify({
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        })}\n`);
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request("shutdown");
    } finally {
      this.child?.kill("SIGTERM");
      this.child = null;
    }
  }
}
