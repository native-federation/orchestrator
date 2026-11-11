/** @deprecated Use @softarc/native-federation-communication. Removed in v5. */
export type NFEventProvider<T> = () => Promise<T> | T;
/** @deprecated Use @softarc/native-federation-communication. Removed in v5. */
export type NFEventConsumer<T> = (resource: T) => void;
/** @deprecated Use @softarc/native-federation-communication. Removed in v5. */
export type NFEventErrorHandler = (name: string, error: Error) => void;

/** @deprecated Use @softarc/native-federation-communication. Removed in v5. */
export type NFEventData<T = any> = {
  data: T;
  timestamp: number;
};

/** @deprecated Use @softarc/native-federation-communication. Removed in v5. */
export type NFEventUnsubscribe = () => void;

/** @deprecated Use @softarc/native-federation-communication. Removed in v5. */
export type NFEventStream<T = any> = {
  events: NFEventData<T>[];
  latest: NFEventData<T> | null;
  count: number;
  firstEvent: number | null;
  lastEvent: number | null;
};
