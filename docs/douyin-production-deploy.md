# Deploy production để user xem được reply Douyin

## Mô hình khuyến nghị

Không để user cuối tự đăng nhập Douyin. Backend nên dùng một phiên Douyin riêng của server:

1. Admin đăng nhập Douyin bằng Chromium ở máy vận hành.
2. Backend lưu cookie/session vào `.cache`.
3. Admin capture một request reply thật để lấy `replyApiTemplateUrl`.
4. Khi user bấm "Xem phản hồi", backend dùng session/template đó để lấy reply.

Lý do: cookie Douyin là dữ liệu nhạy cảm. Nếu để từng user sync cookie thì app phải xử lý
cookie cá nhân của user, rủi ro bảo mật và khó vận hành hơn.

## Cách chuẩn bị session

Chạy ở máy có GUI:

```powershell
npm run hold:douyin-login
npm run capture:douyin-replies
npm run export:douyin-production-session
```

Sau đó có 2 cách deploy.

## Cách 1: Mount volume `.cache`

Phù hợp nếu deploy Docker trên cùng server hoặc có thể copy volume an toàn.

```yaml
volumes:
    - ./.cache:/app/.cache
```

Repo đã có cấu hình này trong `docker-compose.yml`. Cần đảm bảo `.cache` trên server có:

- `douyin-storage-state.json`
- `douyin-auth-profile`
- `douyin-direct-api-state.json`

## Cách 2: Dùng secret/env

Script export tạo file:

```text
.cache/douyin-production-session.env
```

File này chứa:

- `DOUYIN_STORAGE_STATE_BASE64`
- `DOUYIN_REPLY_API_TEMPLATE_URL`
- `DOUYIN_COMMENT_API_TEMPLATE_URL`
- `DOUYIN_ADMIN_TOKEN`

Có thể copy các biến này vào secret manager hoặc `.env` trên server. Khi app start, backend
tự seed lại session từ env.

## Xoay cookie/template khi production đang chạy

Endpoint admin:

```text
POST /api/douyin/admin/session
```

Header:

```text
x-admin-token: <DOUYIN_ADMIN_TOKEN>
```

Body mẫu:

```json
{
    "storageStateBase64": "<base64 JSON storageState>",
    "replyApiTemplateUrl": "https://www.douyin.com/aweme/v1/web/comment/list/reply/?..."
}
```

Hoặc chỉ cập nhật cookie header:

```json
{
    "cookieHeader": "name=value; name2=value2",
    "replyApiTemplateUrl": "https://www.douyin.com/aweme/v1/web/comment/list/reply/?..."
}
```

Trong production, `/api/douyin/sync-cookies` cũng yêu cầu admin token. Không mở browser sync
công khai cho user cuối.

## Lưu ý vận hành

- `DOUYIN_REPLY_API_TEMPLATE_URL` phải là URL reply thật từng được browser Douyin tạo ra.
- Backend sẽ thay `item_id`, `comment_id`, `cursor`, `count` trên template khi gọi reply.
- Nếu reply bắt đầu bị body rỗng hoặc `x-vc-bdturing-parameters`, chạy lại
  `npm run hold:douyin-login` và `npm run capture:douyin-replies`, rồi cập nhật secret.
- Không commit `.cache`, `.env`, hoặc file export production session.

