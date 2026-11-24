// Minimal hand-written declarations for the Tizen APIs ScreenShelf touches.
// Only src/app/platform/ may use them (enforced by scripts/compat-check.mjs).
// [V] = exercised on the UE50MU6100 by a probe; [A] = from the Tizen 3.0 API docs, not yet exercised.

interface TizenApplication {
  exit(): void;
}

interface TizenApplicationManager {
  getCurrentApplication(): TizenApplication;
}

interface TizenSystemInfo {
  getCapability(key: string): string | number | boolean;
  /** [V] probe 1/2 */
  getAvailableMemory?(): number;
  /** [V] probe 1 */
  getTotalMemory?(): number;
}

interface TizenInputDeviceKey {
  name: string;
  code: number;
}

interface TizenTvInputDevice {
  getSupportedKeys(): TizenInputDeviceKey[];
  registerKey(name: string): void;
}

interface TizenError {
  name: string;
  message: string;
}

interface TizenFileStream {
  /** [V] probe 2 */
  eof: boolean;
  /** [V] probe 2 */
  read(charCount: number): string;
  /** [V] probe 2 */
  write(text: string): void;
  /** [V] probe 2 */
  close(): void;
}

interface TizenFile {
  name: string;
  fullPath: string;
  isFile: boolean;
  isDirectory: boolean;
  /** [V] probe 2 */
  createFile(relativePath: string): TizenFile;
  /** [V] probe 2 */
  resolve(relativePath: string): TizenFile;
  /** [V] probe 2 */
  openStream(mode: 'r' | 'w' | 'a' | 'rw', onSuccess: (s: TizenFileStream) => void, onError?: (e: TizenError) => void, encoding?: string): void;
  /** [V] probe 2 */
  deleteFile(filePath: string, onSuccess?: () => void, onError?: (e: TizenError) => void): void;
  /** [A] */
  moveTo(originFilePath: string, destinationFilePath: string, overwrite: boolean, onSuccess?: () => void, onError?: (e: TizenError) => void): void;
  /** [A] */
  listFiles(onSuccess: (files: TizenFile[]) => void, onError?: (e: TizenError) => void): void;
}

interface TizenFileSystemManager {
  /** [V] probe 2 ('wgt-private', mode 'rw') */
  resolve(location: string, onSuccess: (dir: TizenFile) => void, onError?: (e: TizenError) => void, mode?: 'r' | 'rw'): void;
}

interface TizenKeyManagerAlias {
  name: string;
}

interface TizenKeyManager {
  /** [V] probe 2 */
  saveData(aliasName: string, rawData: string, password: string | null, onSuccess?: () => void, onError?: (e: TizenError) => void): void;
  /** [V] probe 2 (synchronous) */
  getData(alias: TizenKeyManagerAlias, password: string | null): string;
  /** [V] probe 2 (synchronous) */
  removeData(alias: TizenKeyManagerAlias): void;
}

interface TizenApi {
  application: TizenApplicationManager;
  systeminfo: TizenSystemInfo;
  tvinputdevice?: TizenTvInputDevice;
  filesystem?: TizenFileSystemManager;
  keymanager?: TizenKeyManager;
}

interface SamsungWebApis {
  avplay?: object;
}
