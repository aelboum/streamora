package com.elitestream.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.SparseIntArray;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.media3.ui.PlayerView;

/**
 * EliteStream Android shell (Stage 8). A transparent WebView shows the same web app as the Samsung
 * TV build (assets/www, copied from dist/release by scripts/android.mjs); a Media3 PlayerView sits
 * behind it, like the AVPlay video plane on Tizen. Remote, D-pad, back and media keys are mapped to
 * the TV key codes the web app already understands (src/navigation/keys.ts) and delivered through
 * window.__eliteKey(code, down), so the WebView never handles them itself.
 */
public class MainActivity extends Activity {
    private WebView web;
    private PlayerBridge player;
    private final SparseIntArray keys = new SparseIntArray();

    private void mapKeys() {
        keys.put(KeyEvent.KEYCODE_DPAD_LEFT, 37);
        keys.put(KeyEvent.KEYCODE_DPAD_UP, 38);
        keys.put(KeyEvent.KEYCODE_DPAD_RIGHT, 39);
        keys.put(KeyEvent.KEYCODE_DPAD_DOWN, 40);
        keys.put(KeyEvent.KEYCODE_DPAD_CENTER, 13);
        keys.put(KeyEvent.KEYCODE_ENTER, 13);
        keys.put(KeyEvent.KEYCODE_NUMPAD_ENTER, 13);
        keys.put(KeyEvent.KEYCODE_BUTTON_A, 13);
        keys.put(KeyEvent.KEYCODE_BACK, 10009);
        keys.put(KeyEvent.KEYCODE_ESCAPE, 10009);
        keys.put(KeyEvent.KEYCODE_BUTTON_B, 10009);
        keys.put(KeyEvent.KEYCODE_CHANNEL_UP, 427);
        keys.put(KeyEvent.KEYCODE_CHANNEL_DOWN, 428);
        keys.put(KeyEvent.KEYCODE_PAGE_UP, 427);
        keys.put(KeyEvent.KEYCODE_PAGE_DOWN, 428);
        keys.put(KeyEvent.KEYCODE_PROG_RED, 403);
        keys.put(KeyEvent.KEYCODE_PROG_GREEN, 404);
        keys.put(KeyEvent.KEYCODE_PROG_YELLOW, 405);
        keys.put(KeyEvent.KEYCODE_PROG_BLUE, 406);
        keys.put(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, 10252);
        keys.put(KeyEvent.KEYCODE_MEDIA_PLAY, 415);
        keys.put(KeyEvent.KEYCODE_MEDIA_PAUSE, 19);
        keys.put(KeyEvent.KEYCODE_MEDIA_STOP, 413);
        keys.put(KeyEvent.KEYCODE_MEDIA_REWIND, 412);
        keys.put(KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, 417);
        keys.put(KeyEvent.KEYCODE_INFO, 457);
        keys.put(KeyEvent.KEYCODE_MENU, 457);
        keys.put(KeyEvent.KEYCODE_GUIDE, 458); // TV guide (Stage 7B.2)
        // CP2 F5: keys the Samsung remote has an equivalent for.
        keys.put(KeyEvent.KEYCODE_LAST_CHANNEL, 10190);   // previous channel (Samsung PRE-CH)
        keys.put(KeyEvent.KEYCODE_MEDIA_NEXT, 427);       // next: channel up / list page down, as CH+
        keys.put(KeyEvent.KEYCODE_MEDIA_PREVIOUS, 428);   // previous: channel down / list page up, as CH-
        for (int d = 0; d <= 9; d++) {
            keys.put(KeyEvent.KEYCODE_0 + d, 48 + d);
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        mapKeys();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#080C18"));

        PlayerView video = new PlayerView(this);
        video.setUseController(false);
        video.setKeepContentOnPlayerReset(false);
        video.setBackgroundColor(Color.BLACK);
        root.addView(video, new FrameLayout.LayoutParams(0, 0));

        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        // The web app is local (file:///android_asset) and talks to the user's own IPTV provider
        // with XMLHttpRequest, exactly as the Tizen build does through its config.xml access rule.
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        player = new PlayerBridge(this, web, video);
        web.addJavascriptInterface(new PlatformBridge(this), "ElitePlatform");
        web.addJavascriptInterface(player, "ElitePlayer");
        setContentView(root);
        hideSystemUi();
        web.loadUrl("file:///android_asset/www/index.html");
        web.requestFocus();
    }

    private void hideSystemUi() {
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUi();
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = keys.get(e.getKeyCode(), -1);
        if (code < 0 || web == null) {
            return super.dispatchKeyEvent(e);
        }
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            web.evaluateJavascript("window.__eliteKey&&window.__eliteKey(" + code + ",true)", null);
        } else if (e.getAction() == KeyEvent.ACTION_UP) {
            web.evaluateJavascript("window.__eliteKey&&window.__eliteKey(" + code + ",false)", null);
        }
        return true; // the app decides what Back does (it shows its own exit confirmation)
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.evaluateJavascript("window.__eliteVisible&&window.__eliteVisible(false)", null);
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemUi();
        if (web != null) {
            web.evaluateJavascript("window.__eliteVisible&&window.__eliteVisible(true)", null);
        }
    }

    @Override
    protected void onDestroy() {
        if (player != null) {
            player.release();
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
