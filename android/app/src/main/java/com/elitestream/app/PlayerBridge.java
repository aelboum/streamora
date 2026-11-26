package com.elitestream.app;

import android.app.Activity;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.text.Cue;
import androidx.media3.common.text.CueGroup;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * ElitePlayer bridge (src/player/android-engine.ts). One ExoPlayer, driven on the main thread;
 * JavaScript calls arrive on the bridge thread and are posted. Events go back as
 * window.__elitePlayerEvent(json) with the sid of the load they belong to. Position and duration
 * are cached every 500 ms so the synchronous getters never touch the player off its thread.
 * URLs are never logged: they contain the provider credentials.
 */
public class PlayerBridge {
    private final Activity activity;
    private final WebView web;
    private final PlayerView view;
    private final Handler main = new Handler(Looper.getMainLooper());
    private ExoPlayer player;
    private String sid = "0";
    private boolean prepared;
    private boolean firstFrame;
    private volatile long posMs;
    private volatile long durMs;
    private float rx = 0, ry = 0, rw = 1920, rh = 1080;
    /** Track list as JSON, rebuilt on the main thread whenever the tracks change (Stage 7B.2). */
    private volatile String tracksJson = "[]";

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (player != null) {
                posMs = Math.max(0, player.getCurrentPosition());
                long d = player.getDuration();
                durMs = d == C.TIME_UNSET ? 0 : Math.max(0, d);
            }
            main.postDelayed(this, 500);
        }
    };

    public PlayerBridge(Activity activity, WebView web, PlayerView view) {
        this.activity = activity;
        this.web = web;
        this.view = view;
        view.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        // Subtitles are drawn by the web app (same style as the TV): cues go to JavaScript.
        if (view.getSubtitleView() != null) {
            view.getSubtitleView().setVisibility(View.GONE);
        }
        main.postDelayed(poll, 500);
    }

    private void event(String forSid, String type, Map<String, Object> extra) {
        try {
            JSONObject o = new JSONObject();
            o.put("sid", Integer.parseInt(forSid));
            o.put("type", type);
            if (extra != null) {
                for (Map.Entry<String, Object> e : extra.entrySet()) {
                    o.put(e.getKey(), e.getValue());
                }
            }
            final String js = "window.__elitePlayerEvent&&window.__elitePlayerEvent(" + JSONObject.quote(o.toString()) + ")";
            main.post(new Runnable() {
                @Override
                public void run() {
                    web.evaluateJavascript(js, null);
                }
            });
        } catch (Exception ignored) {
            // malformed sid: drop the event
        }
    }

    private static String codeOf(PlaybackException e) {
        int c = e.errorCode;
        if (c >= 2000 && c < 3000) {
            return "connection"; // IO errors: network, HTTP status, timeouts
        }
        if (c >= 3000 && c < 4000) {
            return "format"; // parsing
        }
        if (c >= 4000 && c < 5000) {
            return c == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED || c == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ? "unsupported" : "format";
        }
        return "unknown";
    }

    /** Buffer (ms) the current player was built with; -1 when there is no player. */
    private int playerBufferMs = -1;

    /**
     * CP2 F3: the buffer requested by the app (config player.liveBufferSec), with the same meaning as
     * AVPlay's PLAYER_BUFFER_FOR_PLAY / FOR_RESUME on the TV: media buffered before playback starts
     * and before it resumes after a stall. 0 = player defaults (2 s start, 3 s after a stall).
     */
    static int[] bufferDurations(int bufferMs) {
        int start = bufferMs > 0 ? Math.max(500, Math.min(15000, bufferMs)) : 2000;
        int resume = bufferMs > 0 ? start : 3000;
        return new int[] { 15000, 50000, start, resume };
    }

    private ExoPlayer ensurePlayer(int bufferMs) {
        if (player != null && bufferMs == playerBufferMs) {
            return player;
        }
        if (player != null) {
            // ExoPlayer's LoadControl is fixed per instance: rebuild only when the request changes.
            view.setPlayer(null);
            player.release();
            player = null;
        }
        int[] d = bufferDurations(bufferMs);
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(d[0], d[1], d[2], d[3])
                .build();
        playerBufferMs = bufferMs;
        player = new ExoPlayer.Builder(activity).setLoadControl(load).build();
        player.setPlayWhenReady(true);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                final String s = sid;
                if (state == Player.STATE_BUFFERING) {
                    Map<String, Object> m = new HashMap<>();
                    m.put("percent", 0);
                    event(s, "buffering", m);
                } else if (state == Player.STATE_READY) {
                    if (!prepared) {
                        prepared = true;
                        event(s, "prepared", null);
                    }
                    Map<String, Object> m = new HashMap<>();
                    m.put("percent", 100);
                    event(s, "buffering", m);
                } else if (state == Player.STATE_ENDED) {
                    event(s, "ended", null);
                }
            }

            @Override
            public void onRenderedFirstFrame() {
                if (!firstFrame) {
                    firstFrame = true;
                    event(sid, "firstFrame", null);
                }
            }

            @Override
            public void onTracksChanged(Tracks tracks) {
                tracksJson = describe(tracks);
                event(sid, "tracks", null);
            }

            @Override
            public void onCues(CueGroup cues) {
                StringBuilder b = new StringBuilder();
                for (Cue c : cues.cues) {
                    if (c.text != null && c.text.length() > 0) {
                        if (b.length() > 0) {
                            b.append('\n');
                        }
                        b.append(c.text.toString());
                    }
                }
                Map<String, Object> m = new HashMap<>();
                m.put("text", b.toString());
                event(sid, "subtitle", m);
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                Map<String, Object> m = new HashMap<>();
                m.put("code", codeOf(error));
                event(sid, "error", m);
            }
        });
        view.setPlayer(player);
        return player;
    }

    @JavascriptInterface
    public void load(final String newSid, final String url, final String type, final boolean live,
                     final String userAgent, final String referrer, final int bufferMs) {
        main.post(new Runnable() {
            @Override
            public void run() {
                ExoPlayer p = ensurePlayer(bufferMs);
                sid = newSid;
                prepared = false;
                firstFrame = false;
                posMs = 0;
                durMs = 0;
                p.stop();
                p.clearMediaItems();
                DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                        .setAllowCrossProtocolRedirects(true)
                        .setConnectTimeoutMs(15000)
                        .setReadTimeoutMs(20000);
                if (userAgent != null && userAgent.length() > 0) {
                    http.setUserAgent(userAgent);
                }
                if (referrer != null && referrer.length() > 0) {
                    Map<String, String> h = new HashMap<>();
                    h.put("Referer", referrer);
                    http.setDefaultRequestProperties(h);
                }
                MediaItem item = MediaItem.fromUri(Uri.parse(url));
                MediaSource src = "hls".equals(type) || url.contains(".m3u8")
                        ? new HlsMediaSource.Factory(http).createMediaSource(item)
                        : new ProgressiveMediaSource.Factory(http).createMediaSource(item);
                // Subtitles start off (as on the TV); the player screen can turn a track on.
                p.setTrackSelectionParameters(p.getTrackSelectionParameters().buildUpon()
                        .clearOverrides()
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                        .build());
                tracksJson = "[]";
                p.setMediaSource(src);
                p.prepare();
                p.play();
                applyRect();
            }
        });
    }

    @JavascriptInterface
    public void pause() {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (player != null) {
                    player.pause();
                }
            }
        });
    }

    @JavascriptInterface
    public void resume() {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (player != null) {
                    player.play();
                }
            }
        });
    }

    @JavascriptInterface
    public void stop() {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (player != null) {
                    player.stop();
                    player.clearMediaItems();
                }
                FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) view.getLayoutParams();
                lp.width = 0;
                lp.height = 0;
                view.setLayoutParams(lp);
            }
        });
    }

    /** Rectangle in the web app's 1920×1080 page coordinates. */
    @JavascriptInterface
    public void setRect(final double x, final double y, final double w, final double h) {
        main.post(new Runnable() {
            @Override
            public void run() {
                rx = (float) x;
                ry = (float) y;
                rw = (float) w;
                rh = (float) h;
                if (player != null && player.getPlaybackState() != Player.STATE_IDLE) {
                    applyRect();
                }
            }
        });
    }

    /** Same mapping as pageScale() in android-platform.ts: page scaled to the WebView width, then
     *  shrunk and centred when the screen is wider than 16:9. */
    private void applyRect() {
        float vw = web.getWidth();
        float vh = web.getHeight();
        if (vw <= 0 || vh <= 0) {
            vw = activity.getResources().getDisplayMetrics().widthPixels;
            vh = activity.getResources().getDisplayMetrics().heightPixels;
        }
        float fit = vw / 1920f;
        float k = Math.min(1f, vh / (1080f * fit));
        float px = fit * k;
        float dx = Math.max(0f, (vw - 1920f * px) / 2f);
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) view.getLayoutParams();
        lp.width = Math.round(rw * px);
        lp.height = Math.round(rh * px);
        lp.leftMargin = Math.round(dx + rx * px);
        lp.topMargin = Math.round(ry * px);
        view.setLayoutParams(lp);
    }

    @JavascriptInterface
    public void seekTo(final double ms) {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (player != null) {
                    player.seekTo((long) Math.max(0, ms));
                    posMs = (long) Math.max(0, ms);
                }
            }
        });
    }

    /** id = group index × 100 + track index within the group. */
    private static String describe(Tracks tracks) {
        JSONArray a = new JSONArray();
        try {
            int gi = 0;
            for (Tracks.Group g : tracks.getGroups()) {
                int type = g.getType();
                if (type == C.TRACK_TYPE_AUDIO || type == C.TRACK_TYPE_TEXT) {
                    for (int i = 0; i < g.length && i < 100; i++) {
                        if (!g.isTrackSupported(i)) {
                            continue;
                        }
                        Format f = g.getTrackFormat(i);
                        JSONObject o = new JSONObject();
                        o.put("kind", type == C.TRACK_TYPE_AUDIO ? "audio" : "text");
                        o.put("id", gi * 100 + i);
                        o.put("language", f.language != null ? f.language : "");
                        String label = f.label != null ? f.label : "";
                        if (type == C.TRACK_TYPE_AUDIO && f.channelCount > 0) {
                            String ch = f.channelCount >= 6 ? "5.1" : f.channelCount == 2 ? "Stereo" : f.channelCount == 1 ? "Mono" : "";
                            label = label.length() > 0 ? label + (ch.length() > 0 ? " · " + ch : "") : ch;
                        }
                        o.put("label", label);
                        o.put("selected", g.isTrackSelected(i));
                        a.put(o);
                    }
                }
                gi++;
            }
        } catch (Exception ignored) {
            // malformed format: keep what was collected
        }
        return a.toString();
    }

    @JavascriptInterface
    public String tracks() {
        return tracksJson;
    }

    @JavascriptInterface
    public void selectTrack(final String kind, final int id) {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (player == null) {
                    return;
                }
                TrackSelectionParameters.Builder b = player.getTrackSelectionParameters().buildUpon();
                if ("text".equals(kind) && id < 0) {
                    b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
                    player.setTrackSelectionParameters(b.build());
                    Map<String, Object> m = new HashMap<>();
                    m.put("text", "");
                    event(sid, "subtitle", m);
                    return;
                }
                int gi = id / 100;
                int ti = id % 100;
                java.util.List<Tracks.Group> groups = player.getCurrentTracks().getGroups();
                if (gi < 0 || gi >= groups.size()) {
                    return;
                }
                Tracks.Group g = groups.get(gi);
                if (ti >= g.length) {
                    return;
                }
                b.setOverrideForType(new TrackSelectionOverride(g.getMediaTrackGroup(), ti));
                if (g.getType() == C.TRACK_TYPE_TEXT) {
                    b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false);
                }
                player.setTrackSelectionParameters(b.build());
            }
        });
    }

    @JavascriptInterface
    public double positionMs() {
        return posMs;
    }

    @JavascriptInterface
    public double durationMs() {
        return durMs;
    }

    public void release() {
        main.removeCallbacks(poll);
        if (player != null) {
            player.release();
            player = null;
        }
    }
}
