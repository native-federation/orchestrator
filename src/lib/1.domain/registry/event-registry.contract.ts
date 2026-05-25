import type {
  NFEventConsumer,
  NFEventData,
  NFEventProvider,
  NFEventUnsubscribe,
} from './event.contract';

export type NFEventRegistry = {
  register<T>(type: string, resource: T | NFEventProvider<T>): Promise<void>;
  onReady<T>(type: string, callback: NFEventConsumer<T>): NFEventUnsubscribe;
  emit<T>(type: string, data: T): void;
  update<T>(type: string, callback: (last: T | undefined) => T): void;
  on<T>(
    type: string,
    callback: NFEventConsumer<NFEventData<T>>,
    opts?: { replay?: number }
  ): NFEventUnsubscribe;
  clear(type?: string): void;
};
