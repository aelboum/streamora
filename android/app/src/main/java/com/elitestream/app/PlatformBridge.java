package com.elitestream.app;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.UiModeManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.Charset;
import java.security.KeyStore;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * ElitePlatform bridge (src/app/platform/android-platform.ts). Files live in the app's private
 * storage (filesDir/catalogue); writes go to a temp file that is then renamed, so a crash never
 * leaves a half-written file. Secrets (playlist passwords, the PIN record) are encrypted with an
 * AES-256-GCM key held by the Android Keystore (Android 6.0+); on older versions saving a secret
 * fails and the app reports that credentials can't be stored, rather than keeping them in clear.
 * Names are checked with the same rules as the web side; secrets are never logged.
 */
public class PlatformBridge {
    private static final Pattern FILE_RE = Pattern.compile("^[a-z0-9][a-z0-9._-]{0,99}$");
    private static final Pattern ALIAS_RE = Pattern.compile("^[A-Za-z0-9_]{1,64}$");
    private static final String KEY_ALIAS = "elitestream_secrets_v1";
    private static final Charset UTF8 = Charset.forName("UTF-8");

    private final Activity activity;
    private final File dir;
    private final SharedPreferences secrets;

    public PlatformBridge(Activity activity) {
        this.activity = activity;
        this.dir = new File(activity.getFilesDir(), "catalogue");
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        this.secrets = activity.getSharedPreferences("secrets", Context.MODE_PRIVATE);
    }

    private File file(String name) {
        if (name == null || !FILE_RE.matcher(name).matches() || name.contains("..")) {
            throw new IllegalArgumentException("invalid file name");
        }
        return new File(dir, name);
    }

    @JavascriptInterface
    public String version() {
        return "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")";
    }

    @JavascriptInterface
    public String deviceType() {
        UiModeManager m = (UiModeManager) activity.getSystemService(Context.UI_MODE_SERVICE);
        return m != null && m.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION ? "tv" : "phone";
    }

    private ActivityManager.MemoryInfo mem() {
        ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        if (am != null) {
            am.getMemoryInfo(mi);
        }
        return mi;
    }

    @JavascriptInterface
    public int availableMemoryMB() {
        return (int) (mem().availMem / 1048576L);
    }

    @JavascriptInterface
    public int totalMemoryMB() {
        return Build.VERSION.SDK_INT >= 16 ? (int) (mem().totalMem / 1048576L) : -1;
    }

    @JavascriptInterface
    public void exit() {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (Build.VERSION.SDK_INT >= 21) {
                    activity.finishAndRemoveTask();
                } else {
                    activity.finish();
                }
            }
        });
    }

    // ------------------------------------------------------------------ files

    @JavascriptInterface
    public String fileRead(String name) throws IOException {
        File f = file(name);
        if (!f.exists()) {
            return null;
        }
        StringBuilder sb = new StringBuilder((int) Math.min(f.length(), 16L * 1024 * 1024));
        Reader r = new InputStreamReader(new FileInputStream(f), UTF8);
        try {
            char[] buf = new char[65536];
            int n;
            while ((n = r.read(buf)) > 0) {
                sb.append(buf, 0, n);
            }
        } finally {
            r.close();
        }
        return sb.toString();
    }

    @JavascriptInterface
    public boolean fileWrite(String name, String text) throws IOException {
        File f = file(name);
        File tmp = new File(dir, name + ".tmp");
        FileOutputStream os = new FileOutputStream(tmp);
        Writer w = new OutputStreamWriter(os, UTF8);
        try {
            w.write(text);
            w.flush();
            os.getFD().sync();
        } finally {
            w.close();
        }
        if (!tmp.renameTo(f)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return false;
        }
        return true;
    }

    @JavascriptInterface
    public boolean fileRemove(String name) {
        File f = file(name);
        return !f.exists() || f.delete();
    }

    @JavascriptInterface
    public String fileList() {
        JSONArray a = new JSONArray();
        String[] names = dir.list();
        if (names != null) {
            for (String n : names) {
                if (FILE_RE.matcher(n).matches()) {
                    a.put(n);
                }
            }
        }
        return a.toString();
    }

    // ------------------------------------------------------------------ secrets

    @android.annotation.TargetApi(23)
    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    private static void checkAlias(String alias) {
        if (alias == null || !ALIAS_RE.matcher(alias).matches()) {
            throw new IllegalArgumentException("invalid key alias");
        }
    }

    @JavascriptInterface
    public boolean keySave(String alias, String value) {
        checkAlias(alias);
        if (Build.VERSION.SDK_INT < 23) {
            return false;
        }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(value.getBytes(UTF8));
            byte[] out = new byte[1 + iv.length + ct.length];
            out[0] = (byte) iv.length;
            System.arraycopy(iv, 0, out, 1, iv.length);
            System.arraycopy(ct, 0, out, 1 + iv.length, ct.length);
            return secrets.edit().putString(alias, Base64.encodeToString(out, Base64.NO_WRAP)).commit();
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public String keyLoad(String alias) {
        checkAlias(alias);
        String v = secrets.getString(alias, null);
        if (v == null || Build.VERSION.SDK_INT < 23) {
            return null;
        }
        try {
            byte[] in = Base64.decode(v, Base64.NO_WRAP);
            int ivLen = in[0];
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, in, 1, ivLen));
            byte[] pt = c.doFinal(in, 1 + ivLen, in.length - 1 - ivLen);
            return new String(pt, UTF8);
        } catch (Exception e) {
            return null;
        }
    }

    @JavascriptInterface
    public boolean keyRemove(String alias) {
        checkAlias(alias);
        return secrets.edit().remove(alias).commit();
    }
}
