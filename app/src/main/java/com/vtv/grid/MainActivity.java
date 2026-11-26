package com.vtv.grid;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.tv.TvContract;
import android.media.tv.TvInputInfo;
import android.media.tv.TvInputManager;
import android.os.Build;
import android.util.Base64;
import android.provider.Settings;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {

    private WebView web;
    private String webUa = "";
    private boolean resumed = false;
    private boolean homePending = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Khung chứa nền đen; WebView luôn giữ tỉ lệ 16:9 và nằm giữa (điện thoại màn hình dài sẽ có viền đen, không bị cắt)
        final FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        web = new WebView(this);
        web.setBackgroundColor(0xFF000000);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        setContentView(root);
        root.addOnLayoutChangeListener(new View.OnLayoutChangeListener() {
            @Override
            public void onLayoutChange(View v, int l, int t, int r, int b,
                                       int ol, int ot, int or, int ob) {
                fitWeb(r - l, b - t);
            }
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        webUa = s.getUserAgentString();

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        // Chuẩn bị hình nền ở luồng nền ngay khi khởi động để trang chủ lên nhanh
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    loadBg();
                } catch (Throwable ignored) {
                }
            }
        }).start();
        web.loadUrl("file:///android_asset/index.html");
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.requestFocus();
    }

    private void fitWeb(int w, int h) {
        if (w <= 0 || h <= 0) return;
        int tw = w;
        int th = w * 9 / 16;
        if (th > h) {
            th = h;
            tw = h * 16 / 9;
        }
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) web.getLayoutParams();
        if (lp.width != tw || lp.height != th) {
            lp.width = tw;
            lp.height = th;
            lp.gravity = Gravity.CENTER;
            web.setLayoutParams(lp);
        }
    }

    /** File channels.txt nằm ở: Android/data/com.vtv.grid.v2/files/channels.txt trong bộ nhớ trong của box. */
    private File channelFile() {
        File dir = getExternalFilesDir(null);
        if (dir == null) dir = getFilesDir();
        return new File(dir, "channels.txt");
    }

    /** Lần chạy đầu chưa có file: chép file mẫu ra để người dùng thấy đúng thư mục cần đặt file. */
    private void ensureSampleFile() {
        File f = channelFile();
        if (f.exists()) return;
        try {
            InputStream in = getAssets().open("channels.txt");
            OutputStream out = new FileOutputStream(f);
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.close();
            in.close();
        } catch (Exception ignored) {
        }
    }

    // ---------- Hình nền: chọn ngẫu nhiên 1 ảnh trong thư mục (cùng thư mục với channels.txt), chỉ chọn lại khi launcher khởi động lại ----------
    private String bgStamp = "";
    private String bgUri = "";
    private File bgChosen = null;
    private final java.util.HashSet<String> bgBad = new java.util.HashSet<String>();

    private static final int BG_W = 1920; // vừa khít TV Full HD
    private static final int BG_H = 1080;

    private static boolean isImage(File f) {
        String n = f.getName().toLowerCase(java.util.Locale.ROOT);
        return f.isFile() && f.length() > 0 && !n.startsWith(".")
                && (n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png") || n.endsWith(".webp"));
    }

    /** Chọn ngẫu nhiên 1 ảnh, giữ nguyên suốt lần chạy này của app. Không có ảnh -> null. */
    private File bgFile() {
        if (bgChosen != null && isImage(bgChosen)) return bgChosen;
        File dir = getExternalFilesDir(null);
        if (dir == null) dir = getFilesDir();
        File[] all = dir.listFiles();
        java.util.ArrayList<File> imgs = new java.util.ArrayList<File>();
        if (all != null) {
            for (int i = 0; i < all.length; i++) {
                if (isImage(all[i]) && !bgBad.contains(all[i].getName())) imgs.add(all[i]);
            }
        }
        if (imgs.isEmpty()) {
            bgChosen = null;
            return null;
        }
        // Tránh trùng ảnh của lần chạy trước (nếu có từ 2 ảnh trở lên)
        android.content.SharedPreferences sp = getSharedPreferences("bg", MODE_PRIVATE);
        String last = sp.getString("last", "");
        if (imgs.size() > 1) {
            for (int i = 0; i < imgs.size(); i++) {
                if (imgs.get(i).getName().equals(last)) {
                    imgs.remove(i);
                    break;
                }
            }
        }
        bgChosen = imgs.get(new java.util.Random().nextInt(imgs.size()));
        sp.edit().putString("last", bgChosen.getName()).apply();
        return bgChosen;
    }

    /**
     * Trả về file ảnh để WebView đọc thẳng (không qua base64):
     * ảnh đã vừa cỡ Full HD thì dùng nguyên bản gốc (không nén lại, giữ nguyên chất lượng);
     * ảnh lớn hơn thì thu về tối đa 1920px một lần duy nhất rồi lưu vào bộ nhớ đệm để các lần sau dùng lại.
     */
    private File prepareBg(File f) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getAbsolutePath(), o);
        if (o.outWidth <= 0 || o.outHeight <= 0) return null;
        if (o.outWidth <= BG_W && o.outHeight <= 1200) return f;

        String key = Integer.toHexString((f.getName() + ":" + f.lastModified() + ":" + f.length()).hashCode());
        File out = new File(getCacheDir(), "bg_" + key + ".jpg");
        if (out.isFile() && out.length() > 0) return out;

        int sample = 1;
        while (o.outWidth / (sample * 2) >= BG_W && o.outHeight / (sample * 2) >= BG_H) sample *= 2;
        o.inJustDecodeBounds = false;
        o.inSampleSize = sample;
        Bitmap b = BitmapFactory.decodeFile(f.getAbsolutePath(), o);
        if (b == null) return null;
        if (b.getWidth() > BG_W) {
            float r = (float) BG_W / b.getWidth();
            Bitmap sc = Bitmap.createScaledBitmap(b, BG_W, Math.max(1, Math.round(b.getHeight() * r)), true);
            if (sc != b) b.recycle();
            b = sc;
        }
        File tmp = new File(getCacheDir(), "bg_" + key + ".tmp");
        FileOutputStream fo = null;
        try {
            fo = new FileOutputStream(tmp);
            b.compress(Bitmap.CompressFormat.JPEG, 92, fo);
            fo.close();
            fo = null;
            if (!tmp.renameTo(out)) return null;
            return out;
        } catch (Throwable t) {
            return null;
        } finally {
            if (fo != null) try { fo.close(); } catch (Exception ignored) { }
            b.recycle();
            if (tmp.exists()) tmp.delete();
        }
    }

    /** Chuẩn bị hình nền (chạy 1 lần khi khởi động; các lần gọi sau chỉ so dấu hiệu rồi thoát ngay). */
    private synchronized void loadBg() {
        File f = bgFile();
        if (f == null) {
            bgStamp = "";
            bgUri = "";
            return;
        }
        String st = f.getName() + ":" + f.lastModified() + ":" + f.length();
        if (st.equals(bgStamp)) return;
        File use = null;
        try {
            use = prepareBg(f);
        } catch (Throwable ignored) {
        }
        if (use == null) {
            // Ảnh hỏng/không đọc được: bỏ ảnh này, lần sau chọn ảnh khác (hoặc về nền mặc định nếu hết ảnh)
            bgBad.add(f.getName());
            bgChosen = null;
            bgStamp = "";
            bgUri = "";
            return;
        }
        bgStamp = st;
        bgUri = android.net.Uri.fromFile(use).toString();
    }

    private class Bridge {
        @JavascriptInterface
        public String readChannels() {
            try {
                ensureSampleFile();
                InputStream in = new java.io.FileInputStream(channelFile());
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                in.close();
                return bo.toString("UTF-8");
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String getPath() {
            return channelFile().getAbsolutePath();
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
        }

        /** true nếu app này đang là launcher mặc định (khi đó phím Back ở màn hình chọn kênh không thoát app). */
        @JavascriptInterface
        public boolean isDefaultHome() {
            try {
                Intent h = new Intent(Intent.ACTION_MAIN);
                h.addCategory(Intent.CATEGORY_HOME);
                ResolveInfo ri = getPackageManager().resolveActivity(h, PackageManager.MATCH_DEFAULT_ONLY);
                return ri != null && ri.activityInfo != null && getPackageName().equals(ri.activityInfo.packageName);
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    } catch (Exception e) {
                        android.widget.Toast.makeText(MainActivity.this, "Không mở được Cài đặt", android.widget.Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        /**
         * Danh sách cổng vào (HDMI, AV, VGA, USB... nếu TV khai báo) dạng JSON:
         * [{"id":"...","label":"HDMI 1","state":2}], state: 2 = có tín hiệu, 1 = đang chờ, 0 = chưa có tín hiệu, -1 = không rõ.
         * Cổng có tín hiệu được xếp lên đầu.
         */
        @JavascriptInterface
        public String getInputs() {
            org.json.JSONArray arr = new org.json.JSONArray();
            try {
                TvInputManager tm = (TvInputManager) getSystemService(Context.TV_INPUT_SERVICE);
                if (tm == null) return "[]";
                java.util.List<TvInputInfo> all = tm.getTvInputList();
                final java.util.ArrayList<org.json.JSONObject> items = new java.util.ArrayList<org.json.JSONObject>();
                if (all != null) {
                    for (int i = 0; i < all.size(); i++) {
                        TvInputInfo info = all.get(i);
                        try {
                            if (!info.isPassthroughInput()) continue; // chỉ lấy cổng vào, bỏ dò kênh/ứng dụng TV
                            CharSequence custom = info.loadCustomLabel(MainActivity.this);
                            CharSequence std = info.loadLabel(MainActivity.this);
                            String name = (custom != null && custom.toString().trim().length() > 0) ? custom.toString().trim()
                                    : (std != null ? std.toString().trim() : "");
                            if (name.length() == 0) name = info.getId();
                            int state = -1;
                            if (Build.VERSION.SDK_INT >= 23) {
                                try {
                                    state = tm.getInputState(info.getId());
                                    if (state == TvInputManager.INPUT_STATE_CONNECTED) state = 2;
                                    else if (state == TvInputManager.INPUT_STATE_CONNECTED_STANDBY) state = 1;
                                    else state = 0;
                                } catch (Throwable t) {
                                    state = -1;
                                }
                            }
                            items.add(new org.json.JSONObject()
                                    .put("id", info.getId())
                                    .put("label", name)
                                    .put("state", state));
                        } catch (Throwable ignored) {
                        }
                    }
                }
                // Xếp ổn định: có tín hiệu -> đang chờ -> không rõ -> chưa có tín hiệu
                java.util.Collections.sort(items, new java.util.Comparator<org.json.JSONObject>() {
                    private int rank(org.json.JSONObject o) {
                        int st = o.optInt("state", -1);
                        return st == 2 ? 0 : (st == 1 ? 1 : (st == -1 ? 2 : 3));
                    }

                    @Override
                    public int compare(org.json.JSONObject a, org.json.JSONObject b) {
                        return rank(a) - rank(b);
                    }
                });
                for (int i = 0; i < items.size(); i++) arr.put(items.get(i));
            } catch (Throwable t) {
                return "[]";
            }
            return arr.toString();
        }

        /**
         * Chuyển TV sang cổng vào đã chọn. builtin = true: xem thẳng trong launcher (SourceActivity);
         * builtin = false: nhờ ứng dụng TV của hệ thống, nếu máy không có/không nhận thì tự dùng SourceActivity.
         */
        @JavascriptInterface
        public void openInput(final String inputId, final String label, final boolean builtin) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!builtin) {
                        try {
                            Intent i = new Intent(Intent.ACTION_VIEW, TvContract.buildChannelUriForPassthroughInput(inputId));
                            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(i);
                            return;
                        } catch (Throwable ignored) {
                            // rơi xuống chế độ dự phòng bên dưới
                        }
                    }
                    try {
                        startActivity(new Intent(MainActivity.this, SourceActivity.class)
                                .putExtra(SourceActivity.EXTRA_ID, inputId)
                                .putExtra(SourceActivity.EXTRA_LABEL, label == null ? "" : label));
                    } catch (Throwable e) {
                        android.widget.Toast.makeText(MainActivity.this,
                                "Không chuyển được nguồn này. Thử nút INPUT/SOURCE trên remote.",
                                android.widget.Toast.LENGTH_LONG).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void openApps() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startActivity(new Intent(MainActivity.this, AppsActivity.class));
                }
            });
        }

        /** Mở danh sách ứng dụng ở chế độ chọn cho ô ứng dụng nhanh số slot (0..5). */
        @JavascriptInterface
        public void pickQuick(final int slot) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startActivity(new Intent(MainActivity.this, AppsActivity.class)
                            .putExtra(AppsActivity.EXTRA_PICK, true)
                            .putExtra(AppsActivity.EXTRA_SLOT, slot));
                }
            });
        }

        // Nhớ nhãn/màu/icon của ô nhanh theo ứng dụng để mỗi lần quay về launcher không phải tính lại
        private final java.util.concurrent.ConcurrentHashMap<String, String> quickInfoCache =
                new java.util.concurrent.ConcurrentHashMap<String, String>();
        private final java.util.concurrent.ConcurrentHashMap<String, String> quickIconCache =
                new java.util.concurrent.ConcurrentHashMap<String, String>();

        /** JSON {"label":"...","color":"#RRGGBB"} của ô ứng dụng nhanh, hoặc chuỗi rỗng nếu ô trống. */
        @JavascriptInterface
        public String getQuickApp(int slot) {
            try {
                String[] q = AppsActivity.getQuick(MainActivity.this, slot);
                if (q == null) return "";
                String key = q[0] + "/" + q[1];
                String hit = quickInfoCache.get(key);
                if (hit != null) return hit;
                String v = new org.json.JSONObject()
                        .put("label", AppsActivity.quickLabel(MainActivity.this, q))
                        .put("color", AppsActivity.quickColor(MainActivity.this, q))
                        .toString();
                quickInfoCache.put(key, v);
                return v;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String getQuickIcon(int slot) {
            String[] q = AppsActivity.getQuick(MainActivity.this, slot);
            if (q == null) return "";
            String key = q[0] + "/" + q[1];
            String hit = quickIconCache.get(key);
            if (hit != null) return hit;
            String v = AppsActivity.quickIconData(MainActivity.this, q);
            if (v != null && v.length() > 0) quickIconCache.put(key, v);
            return v == null ? "" : v;
        }

        @JavascriptInterface
        public void launchQuick(final int slot) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    String[] q = AppsActivity.getQuick(MainActivity.this, slot);
                    if (q != null) AppsActivity.launch(MainActivity.this, q[0], q[1]);
                }
            });
        }

        /**
         * Gọi API (POST JSON) bằng Java, không qua WebView nên không bị ràng buộc CORS / phiên bản WebView.
         * Kết quả trả về trang web qua window.nativeApiResult(token, mãHTTP, nộiDung, lỗi); mãHTTP = 0 nếu lỗi mạng.
         */
        @JavascriptInterface
        public void apiPost(final String token, final String url, final String body) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    int status = 0;
                    String text = "";
                    String err = "";
                    java.net.HttpURLConnection c = null;
                    try {
                        c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                        c.setRequestMethod("POST");
                        c.setConnectTimeout(8000);
                        c.setReadTimeout(12000);
                        c.setDoOutput(true);
                        c.setRequestProperty("Content-Type", "application/json");
                        c.setRequestProperty("Accept", "application/json, text/plain, */*");
                        if (webUa != null && webUa.length() > 0) c.setRequestProperty("User-Agent", webUa);
                        OutputStream os = c.getOutputStream();
                        os.write(body.getBytes("UTF-8"));
                        os.close();
                        status = c.getResponseCode();
                        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                        if (in != null) {
                            ByteArrayOutputStream bo = new ByteArrayOutputStream();
                            byte[] buf = new byte[4096];
                            int n;
                            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                            in.close();
                            text = bo.toString("UTF-8");
                        }
                    } catch (Throwable t) {
                        status = 0;
                        err = t.getClass().getSimpleName() + (t.getMessage() != null ? ": " + t.getMessage() : "");
                    } finally {
                        if (c != null) c.disconnect();
                    }
                    final String call = "window.nativeApiResult&&window.nativeApiResult("
                            + org.json.JSONObject.quote(token) + "," + status + ","
                            + org.json.JSONObject.quote(text) + "," + org.json.JSONObject.quote(err) + ")";
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            js(call);
                        }
                    });
                }
            }).start();
        }

        /** Dấu hiệu nhận biết hình nền (rỗng nếu thư mục không có ảnh); đổi khi file thay đổi. */
        @JavascriptInterface
        public String getBackgroundStamp() {
            loadBg();
            return bgStamp;
        }

        @JavascriptInterface
        public String getBackground() {
            loadBg();
            return bgUri;
        }
    }

    private void js(String code) {
        web.evaluateJavascript(code, null);
    }

    /** Đổi mã phím Android sang mã phím web (keyCode của JavaScript); 0 nếu không phải phím cần chuyển. */
    private static int toWebKey(int k) {
        switch (k) {
            case KeyEvent.KEYCODE_DPAD_UP: return 38;
            case KeyEvent.KEYCODE_DPAD_DOWN: return 40;
            case KeyEvent.KEYCODE_DPAD_LEFT: return 37;
            case KeyEvent.KEYCODE_DPAD_RIGHT: return 39;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER: return 13;
            case KeyEvent.KEYCODE_MENU: return 82;
            case KeyEvent.KEYCODE_PAGE_UP: return 33;
            case KeyEvent.KEYCODE_PAGE_DOWN: return 34;
        }
        if (k >= KeyEvent.KEYCODE_0 && k <= KeyEvent.KEYCODE_9) return 48 + (k - KeyEvent.KEYCODE_0);
        if (k >= KeyEvent.KEYCODE_NUMPAD_0 && k <= KeyEvent.KEYCODE_NUMPAD_9) return 48 + (k - KeyEvent.KEYCODE_NUMPAD_0);
        return 0;
    }

    // Phím Back và CH+/CH- được xử lý ở đây rồi chuyển vào trang web; các phím khác (mũi tên, OK, số) WebView tự nhận.
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (k == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP) js("window.nativeBack&&window.nativeBack()");
            return true;
        }
        int wk = toWebKey(k);
        if (wk > 0) {
            int act = e.getAction();
            if (act == KeyEvent.ACTION_DOWN) {
                js("window.nativeKey&&window.nativeKey(true," + wk + "," + (e.getRepeatCount() > 0) + ")");
            } else if (act == KeyEvent.ACTION_UP) {
                js("window.nativeKey&&window.nativeKey(false," + wk + ",false)");
            }
            return true;
        }
        if (k == KeyEvent.KEYCODE_CHANNEL_UP || k == KeyEvent.KEYCODE_CHANNEL_DOWN) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) {
                js("window.nativeZap&&window.nativeZap(" + (k == KeyEvent.KEYCODE_CHANNEL_UP ? 1 : -1) + ")");
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        web.onPause();
    }

    /** Bấm phím Home (khi app là launcher): về màn hình chọn kênh. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && Intent.ACTION_MAIN.equals(intent.getAction())
                && intent.hasCategory(Intent.CATEGORY_HOME)) {
            if (resumed) {
                js("window.nativeHome&&window.nativeHome()");
            } else {
                homePending = true; // đang ở nền: chờ onResume rồi mới chạy
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        web.onResume();
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.requestFocus();
        js("window.nativeRefresh&&window.nativeRefresh()");
        if (homePending) {
            homePending = false;
            js("window.nativeHome&&window.nativeHome()");
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("AndroidBridge");
            web.destroy();
        }
        super.onDestroy();
    }
}
