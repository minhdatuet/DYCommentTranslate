# DYComment

Webapp nhập link video Douyin, lấy comment tiếng Trung, dịch sang tiếng Việt và hiển thị trên web.

## Công nghệ đã chọn

- `Node.js 24`
- `Express 5`
- `Playwright`
- `Gemini API` cho dịch AI
- `SangTacViet API` cho dịch online (fallback offline khi lỗi)
- `Offline dictionary translator` dựa trên bộ từ điển ở `D:\Novel\convert-etx`

## Vì sao chọn stack này

- `Playwright` phù hợp nhất để vào đúng browser context của Douyin, lấy được request comment đã có chữ ký.
- `Node.js` giúp gom crawler và translator vào một backend duy nhất, tránh phải vận hành 2 runtime.
- `Express` đủ nhẹ cho webapp dạng nhập link và trả JSON.
- `SangTacViet API` cho chất lượng dịch tốt, không cần API key, fallback offline khi API lỗi.
- Bộ từ điển offline cho phép chạy hoàn toàn không cần mạng, còn Gemini là lựa chọn chất lượng cao hơn khi có key.

## Chạy local

1. Cài dependency:

```powershell
npm install
npx playwright install chromium
```

2. Tạo file `.env` từ `.env.example`

3. Chạy app:

```powershell
npm run dev
```

4. Mở:

```text
http://localhost:3000
```

## Biến môi trường

- `PORT`: cổng webapp
- `STV_API_URL`: URL API SangTacViet, mặc định `https://comic.sangtacvietcdn.xyz/tsm.php?cdn=`
- `GEMINI_API_KEY`: API key cho Gemini
- `GEMINI_MODEL`: model Gemini, mặc định `gemini-2.5-flash`
- `OFFLINE_DICT_DIR`: thư mục từ điển, mặc định `D:\Novel\convert-etx`
- `PLAYWRIGHT_HEADLESS`: `true` hoặc `false`

## Test Douyin

Script test thực tế với link mẫu:

```powershell
npm run test:douyin
```

Mặc định script test với:

```text
https://www.douyin.com/jingxuan?modal_id=7623466763384016163
```

## Ghi chú kỹ thuật

- Backend tự chuẩn hóa link `jingxuan?modal_id=...` sang `https://www.douyin.com/video/<aweme_id>`.
- Service hiện dùng chính webpack client nội bộ của trang Douyin để lấy nhiều page comment cấp 1, thay vì chỉ bám vào page đầu.
- Reply hiện được probe riêng. Với link mẫu ngày `2026-04-06`, Douyin trả về challenge `x-vc-bdturing-parameters` cho endpoint reply, nên app sẽ báo trạng thái bị chặn thay vì báo sai là không có reply.
- Chế độ `stv` (SangTacViet API) là mặc định — dịch online từng câu, câu nào API lỗi sẽ tự fallback offline.
- Chế độ `offline` dịch được ngay nhưng chất lượng thấp hơn.
