# Phân tích lấy reply thật của Douyin

Ngày kiểm tra: 2026-04-24

Video thử nghiệm: `7623466763384016163`

## Kết luận ngắn

Reply thật không nằm trong payload comment cấp 1. Comment cấp 1 chỉ có các trường như `cid`,
`reply_comment_total` hoặc `replyTotal`. Muốn lấy nội dung reply phải gọi riêng endpoint:

```text
GET https://www.douyin.com/aweme/v1/web/comment/list/reply/
```

Các tham số lõi:

- `item_id`: ID video hoặc aweme ID.
- `comment_id`: `cid` của comment cấp 1.
- `cursor`: con trỏ phân trang, bắt đầu từ `0`.
- `count`: số reply mỗi trang.
- `a_bogus`, `msToken`, `webid`, `verifyFp/fp`, cookie và browser params.

Điểm dễ sai: endpoint reply dùng `item_id`, không phải `aweme_id`. Nếu ký request với
`aweme_id`, Douyin có thể trả HTTP 200 nhưng body rỗng.

## Nguồn đã đối chiếu

- Douyin_TikTok_Download_API: có endpoint `/fetch_video_comment_replies` với tham số
  `item_id`, `comment_id`, `cursor`, `count`.
- ShilongLee/Crawler: có API `/douyin/replys`, tài liệu yêu cầu `id` video và
  `comment_id`; phần phân tích DeepWiki nói reply dùng logic ký riêng `sign_reply`.
- F2: có hệ thống Douyin crawler, sinh `msToken`, `ttwid`, `verify_fp`, `s_v_web_id`,
  `X-Bogus`, `A-Bogus`; tài liệu public hiện liệt kê comment cấp 1, không thấy API reply
  web được public rõ như repo trên.
- DouyinApiDoc/Postman cũ: endpoint `comment/list/reply` dùng `item_id`.
- Douyin Open Platform: có API chính thức lấy comment reply, nhưng cần OAuth scope và
  quyền dữ liệu comment.

## Kết quả thử với video mẫu

Lệnh:

```powershell
npm run test:douyin
```

Kết quả ngày 2026-04-24:

- Lấy comment cấp 1 thành công bằng `douyin-signed-api`.
- Douyin báo tổng comment cấp 1: `405`.
- App lấy được khoảng `280-288` comment trong giới hạn timeout hiện tại.
- Một số comment có reply thật, ví dụ:
  - `7623661061283463972`: `replyCount = 11`.
  - `7624084799707628340`: `replyCount = 2`.
- Gọi reply bằng cookie guest hiện tại vẫn trả body rỗng hoặc bị challenge. Auth status:
  `isLoggedIn = false`.
- Sau khi dùng Chromium đăng nhập thật và capture network ngày 2026-04-24, backend đã lấy
  được đủ `11` reply của comment `7623661061283463972` trong khoảng dưới 1 giây bằng
  captured `replyApiTemplateUrl`.

Target test cố định đã được lưu ở `docs/douyin-reply-test-targets.json`. Comment chính:

- Video: `7623466763384016163`.
- Comment ID: `7623661061283463972`.
- Text: `这种蜂蜜🍯2 30 起步`.
- Reply quan sát được: `11`.

Lệnh kiểm thử nhanh sau khi đã có cookie và captured template:

```powershell
node --input-type=module -e "import { DouyinService } from './src/services/douyinService.js'; const service = new DouyinService(); const result = await service.GetRepliesAsync('https://www.douyin.com/jingxuan?modal_id=7623466763384016163', '7623661061283463972', 50); console.log(result.replyStatus); await service.CloseAsync();"
```

## Cách lấy reply thật khả thi

### Phương án 1: Douyin web với cookie đăng nhập thật

Quy trình đúng:

1. Đồng bộ cookie đăng nhập từ Douyin web.
2. Lấy comment cấp 1 bằng `/aweme/v1/web/comment/list/`.
3. Với comment có `replyCount > 0`, gọi `/aweme/v1/web/comment/list/reply/`.
4. Dùng `item_id`, `comment_id`, `cursor`, `count`.
5. Ký `a_bogus` trên đúng query string của reply request.
6. Lặp theo `cursor` cho đến khi `has_more = 0`.

Trong thực tế web reply có thể bị `x-vc-bdturing-parameters` nếu tự ký không đủ giống
browser. Cách đã chạy được là:

1. Chạy `npm run hold:douyin-login` để mở Chromium, đăng nhập và lưu cookie.
2. Chạy `npm run capture:douyin-replies`, mở reply trong UI để bắt request thật.
3. Script capture lưu URL tốt vào `.cache/douyin-direct-api-state.json`.
4. Backend dùng URL đó như template, thay `item_id`, `comment_id`, `cursor`, `count` để
   gọi trực tiếp từ Node.

Rủi ro: cookie guest lấy comment cấp 1 được nhưng thường không đủ để lấy reply. Reply bị
Douyin risk-control nặng hơn, có thể cần phiên đăng nhập thật và request được tạo trong
browser context thật.

### Phương án 2: API chính thức Open Platform

Đây là hướng ổn định nhất nếu có quyền:

- Dùng API `GET /item/comment/reply/list/`.
- Cần OAuth access token, scope comment và quyền dữ liệu comment.
- Chỉ phù hợp nếu tài khoản/app có quyền xem dữ liệu video liên quan.

## Việc đã chỉnh trong repo

- Sửa signed reply URL từ `aweme_id` sang `item_id`.
- Sửa fallback direct/captured reply API để xóa `aweme_id` cũ và set `item_id`.
- Truyền thêm `itemId` cho wrapper webpack nội bộ, giữ `awemeId` để tương thích ngược nếu
  module Douyin vẫn dùng tên đó.
- Thêm script `sync:douyin-cookies`, `hold:douyin-login`, `capture:douyin-replies`.
- Ưu tiên dùng captured reply template trước signed API để lấy reply nhanh hơn.
- Sửa `WithTimeoutAsync` để clear timer sau khi Promise thành công, tránh Node bị giữ lại
  đến hết timeout.
