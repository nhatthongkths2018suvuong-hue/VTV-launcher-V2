package com.vtv.grid;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AbsListView;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.GridView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Danh sách tất cả ứng dụng đã cài.
 * - Chế độ thường: OK để mở app, giữ OK (hoặc chạm giữ) để đặt làm "ứng dụng nhanh".
 * - Chế độ chọn (extra "pick" = true): OK để chọn app làm "ứng dụng nhanh" rồi quay về.
 */
public class AppsActivity extends Activity {

    static final String EXTRA_PICK = "pick";
    static final String EXTRA_SLOT = "slot";
    static final int SLOTS = 6;
    private static final String PREFS = "launcher";
    private static final String K_PKG = "quick_pkg";   // khoá cũ (chỉ 1 ô): chuyển sang ô 1
    private static final String K_CLS = "quick_cls";

    static class Item {
        String label;
        String pkg;
        String cls;
        Drawable icon;
    }

    // ---------- Dùng chung với MainActivity ----------

    private static String kp(int slot) {
        return "quick_pkg_" + slot;
    }

    private static String kc(int slot) {
        return "quick_cls_" + slot;
    }

    private static void migrate(SharedPreferences sp) {
        if (sp.contains(K_PKG) && !sp.contains(kp(0))) {
            sp.edit().putString(kp(0), sp.getString(K_PKG, null))
                    .putString(kc(0), sp.getString(K_CLS, null))
                    .remove(K_PKG).remove(K_CLS).apply();
        }
    }

    static void saveQuick(Context c, int slot, String pkg, String cls) {
        SharedPreferences sp = c.getSharedPreferences(PREFS, MODE_PRIVATE);
        migrate(sp);
        sp.edit().putString(kp(slot), pkg).putString(kc(slot), cls).apply();
    }

    /** Trả về {pkg, cls} của ô ứng dụng nhanh số slot (0..5), hoặc null nếu trống / app đã bị gỡ. */
    static String[] getQuick(Context c, int slot) {
        if (slot < 0 || slot >= SLOTS) return null;
        SharedPreferences sp = c.getSharedPreferences(PREFS, MODE_PRIVATE);
        migrate(sp);
        String pkg = sp.getString(kp(slot), null);
        String cls = sp.getString(kc(slot), null);
        if (pkg == null || cls == null) return null;
        try {
            c.getPackageManager().getActivityInfo(new ComponentName(pkg, cls), 0);
        } catch (Exception e) {
            return null;
        }
        return new String[]{pkg, cls};
    }

    static String quickLabel(Context c, String[] q) {
        try {
            PackageManager pm = c.getPackageManager();
            ActivityInfo ai = pm.getActivityInfo(new ComponentName(q[0], q[1]), 0);
            return ai.loadLabel(pm).toString();
        } catch (Exception e) {
            return q[0];
        }
    }

    private static Bitmap quickBitmap(Context c, String[] q, int size) throws PackageManager.NameNotFoundException {
        PackageManager pm = c.getPackageManager();
        Drawable d = pm.getActivityInfo(new ComponentName(q[0], q[1]), 0).loadIcon(pm);
        return ColorUtil.fromDrawable(d, size);
    }

    /** Biểu tượng của ứng dụng nhanh dạng data URI (PNG 96x96) để hiện trong trang web. */
    static String quickIconData(Context c, String[] q) {
        try {
            Bitmap b = quickBitmap(c, q, 96);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.PNG, 100, bo);
            return "data:image/png;base64," + Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable t) {
            return "";
        }
    }

    /** Màu nền ô theo tông màu chủ đạo của icon, dạng "#RRGGBB" (rỗng nếu không tính được). */
    static String quickColor(Context c, String[] q) {
        try {
            return ColorUtil.hex(ColorUtil.tileColor(quickBitmap(c, q, 96)));
        } catch (Throwable t) {
            return "";
        }
    }

    static boolean launch(Context c, String pkg, String cls) {
        try {
            Intent i = new Intent(Intent.ACTION_MAIN);
            i.setComponent(new ComponentName(pkg, cls));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            c.startActivity(i);
            return true;
        } catch (Exception e) {
            Toast.makeText(c, "Không mở được ứng dụng này", Toast.LENGTH_SHORT).show();
            return false;
        }
    }

    // ---------- Giao diện ----------

    private boolean pick;
    private int pickSlot;
    private final List<Item> items = new ArrayList<Item>();
    private GridView grid;
    private BaseAdapter adapter;

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pick = getIntent().getBooleanExtra(EXTRA_PICK, false);
        pickSlot = getIntent().getIntExtra(EXTRA_SLOT, 0);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.BLACK);

        TextView title = new TextView(this);
        title.setText(pick ? "Chọn ứng dụng cho ô nhanh " + (pickSlot + 1) : "Ứng dụng");
        title.setTextColor(Color.WHITE);
        title.setTextSize(26);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setGravity(Gravity.CENTER_VERTICAL);
        title.setPadding(dp(30), 0, dp(30), 0);
        title.setBackgroundColor(0xFF0B2A55);
        root.addView(title, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56)));

        grid = new GridView(this);
        grid.setColumnWidth(dp(150));
        grid.setFocusable(true);
        grid.setFocusableInTouchMode(true);
        grid.setNumColumns(GridView.AUTO_FIT);
        grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);
        grid.setHorizontalSpacing(dp(10));
        grid.setVerticalSpacing(dp(10));
        grid.setPadding(dp(20), dp(14), dp(20), dp(14));
        grid.setClipToPadding(false);
        grid.setDrawSelectorOnTop(true);
        GradientDrawable sel = new GradientDrawable();
        sel.setColor(0x552457A8);
        sel.setStroke(dp(3), 0xFFFFD400);
        grid.setSelector(sel);
        adapter = new AppAdapter();
        grid.setAdapter(adapter);
        root.addView(grid, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        TextView hint = new TextView(this);
        hint.setText(pick ? "OK: chọn  |  Back: huỷ" : "OK: mở ứng dụng  |  Giữ OK: gán vào ô ứng dụng nhanh  |  Back: quay lại");
        hint.setTextColor(0xFF9DB7DD);
        hint.setTextSize(15);
        hint.setGravity(Gravity.CENTER);
        root.addView(hint, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(34)));

        setContentView(root);

        grid.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                Item it = items.get(position);
                if (pick) {
                    choose(it);
                } else {
                    launch(AppsActivity.this, it.pkg, it.cls);
                }
            }
        });
        grid.setOnItemLongClickListener(new AdapterView.OnItemLongClickListener() {
            @Override
            public boolean onItemLongClick(AdapterView<?> parent, View view, int position, long id) {
                Item it = items.get(position);
                if (pick) {
                    choose(it);
                } else {
                    chooseSlot(it);
                }
                return true;
            }
        });

        loadAsync();
    }

    /** Chế độ chọn: gán thẳng vào ô đã định rồi quay về. */
    private void choose(Item it) {
        saveQuick(this, pickSlot, it.pkg, it.cls);
        Toast.makeText(this, "Đã đặt \"" + it.label + "\" vào ô nhanh " + (pickSlot + 1), Toast.LENGTH_SHORT).show();
        finish();
    }

    /** Chế độ thường: hỏi muốn gán ứng dụng vào ô nhanh nào. */
    private void chooseSlot(final Item it) {
        CharSequence[] names = new CharSequence[SLOTS];
        for (int i = 0; i < SLOTS; i++) {
            String[] q = getQuick(this, i);
            names[i] = "Ô " + (i + 1) + ": " + (q == null ? "(trống)" : quickLabel(this, q));
        }
        new AlertDialog.Builder(this)
                .setTitle("Đặt \"" + it.label + "\" vào ô nào?")
                .setItems(names, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        saveQuick(AppsActivity.this, which, it.pkg, it.cls);
                        Toast.makeText(AppsActivity.this, "Đã đặt \"" + it.label + "\" vào ô nhanh " + (which + 1), Toast.LENGTH_SHORT).show();
                    }
                })
                .show();
    }

    private void loadAsync() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                PackageManager pm = getPackageManager();
                Map<String, Item> map = new LinkedHashMap<String, Item>();
                // Ưu tiên bản dành cho TV (leanback), sau đó đến bản launcher thường
                String[] cats = {Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER};
                for (int c = 0; c < cats.length; c++) {
                    Intent q = new Intent(Intent.ACTION_MAIN);
                    q.addCategory(cats[c]);
                    List<ResolveInfo> list = pm.queryIntentActivities(q, 0);
                    for (int i = 0; i < list.size(); i++) {
                        ResolveInfo ri = list.get(i);
                        ActivityInfo ai = ri.activityInfo;
                        if (ai == null || ai.packageName.equals(getPackageName())) continue;
                        if (map.containsKey(ai.packageName)) continue;
                        Item it = new Item();
                        it.pkg = ai.packageName;
                        it.cls = ai.name;
                        try {
                            it.label = ri.loadLabel(pm).toString();
                        } catch (Exception e) {
                            it.label = ai.packageName;
                        }
                        try {
                            it.icon = ri.loadIcon(pm);
                        } catch (Exception e) {
                            it.icon = null;
                        }
                        map.put(ai.packageName, it);
                    }
                }
                final List<Item> result = new ArrayList<Item>(map.values());
                Collections.sort(result, new Comparator<Item>() {
                    @Override
                    public int compare(Item a, Item b) {
                        return a.label.compareToIgnoreCase(b.label);
                    }
                });
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        items.clear();
                        items.addAll(result);
                        adapter.notifyDataSetChanged();
                        grid.requestFocus();
                        if (!items.isEmpty()) grid.setSelection(0);
                    }
                });
            }
        }).start();
    }

    private class AppAdapter extends BaseAdapter {
        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public Object getItem(int position) {
            return items.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            LinearLayout v;
            ImageView iv;
            TextView tv;
            if (convertView == null) {
                v = new LinearLayout(AppsActivity.this);
                v.setOrientation(LinearLayout.VERTICAL);
                v.setGravity(Gravity.CENTER);
                v.setPadding(dp(8), dp(8), dp(8), dp(8));
                GradientDrawable bg = new GradientDrawable();
                bg.setColor(0xFF12233F);
                bg.setStroke(dp(2), 0xFF1D3E73);
                v.setBackgroundDrawable(bg);
                v.setLayoutParams(new AbsListView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(128)));

                iv = new ImageView(AppsActivity.this);
                iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
                v.addView(iv, new LinearLayout.LayoutParams(dp(64), dp(64)));

                tv = new TextView(AppsActivity.this);
                tv.setTextColor(Color.WHITE);
                tv.setTextSize(15);
                tv.setGravity(Gravity.CENTER);
                tv.setMaxLines(2);
                tv.setEllipsize(TextUtils.TruncateAt.END);
                LinearLayout.LayoutParams tl = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                tl.topMargin = dp(6);
                v.addView(tv, tl);
                v.setTag(new View[]{iv, tv});
            } else {
                v = (LinearLayout) convertView;
            }
            View[] tag = (View[]) v.getTag();
            iv = (ImageView) tag[0];
            tv = (TextView) tag[1];
            Item it = items.get(position);
            iv.setImageDrawable(it.icon);
            tv.setText(it.label);
            return v;
        }
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
}
