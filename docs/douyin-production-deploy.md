# Deploy production với cookie của từng user

## Mô hình hiện tại

Production không dùng tài khoản Douyin chung của server và không dùng API trung gian. Mỗi user tự sync cookie
Douyin đã đăng nhập, backend giữ cookie trong phiên HTTP-only ngắn hạn, sau đó mọi request comment/reply đều gọi
trực tiếp Douyin bằng cookie của user đó.

Luồng chuẩn:

1. User bấm "Lấy cookie tự động".
2. Backend mở một phiên Douyin tạm bằng Playwright và UI hiển thị ảnh của phiên đó.
3. User đăng nhập trong khung Douyin; trên điện thoại có thể bấm vào ảnh để focus, nhập SMS bằng ô điều khiển,
   hoặc dùng QR nếu có thiết bị thứ hai.
4. Backend poll cookie của phiên Playwright cho đến khi đủ trạng thái đăng nhập.
5. Backend tạo `dyc_user_session` HTTP-only và giữ cookie Douyin trong memory theo phiên.
6. `/api/comments` và `/api/comment-replies` chỉ chạy khi phiên user hợp lệ.
7. User bấm "Xóa phiên" để hủy cookie khỏi memory server.

## Lý do chọn mô hình này

- Không phụ thuộc dịch vụ bên thứ ba.
- Không dùng `.cache` làm nguồn production.
- Không dùng cookie/tài khoản Douyin chung của server.
- User kiểm soát phiên Douyin của chính họ.
- Không cần đọc cookie từ trình duyệt mobile, vì login xảy ra trong phiên browser tạm của backend.

## Lưu ý vận hành

- Bắt buộc deploy qua HTTPS nếu public internet, vì cookie phiên app phải đi qua kênh mã hóa.
- Memory session phù hợp single instance. Nếu chạy nhiều instance, cần sticky session hoặc một session store nội bộ.
- Cookie Douyin là dữ liệu nhạy cảm, không log request body của `/api/douyin/session`.
- `DOUYIN_REPLY_API_TEMPLATE_URL` và `DOUYIN_COMMENT_API_TEMPLATE_URL` vẫn có thể cấu hình như template hỗ trợ,
  nhưng auth luôn lấy từ cookie của user.
- Nếu server chạy headless Chromium, cần môi trường cho phép Playwright mở browser và chụp screenshot.
- Không log screenshot, thao tác remote browser hoặc request body login.

## Endpoint chính

```text
POST /api/douyin/session
DELETE /api/douyin/session
GET /api/douyin/auth-status
POST /api/douyin/login-flow
GET /api/douyin/login-flow/:flowId/status
GET /api/douyin/login-flow/:flowId/screenshot
POST /api/douyin/login-flow/:flowId/click
POST /api/douyin/login-flow/:flowId/type
POST /api/douyin/login-flow/:flowId/key
DELETE /api/douyin/login-flow/:flowId
POST /api/comments
POST /api/comment-replies
```

`POST /api/douyin/session` nhận:

```json
{
    "cookieHeader": "sessionid=...; sid_guard=...; passport_auth_status=..."
}
```

Hoặc storage state:

```json
{
    "storageStateBase64": "<base64 JSON storageState>"
}
```

Nếu cookie chưa đủ đăng nhập, backend trả `400` và không tạo phiên.
