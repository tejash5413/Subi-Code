export interface Disposable { dispose(): void; }
export type Event<T> = (listener: (value: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;
/** Host-neutral event contract, structurally compatible with VS Code Event. */
export class EventEmitter<T> implements Disposable {
  private readonly listeners = new Set<(value: T) => unknown>();
  public readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const callback = (value: T) => listener.call(thisArgs, value);
    this.listeners.add(callback);
    const disposable = { dispose: () => { this.listeners.delete(callback); } };
    disposables?.push(disposable); return disposable;
  };
  public fire(value: T): void { for (const listener of [...this.listeners]) { try { listener(value); } catch { /* Observers cannot change authentication. */ } } }
  public dispose(): void { this.listeners.clear(); }
}
