// Platform abstraction. Only files in src/app/platform/ may touch `tizen` or `webapis`
// (enforced by scripts/compat-check.mjs). Everything above this layer depends on these
// interfaces only, so it runs unchanged under Node tests with the doubles in memory-stores.ts.

export type PlatformName = 'tizen' | 'browser' | 'android';

export interface PlatformInfo {
  name: PlatformName;
  platformVersion: string;
  width: number;
  height: number;
  userAgent: string;
}

export interface PlatformCapabilities {
  /** Tizen application API reachable (exit). */
  appLifecycle: boolean;
  /** tizen.tvinputdevice present (remote keys beyond arrows/OK/Back). */
  keyRegistration: boolean;
  /** webapis.avplay present. */
  avplay: boolean;
  /** Large-data file storage present (tizen.filesystem on the TV; memory in a browser). */
  fileStore: boolean;
  /** Persistent secure credential store present (tizen.keymanager). */
  secureKeyStore: boolean;
  /** WebCrypto PBKDF2 available (crypto.subtle). */
  webCrypto: boolean;
}

export interface MemoryInfo {
  /** Free system memory in MB, or -1 when unknown. performance.memory is not live on the TV (probe 2). */
  availableMB: number;
  totalMB: number;
}

/** Synchronous small-value storage (localStorage on both platforms). */
export interface LocalStore {
  getItem(key: string): string | null;
  /** Throws on quota errors; callers wrap it (KeyValueStore does). */
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

/**
 * Large-data file storage, flat namespace. Names must match FILE_NAME_RE (common.ts).
 * TV throughput is about 1.5 MB/s each way [M, probe 2], so callers keep files small.
 */
export interface FileStore {
  /** Resolves null when the file does not exist. */
  read(name: string): Promise<string | null>;
  /** Replaces the whole file. Atomic (write-temp-then-move) when `atomicReplace` is true. */
  write(name: string, text: string): Promise<void>;
  /** Resolves when the file is gone (also when it never existed). */
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
  readonly atomicReplace: boolean;
  /** Diagnostics (Stage 6.1): longest synchronous call per operation, in ms. */
  timings?(): Record<string, number>;
  /**
   * Stage 9: asked before each blocking write-side call (create, write chunk, close, move, delete
   * while writing); the call runs when the returned promise resolves. null removes it.
   */
  setWriteGate?(gate: (() => Promise<void>) | null): void;
}

/** Secure storage for secrets (tizen.keymanager on the TV [V]). Values never touch FileStore or LocalStore. */
export interface KeyStore {
  /** Persistent across restarts. False for the in-memory browser/test double. */
  readonly persistent: boolean;
  save(alias: string, value: string): Promise<void>;
  /** Resolves null when the alias does not exist. */
  load(alias: string): Promise<string | null>;
  remove(alias: string): Promise<void>;
}

/** Cryptographic primitives provided by the platform. No JS fallback (SECURITY-DECISIONS.md). */
export interface CryptoProvider {
  /** Cryptographically secure random bytes (crypto.getRandomValues). */
  randomBytes(length: number): Uint8Array;
  /** PBKDF2 with HMAC-SHA-256 (WebCrypto deriveBits). */
  pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number, lengthBits: number): Promise<Uint8Array>;
}

/** Raw key events. Mapping to remote keys happens in navigation/keys.ts. */
export interface RawKeyEvent {
  keyCode: number;
  preventDefault(): void;
}

export interface KeyInput {
  /** Registers Tizen key names (ChannelUp, ColorF0Red, …). Returns the names that registered. */
  registerKeys(names: string[]): string[];
  onKeyDown(cb: (e: RawKeyEvent) => void): () => void;
  onKeyUp(cb: (e: RawKeyEvent) => void): () => void;
}

/** The subset of XMLHttpRequest the network layer uses. Tests supply a fake. */
export interface XhrLike {
  readyState: number;
  status: number;
  responseText: string;
  /** Final URL after redirects. Availability on Tizen 3.0 is unverified [A]. */
  responseURL?: string;
  timeout: number;
  withCredentials?: boolean;
  onreadystatechange: ((ev?: unknown) => void) | null;
  onprogress: ((ev?: unknown) => void) | null;
  onload: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  ontimeout: ((ev?: unknown) => void) | null;
  onabort: ((ev?: unknown) => void) | null;
  open(method: string, url: string, async: boolean): void;
  setRequestHeader(name: string, value: string): void;
  getResponseHeader?(name: string): string | null;
  /** Used for binary downloads ('text/plain; charset=x-user-defined'). */
  overrideMimeType?(mime: string): void;
  send(body?: string | null): void;
  abort(): void;
}

export interface Platform {
  readonly name: PlatformName;
  info(): PlatformInfo;
  capabilities(): PlatformCapabilities;
  memory(): MemoryInfo;
  /** Leaves the application (Tizen) or does nothing (browser). */
  exit(): void;
  /** false when hidden (Home key, source change), true when shown again. */
  onVisibilityChange(cb: (visible: boolean) => void): () => void;
  /** Browser online/offline events. */
  onNetworkChange(cb: (online: boolean) => void): () => void;
  readonly keys: KeyInput;
  readonly localStore: LocalStore | null;
  readonly fileStore: FileStore | null;
  readonly keyStore: KeyStore | null;
  readonly crypto: CryptoProvider | null;
  xhrFactory(): XhrLike;
}

/** The window surface the platform layer needs. Tests pass a fake. */
export interface PlatformWindow {
  document: Document;
  navigator: { userAgent: string; onLine?: boolean };
  innerWidth: number;
  innerHeight: number;
  addEventListener?(type: string, cb: () => void): void;
  removeEventListener?(type: string, cb: () => void): void;
  localStorage?: Storage;
  crypto?: Crypto;
  XMLHttpRequest?: { new (): XMLHttpRequest };
  tizen?: TizenApi;
  webapis?: SamsungWebApis;
  /** Android app (android/ project): native bridges injected with addJavascriptInterface. */
  ElitePlatform?: AndroidPlatformBridge;
  ElitePlayer?: AndroidPlayerBridge;
}

/** Native side: android/app/src/main/java/.../PlatformBridge.java. Strings only across the bridge. */
export interface AndroidPlatformBridge {
  version(): string;
  /** Device class: 'tv' (leanback) or 'phone'. */
  deviceType(): string;
  availableMemoryMB(): number;
  totalMemoryMB(): number;
  exit(): void;
  /** Files in the app's private storage; null when missing. Throws (Java exception) on failure. */
  fileRead(name: string): string | null;
  fileWrite(name: string, text: string): boolean;
  fileRemove(name: string): boolean;
  /** JSON array of names. */
  fileList(): string;
  /** Values encrypted with an Android Keystore AES key. */
  keySave(alias: string, value: string): boolean;
  keyLoad(alias: string): string | null;
  keyRemove(alias: string): boolean;
}

/** Native side: PlayerBridge.java (Media3 ExoPlayer on a surface behind the transparent WebView).
 *  Events come back through window.__elitePlayerEvent(json). */
export interface AndroidPlayerBridge {
  /** sid tags the events of this load (window.__elitePlayerEvent). */
  load(sid: string, url: string, type: string, live: boolean, userAgent: string, referrer: string, bufferMs: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setRect(x: number, y: number, w: number, h: number): void;
  positionMs(): number;
  seekTo(ms: number): void;
  /** JSON array of {kind:'audio'|'text', id, language, label, selected} (Stage 7B.2). */
  tracks(): string;
  /** kind 'audio' | 'text'; text id −1 = subtitles off. */
  selectTrack(kind: string, id: number): void;
  durationMs(): number;
}
