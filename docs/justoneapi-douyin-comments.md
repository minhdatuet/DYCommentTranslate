# Tích hợp Just One API (Douyin Comments/Replies)

Mục tiêu: dùng Just One API để lấy comment/reply Douyin qua HTTP API, tránh phụ thuộc Playwright khi Douyin chặn verify.

## Endpoint dùng

- Video Comments (V1)
    - `GET /api/douyin/get-video-comment/v1`
    - Query: `token` (bắt buộc), `awemeId` (bắt buộc), `page` (tuỳ chọn, mặc định `1`)
- Comment Replies (V1)
    - `GET /api/douyin/get-video-sub-comment/v1`
    - Query: `token` (bắt buộc), `commentId` (bắt buộc), `page` (tuỳ chọn, mặc định `1`)

Base URL mặc định: `https://api.justoneapi.com`

## Cấu hình `.env`

```text
COMMENT_SOURCE=justoneapi
JUSTONEAPI_TOKEN=YOUR_TOKEN
JUSTONEAPI_BASE_URL=https://api.justoneapi.com
JUSTONEAPI_TIMEOUT_MS=90000
```

## Cách dùng trong project

Backend đã hỗ trợ chọn nguồn theo:

- Biến môi trường: `COMMENT_SOURCE` (`douyin` | `justoneapi`)
- Hoặc theo request body:
    - `/api/comments`: thêm field `source`
    - `/api/comment-replies`: thêm field `source`

Frontend (`public/index.html`) có dropdown “Nguồn lấy comment” để chọn `douyin` hoặc `justoneapi`.

## File liên quan

- Service gọi Just One API: `src/services/justOneApiDouyinService.js`
- Config env: `src/config.js`
- Backend route: `src/app.js`
- UI select + request payload: `public/index.html`, `public/app.js`

