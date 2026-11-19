package com.vtv.grid;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
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

    // ---------- Hình nền: chọn ngẫu nhiên 1 ảnh trong thư mục (cùng thư mục với channels.txt), mỗi lần khởi động chọn lại ----------
    private String bgStamp = "";
    private String bgUri = "";
    private File bgChosen = null;

    private static boolean isImage(File f) {
        String n = f.getName().toLowerCase(java.util.Locale.ROOT);
        return f.isFile() && f.length() > 0 && !n.startsWith(".")
                && (n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png") || n.endsWith(".webp"));
    }

    /** Chọn ngẫu nhiên 1 ảnh một lần cho mỗi lần chạy app (chọn lại mỗi lần vào lại launcher: khởi động, bấm Home, thoát khỏi app khác). Không có ảnh -> null. */
    private File bgFile() {
        if (bgChosen != null && isImage(bgChosen)) return bgChosen;
        File dir = getExternalFilesDir(null);
        if (dir == null) dir = getFilesDir();
        File[] all = dir.listFiles();
        java.util.ArrayList<File> imgs = new java.util.ArrayList<File>();
        if (all != null) {
            for (int i = 0; i < all.length; i++) if (isImage(all[i])) imgs.add(all[i]);
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

    /** Đọc lại hình nền khi file thay đổi (tên + ngày sửa + dung lượng). Thu nhỏ về tối đa 1920px (vừa khít TV Full HD). */
    private synchronized void loadBg() {
        File f = bgFile();
        if (f == null) {
            bgStamp = "";
            bgUri = "";
            return;
        }
        String st = f.getName() + ":" + f.lastModified() + ":" + f.length();
        if (st.equals(bgStamp)) return;
        bgStamp = st;
        bgUri = "";
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getAbsolutePath(), o);
            int sample = 1;
            while (o.outWidth / (sample * 2) >= 1920 && o.outHeight / (sample * 2) >= 1080) sample *= 2;
            o.inJustDecodeBounds = false;
            o.inSampleSize = sample;
            Bitmap b = BitmapFactory.decodeFile(f.getAbsolutePath(), o);
            if (b == null) return;
            if (b.getWidth() > 1920) {
                float r = 1920f / b.getWidth();
                b = Bitmap.createScaledBitmap(b, 1920, Math.max(1, Math.round(b.getHeight() * r)), true);
            }
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.JPEG, 90, bo);
            bgUri = "data:image/jpeg;base64," + Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable t) {
            bgUri = "";
        }
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

        /** JSON {"label":"...","color":"#RRGGBB"} của ô ứng dụng nhanh, hoặc chuỗi rỗng nếu ô trống. */
        @JavascriptInterface
        public String getQuickApp(int slot) {
            try {
                String[] q = AppsActivity.getQuick(MainActivity.this, slot);
                if (q == null) return "";
                return new org.json.JSONObject()
                        .put("label", AppsActivity.quickLabel(MainActivity.this, q))
                        .put("color", AppsActivity.quickColor(MainActivity.this, q))
                        .toString();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String getQuickIcon(int slot) {
            String[] q = AppsActivity.getQuick(MainActivity.this, slot);
            return q == null ? "" : AppsActivity.quickIconData(MainActivity.this, q);
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
            bgChosen = null; // chọn lại ảnh nền ngẫu nhiên
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
        bgChosen = null; // vào lại launcher: chọn lại ảnh nền ngẫu nhiên
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
