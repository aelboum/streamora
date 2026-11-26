// npm run android:build   — debug APK (Android debug key): dist/android/EliteStream-<versionName>-debug.apk
// npm run android:release — release APK signed with the EliteStream production key (CP2 beta):
//                           dist/android/EliteStream-<versionName>-release.apk
//   1. Web app: node scripts/build.mjs release (same bundle as the Samsung TV release build).
//   2. Copies index.html, app.js, app.css and fonts/ into android/app/src/main/assets/www.
//   3. Runs Gradle (assembleDebug / assembleRelease) in android/ and copies the APK to dist/android/.
// versionName comes from android/app/build.gradle (it may carry a suffix such as -beta.1, which the
// Samsung config.xml version cannot). The release key and its passwords live outside the repository
// (~/.gradle/gradle.properties, see build.gradle); this script never reads or prints them.
// Tools (installed outside the repo; override with environment variables):
//   JAVA_HOME     default C:\Users\imran\Tools\jdk17
//   ANDROID_HOME  default C:\Users\imran\Tools\android-sdk
//   GRADLE        default C:\Users\imran\Tools\gradle-8.7\bin\gradle.bat
// Debug builds are signed with the Android debug key (disposable test installs only).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tools = 'C:\\Users\\imran\\Tools';
const JAVA_HOME = process.env.JAVA_HOME || join(tools, 'jdk17');
const ANDROID_HOME = process.env.ANDROID_HOME || join(tools, 'android-sdk');
const GRADLE = process.env.GRADLE || join(tools, 'gradle-8.7', 'bin', 'gradle.bat');
const mode = process.argv[2] === 'release' ? 'release' : 'debug';
const gradleFile = readFileSync(join(root, 'android', 'app', 'build.gradle'), 'utf8');
const versionMatch = /versionName\s+'([^']+)'/.exec(gradleFile);
if (!versionMatch) {
  console.error('android build: versionName not found in android/app/build.gradle');
  process.exit(1);
}
const version = versionMatch[1];

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error('android build: failed: ' + cmd + ' ' + args.join(' '));
    process.exit(r.status || 1);
  }
}

for (const [what, p] of [['JDK', JAVA_HOME], ['Android SDK', ANDROID_HOME], ['Gradle', GRADLE]]) {
  if (!existsSync(p)) {
    console.error('android build: ' + what + ' not found at ' + p);
    process.exit(1);
  }
}

// 1. web bundle
run(process.execPath, [join(root, 'scripts', 'build.mjs'), 'release'], { shell: false });

// 2. assets
const dist = join(root, 'dist', 'release');
const www = join(root, 'android', 'app', 'src', 'main', 'assets', 'www');
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const f of ['index.html', 'app.js', 'app.css']) {
  cpSync(join(dist, f), join(www, f));
}
cpSync(join(dist, 'fonts'), join(www, 'fonts'), { recursive: true });
writeFileSync(join(root, 'android', 'local.properties'), 'sdk.dir=' + ANDROID_HOME.replace(/\\/g, '\\\\') + '\n');

// 3. gradle
const env = { ...process.env, JAVA_HOME: JAVA_HOME, ANDROID_HOME: ANDROID_HOME, ANDROID_SDK_ROOT: ANDROID_HOME };
const apkDir = join(root, 'android', 'app', 'build', 'outputs', 'apk', mode);
rmSync(apkDir, { recursive: true, force: true });
run(GRADLE, ['--no-daemon', '-q', mode === 'release' ? 'assembleRelease' : 'assembleDebug'], { cwd: join(root, 'android'), env: env });
const apk = join(apkDir, mode === 'release' ? 'app-release.apk' : 'app-debug.apk');
if (!existsSync(apk)) {
  console.error(mode === 'release'
    ? 'android build: no signed release APK. The release key is not configured: set ELITESTREAM_KEYSTORE, ' +
      'ELITESTREAM_KEYSTORE_PASSWORD, ELITESTREAM_KEY_ALIAS and ELITESTREAM_KEY_PASSWORD in ~/.gradle/gradle.properties.'
    : 'android build: ' + apk + ' was not produced');
  process.exit(1);
}
const outDir = join(root, 'dist', 'android');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'EliteStream-' + version + '-' + mode + '.apk');
cpSync(apk, out);
console.log('android build: OK -> ' + out);
