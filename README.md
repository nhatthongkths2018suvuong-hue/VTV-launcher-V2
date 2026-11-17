# VTV Launcher 2 cho Android TV box (bản 2.1.1)

Đây là VTV Grid được nâng cấp thành **launcher (màn hình Home)** cho TV box.

**Cài song song được với bản cũ:** bản này dùng mã định danh `com.vtv.grid.v2` (tên hiển thị "VTV Launcher 2"),
khác bản cũ `com.vtv.grid`, nên cài vào không đè lên bản cũ. Thư mục dữ liệu cũng riêng:
`Android/data/com.vtv.grid.v2/files/` (lần chạy đầu app tự tạo file `channels.txt` mẫu ở đó; chép file `channels.txt` của bản cũ sang nếu muốn dùng lại danh sách kênh).

## Cách hoạt động
- Bật box hoặc bấm **Home**: hiện ngay màn hình chọn kênh (không tự phát kênh nào). Đang xem kênh mà bấm Home thì cũng về màn hình chọn kênh.
- Chuyển kênh như cũ: ▲▼ / CH+ CH- / phím số.
- **Back hoặc OK** khi đang xem: về màn hình chọn kênh.
- Màn hình chọn kênh (từ trên xuống):
  - **Góc phải trên:** giờ, ngày và 2 icon nhỏ **Cài đặt** (mở Cài đặt Android) và **Ứng dụng** (danh sách mọi ứng dụng đã cài).
  - **Hàng 6 ô ứng dụng nhanh:** OK ở ô trống để chọn ứng dụng, các lần sau OK để mở ngay.
    Muốn đổi ứng dụng của một ô: **giữ OK ~1 giây** trên ô đó (hoặc phím **Menu**, hoặc chạm giữ nếu dùng cảm ứng).
    Trong danh sách Ứng dụng, giữ OK trên một app để chọn gán vào ô nào. Màu nền mỗi ô theo màu chủ đạo của icon.
  - **Hàng kênh:** mỗi lần hiện 6 kênh. ▼ sang 6 kênh tiếp theo, ▲ quay lại 6 kênh trước (hàng ứng dụng nhanh không bị ảnh hưởng);
    ▲ ở hàng kênh đầu tiên để lên hàng ứng dụng nhanh, rồi lên tiếp để tới 2 icon ở góc phải. Mỗi ô kênh có một màu ngẫu nhiên (2 ô cạnh nhau khác màu), đổi mỗi lần vào lại launcher.
- **Hình nền:** chép một hoặc nhiều ảnh (jpg, jpeg, png, webp, tên bất kỳ) vào thư mục `Android/data/com.vtv.grid.v2/files/`
  (cùng thư mục với `channels.txt`). Mỗi lần vào lại launcher (khởi động, bấm Home, thoát khỏi một app) sẽ chọn ngẫu nhiên 1 ảnh (cố tránh trùng ảnh vừa dùng); xoá hết ảnh thì về hình nền mặc định.
  Nên dùng ảnh ngang 16:9, từ 1280x720 trở lên.
- Khi VTV Launcher là launcher mặc định, Back ở màn hình chọn kênh không thoát app (launcher không có chỗ để "thoát").
  Nếu chạy như app thường (không đặt làm mặc định) thì Back vẫn thoát như trước.

## Thử và chuyển launcher an toàn bằng ADB
Hai launcher cùng tồn tại, launcher đang là mặc định vẫn nhận phím Home. Cách chuyển an toàn:

1. Cài bản này, mở nó từ danh sách ứng dụng của launcher cũ (tên "VTV Launcher 2") để thử giao diện. Lúc này Home vẫn về launcher cũ.
2. Khi thấy ổn, đặt làm Home. Chú ý đủ tên lớp vì tên gói (`com.vtv.grid.v2`) khác tên lớp (`com.vtv.grid.MainActivity`):

        adb shell cmd package set-home-activity --user 0 com.vtv.grid.v2/com.vtv.grid.MainActivity

3. Kiểm tra: `adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME`
4. **Quay lại bản cũ bất cứ lúc nào** (nếu bản mới có vấn đề):

        adb shell cmd package set-home-activity --user 0 com.vtv.grid/.MainActivity

Nếu chạy bản này như app thường (chưa đặt làm Home) thì Back ở màn hình chọn kênh vẫn thoát ra được.

---

# VTV Grid (bản gốc 1.4.0)

Chức năng giống bản LG webOS 1.4.0: lưới kênh 4 cột, OK để xem, mũi tên lên/xuống để chuyển kênh,
phím số để nhảy kênh, Back/OK để về danh sách, tự lấy tên kênh vtvgo, không có dòng trạng thái / mã phím.

## 1. Đặt file danh sách kênh (chỉ một vị trí duy nhất)

    /sdcard/Android/data/com.vtv.grid.v2/files/channels.txt

(trong bộ nhớ trong của box, thường là /storage/emulated/0/Android/data/com.vtv.grid.v2/files/channels.txt)

- Mở app một lần: app tự tạo thư mục này và chép file mẫu vào đó. Chỉ việc thay bằng file của bạn.
- Chép file bằng: ADB (`adb push channels.txt /sdcard/Android/data/com.vtv.grid.v2/files/channels.txt`),
  hoặc trình quản lý file trên box (một số box Android 11+ chặn thư mục Android/data, khi đó dùng ADB).
- Nếu không đọc được file, màn hình sẽ hiện đúng đường dẫn app đang tìm.

## 2. Build ra APK

### Cách A: không cần cài gì (GitHub)
1. Tạo repo mới trên GitHub, tải toàn bộ thư mục này lên (giữ nguyên thư mục .github).
2. Vào tab Actions, chạy "Build APK" (hoặc tự chạy sau khi push).
3. Khi xong, tải artifact `VTVGrid-apk` về, giải nén ra `app-debug.apk`.

### Cách B: Android Studio
1. File > Open, chọn thư mục này, đợi Gradle đồng bộ (cần JDK 17, Android Studio tự có).
2. Build > Build Bundle(s) / APK(s) > Build APK(s).
3. File nằm tại `app/build/outputs/apk/debug/app-debug.apk`.

### Cách C: dòng lệnh
    gradle assembleDebug        (Gradle 8.7, JDK 17, Android SDK 34)

## 3. Cài lên box
Chép `app-debug.apk` vào box rồi cài (bật "Cài đặt từ nguồn không xác định"), hoặc `adb install app-debug.apk`.
Nếu box có màn hình Android TV, app hiện trong danh sách ứng dụng (có banner); box thường thì nằm trong "Ứng dụng".

## Ghi chú
- Video phát bằng thẻ video của Android System WebView. Box có WebView quá cũ có thể không phát được HLS;
  cập nhật "Android System WebView" nếu gặp tình trạng này.
- Phím CH+/CH- trên remote (nếu có) hoạt động như mũi tên lên/xuống khi đang xem.
