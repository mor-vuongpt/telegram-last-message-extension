# MT5 webhook server

Webhook cục bộ nhận đúng JSON tín hiệu từ Chrome extension, lưu vào hàng đợi và cho Expert Advisor MetaTrader 5 lấy qua HTTP.

## Khởi động

Yêu cầu Node.js 18 trở lên. Server không dùng package bên thứ ba nên không cần `npm install`.

Tạo token bí mật:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Linux/macOS:

```bash
WEBHOOK_TOKEN="TOKEN_VUA_TAO" npm start
```

Windows PowerShell:

```powershell
$env:WEBHOOK_TOKEN="TOKEN_VUA_TAO"
npm start
```

Mặc định server chỉ nghe tại `http://127.0.0.1:8787`. Kiểm tra bằng trình duyệt:

```text
http://127.0.0.1:8787/health
```

Kết quả phải là `{"ok":true}`. Giữ cửa sổ terminal này luôn chạy khi dùng EA.

## API

- `POST /api/signals`: extension đưa một tín hiệu vào hàng đợi.
- `GET /api/signals/next?terminal_id=mt5-main`: EA nhận tín hiệu kế tiếp.
- `POST /api/signals/:id/ack`: EA xác nhận kết quả xử lý.
- `GET /api/signals`: xem lịch sử hàng đợi; yêu cầu token.

Mọi endpoint trừ `/health` yêu cầu header:

```text
Authorization: Bearer TOKEN_VUA_TAO
```

Dữ liệu được lưu trong `data/signals.json`. Server dùng signal ID, lease và `Idempotency-Key` để hạn chế đặt lệnh trùng.

## Bảo mật

- Dùng token ngẫu nhiên dài và không chia sẻ token.
- Mặc định chỉ chạy trên localhost; không đặt `WEBHOOK_HOST=0.0.0.0` hoặc mở port Internet nếu chưa có HTTPS, firewall và cơ chế xác thực phù hợp.
- Cấu hình hiện tại dành cho Chrome và MT5 chạy trên cùng một máy.
