package com.vtv.grid;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;

/** Tính màu chủ đạo của một ảnh và chuẩn hoá thành màu nền ô (đủ tối để chữ trắng dễ đọc). */
final class ColorUtil {

    private ColorUtil() {
    }

    /** Vẽ drawable (icon ứng dụng) ra bitmap vuông. */
    static Bitmap fromDrawable(Drawable d, int size) {
        Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(b);
        d.setBounds(0, 0, size, size);
        d.draw(cv);
        return b;
    }

    /**
     * Màu nền ô theo tông màu chủ đạo của bitmap:
     * gom các điểm ảnh theo 12 nhóm sắc độ (bỏ điểm xám/trắng/đen), nhóm nào "đậm" nhất thì thắng.
     * Ảnh gần như không có màu (đen trắng) trả về xám xanh nhạt.
     */
    static int tileColor(Bitmap src) {
        final int W = 40, H = 40;
        Bitmap s = Bitmap.createScaledBitmap(src, W, H, true);
        int[] px = new int[W * H];
        s.getPixels(px, 0, W, 0, 0, W, H);

        double[] wSum = new double[12];
        double[] sH = new double[12];
        double[] sS = new double[12];
        double[] sV = new double[12];
        float[] hsv = new float[3];
        int counted = 0;

        for (int i = 0; i < px.length; i++) {
            int p = px[i];
            if (Color.alpha(p) < 128) continue;
            counted++;
            Color.colorToHSV(p, hsv);
            if (hsv[1] < 0.2f || hsv[2] < 0.2f) continue; // xám / trắng / đen: không tính
            int bin = ((int) (hsv[0] / 30f)) % 12;
            double w = hsv[1] * hsv[2];
            wSum[bin] += w;
            sH[bin] += hsv[0] * w;
            sS[bin] += hsv[1] * w;
            sV[bin] += hsv[2] * w;
        }
        if (s != src) s.recycle();

        int best = 0;
        for (int i = 1; i < 12; i++) {
            if (wSum[i] > wSum[best]) best = i;
        }
        if (counted == 0 || wSum[best] < counted * 0.03) {
            return Color.HSVToColor(new float[]{215f, 0.12f, 0.34f});
        }
        float h = (float) (sH[best] / wSum[best]);
        float sat = (float) (sS[best] / wSum[best]);
        float val = (float) (sV[best] / wSum[best]);
        sat = Math.max(0.40f, Math.min(0.85f, sat));
        val = 0.32f + 0.28f * val; // 0.32 .. 0.60
        return Color.HSVToColor(new float[]{h, sat, val});
    }

    static String hex(int color) {
        return String.format("#%06X", color & 0xFFFFFF);
    }
}
