package com.vtv.grid;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.tv.TvContract;
import android.media.tv.TvView;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Chế độ dự phòng: tự xem tín hiệu của một cổng vào (HDMI/AV...) ngay trong launcher bằng TvView,
 * dùng khi ứng dụng TV của hãng không nhận lệnh chuyển nguồn. Bấm Back để quay về launcher.
 */
public class SourceActivity extends Activity {

    public static final String EXTRA_ID = "inputId";
    public static final String EXTRA_LABEL = "label";

    private TvView tv;
    private TextView status;
    private String inputId;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        inputId = getIntent().getStringExtra(EXTRA_ID);
        String label = getIntent().getStringExtra(EXTRA_LABEL);
        if (label == null) label = "";

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        tv = new TvView(this);
        root.addView(tv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(26);
        status.setTypeface(Typeface.DEFAULT_BOLD);
        status.setGravity(Gravity.CENTER);
        status.setShadowLayer(6, 0, 2, Color.BLACK);
        status.setText(label + "\nĐang chờ tín hiệu...");
        root.addView(status, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        setContentView(root);

        final String lb = label;
        tv.setCallback(new TvView.TvInputCallback() {
            @Override
            public void onConnectionFailed(String id) {
                Toast.makeText(SourceActivity.this,
                        "TV không cho ứng dụng này xem cổng vào. Hãy dùng nút INPUT/SOURCE trên remote hoặc trên thân TV.",
                        Toast.LENGTH_LONG).show();
                finish();
            }

            @Override
            public void onVideoAvailable(String id) {
                status.setVisibility(View.GONE);
            }

            @Override
            public void onVideoUnavailable(String id, int reason) {
                status.setText(lb + "\nChưa có tín hiệu");
                status.setVisibility(View.VISIBLE);
            }
        });

        tv.post(new Runnable() {
            @Override
            public void run() {
                try {
                    tv.tune(inputId, TvContract.buildChannelUriForPassthroughInput(inputId));
                    tv.setStreamVolume(1.0f);
                } catch (Throwable t) {
                    Toast.makeText(SourceActivity.this, "Không mở được cổng vào này", Toast.LENGTH_LONG).show();
                    finish();
                }
            }
        });
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
    protected void onDestroy() {
        try { tv.reset(); } catch (Throwable ignored) { }
        super.onDestroy();
    }
}
