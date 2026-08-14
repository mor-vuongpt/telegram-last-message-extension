# Telegram - Tự động phân tích tín hiệu và gửi MT5

Chrome Extension Manifest V3 chạy trong Side Panel bên cạnh `https://web.telegram.org`, theo dõi riêng nội dung text mới trong cuộc hội thoại đang mở, dùng model `gpt-5.6-sol` với mức suy luận `none` để phân tích tín hiệu Forex, rồi tự động gửi JSON hợp lệ sang webhook MetaTrader 5.

## Cài đặt

1. Giải nén file ZIP.
2. Mở Chrome và truy cập `chrome://extensions`.
3. Bật **Chế độ dành cho nhà phát triển** (Developer mode).
4. Bấm **Tải tiện ích đã giải nén** (Load unpacked).
5. Chọn thư mục `telegram-last-message-extension` vừa giải nén.
6. Mở hoặc tải lại tab Telegram Web. Ở thao tác bấm đầu tiên trên Telegram, extension sẽ yêu cầu Chrome mở Side Panel. Sau đó có thể mở/đóng sidebar trực tiếp bằng biểu tượng extension trên thanh công cụ.

Chrome chỉ cho phép `sidePanel.open()` sau một thao tác người dùng, nên trình cài đặt không thể tự mở sidebar ngay lập tức mà không có lần bấm đầu tiên. Nếu sidebar xuất hiện bên trái, đổi vị trí Side Panel sang bên phải trong phần tùy chỉnh giao diện của Chrome.
Service worker ghi nhớ tab Telegram được kích hoạt gần nhất và xác minh trực tiếp bằng content script để sidebar luôn đọc đúng cuộc trò chuyện đang mở, kể cả khi Chrome không trả URL tab hiện hành trực tiếp cho trang Side Panel.
Manifest cấp `host_permissions` riêng cho `https://web.telegram.org/*` để sidebar có thể chèn lại content script khi trang Telegram đã được mở trước lúc extension khởi động hoặc vừa được tải lại.
Nếu bấm **Reload** extension tại `chrome://extensions`, hãy tải lại tab Telegram một lần để loại bỏ content script thuộc phiên bản cũ. Bản mới cũng tự dừng script cũ nếu Chrome vô hiệu hóa extension context, nên không còn phát sinh lỗi `chrome.runtime.sendMessage` khi người dùng bấm trên Telegram.

## Bật chế độ tự động hoàn toàn

1. Mở `https://web.telegram.org` và chọn một cuộc trò chuyện.
2. Nếu đang xem tin nhắn cũ, cuộn xuống cuối cuộc trò chuyện.
3. Sidebar sẽ mở sau thao tác đầu tiên trên Telegram; cũng có thể bấm biểu tượng extension trên thanh công cụ Chrome để mở thẳng.
4. Nhập OpenAI API key, webhook URL và webhook token.
5. Bật **Tự động theo dõi tin nhắn mới và gửi MT5**.
6. Có thể đóng popup. Giữ Chrome, đúng tab Telegram Web, webhook và MT5 đang chạy.

Tin nhắn đang hiển thị tại thời điểm bật chỉ được dùng làm mốc và **không được gửi sang MT5**. Kể từ đó, mỗi tin nhắn text mới trong đúng tab/cuộc trò chuyện đang mở sẽ được phân tích. JSON `{}` bị bỏ qua; JSON tín hiệu hợp lệ được tự động đưa vào hàng đợi MT5 mà không cần bấm **Gửi JSON sang MT5**.

Popup hiển thị toàn bộ **Tin nhắn text gần nhất đã lấy**, cùng trạng thái gần nhất: đang chờ, đang phân tích, đã bỏ qua, đã gửi hoặc lỗi; sau mỗi lần xử lý còn có tổng thời gian AI/webhook tính bằng giây. Tin nhắn gần nhất được lưu trong profile Chrome nên vẫn xem được sau khi đóng và mở lại popup. Nút **Lấy và phân tích tin nhắn** và **Gửi JSON sang MT5** vẫn được giữ lại để kiểm tra thủ công khi cần.

## Kết nối MetaTrader 5

Luồng hoạt động:

```text
Telegram Web → Chrome extension → webhook localhost → EA MetaTrader 5 → broker
```

JSON không chứa `symbol` và `volume`, vì vậy EA dùng `InpTradeSymbol` và `InpLots` do bạn cấu hình. Hãy nhập đúng tên symbol của broker, kể cả hậu tố như `XAUUSDm` hoặc `XAUUSD.a`.

### 1. Chạy webhook

Mở terminal tại thư mục `webhook-server`, tạo một token bí mật rồi chạy server:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
WEBHOOK_TOKEN="TOKEN_VUA_TAO" npm start
```

Trên Windows PowerShell, dùng:

```powershell
$env:WEBHOOK_TOKEN="TOKEN_VUA_TAO"
npm start
```

Giữ terminal chạy. Mở `http://127.0.0.1:8787/health` và xác nhận kết quả là `{"ok":true}`.

### 2. Cấu hình extension

1. Vào `chrome://extensions` và tải lại extension.
2. Mở **Kết nối webhook MetaTrader 5** trong popup.
3. Để URL là `http://127.0.0.1:8787`.
4. Nhập cùng token đã dùng để chạy server.
5. Trước tiên thử thủ công trên tài khoản demo. Khi toàn bộ luồng đã đúng, bật **Tự động theo dõi tin nhắn mới và gửi MT5** tại đúng tab Telegram cần theo dõi.

### 3. Cài Expert Advisor

1. Trong MT5, chọn **File → Open Data Folder**.
2. Chép `mt5/TelegramSignalReceiver.mq5` vào `MQL5/Experts`.
3. Mở file bằng MetaEditor và bấm **Compile**.
4. Trong MT5, vào **Tools → Options → Expert Advisors**.
5. Bật **Allow WebRequest for listed URL** và thêm `http://127.0.0.1:8787`.
6. Gắn EA `TelegramSignalReceiver` vào một chart.
7. Đặt `InpWebhookToken` giống token của server, `InpTradeSymbol` đúng tên symbol broker và `InpLots` theo khối lượng cơ sở mong muốn.
8. Với XAUUSD theo cách tính trong ví dụ, giữ `InpTakeProfitPips=200` và `InpPipSize=0.1`. Khoảng TP luôn là `200 × 0.1 = 20` đơn vị giá.

### 4. Thử trên tài khoản demo

Để `InpEnableLiveTrading=false`. Gửi một JSON mới từ extension; tab **Experts** của MT5 phải hiện dòng `Dry run`. Tín hiệu dry-run sẽ được đánh dấu đã xử lý và không được dùng lại.

Sau khi kiểm tra đúng symbol, lot, entry, SL và TP cố định do EA tính, gắn lại EA với `InpEnableLiveTrading=true`, bật **Algo Trading**, rồi bật chế độ tự động trong extension. Chỉ tin nhắn mới xuất hiện sau khi bật mới được xử lý.

EA hỗ trợ `buy`, `sell`, `buy now`, `sell now`, `buy limit`, `sell limit`, `buy stop` và `sell stop`. EA kiểm tra hướng giá, quyền giao dịch, bước lot và mã trả về của trade server; tín hiệu không hợp lệ sẽ bị từ chối thay vì tự sửa giá.

Tín hiệu `BUY NOW` hoặc `SELL NOW` vẫn được gửi khi thiếu TP, SL hoặc cả hai; `entry` của hai loại này luôn là `""`. Với `BUY LIMIT`, `SELL LIMIT`, `BUY STOP` và `SELL STOP`, chỉ entry là bắt buộc, còn TP và SL có thể để trống. TP thiếu luôn được EA thay bằng TP cố định; SL thiếu được truyền sang MT5 dưới dạng `0` (lệnh không có Stop Loss). `BUY` và `SELL` thường vẫn bắt buộc có entry và SL hợp lệ.

> Lệnh không có SL có thể thua lỗ không giới hạn theo mức giá và cũng không kích hoạt cơ chế tăng lot sau SL của EA. Chỉ bật giao dịch thật nếu bạn chấp nhận rõ rủi ro này.

### Lot tăng sau SL và TP cố định

- Lot khởi đầu là `InpLots`. Nếu đặt `0.01`, chuỗi sau SL là `0.01 → 0.02 → 0.03 → ...`.
- EA chỉ tăng chuỗi khi một vị thế có đúng `InpTradeSymbol` và `InpMagicNumber` đóng bởi Stop Loss.
- Khi một vị thế tương ứng đóng bởi Take Profit, lot kế tiếp quay lại `InpLots`.
- Trạng thái chuỗi SL được lưu trong thư mục Common Files của MT5 nên không mất khi đóng/mở lại terminal. Trạng thái được tách theo account login, terminal ID, symbol và Magic Number để tài khoản demo không ảnh hưởng tài khoản thật. Lịch sử cũ trước lần đầu cài bản EA này chỉ được dùng làm mốc và không làm tăng lot.
- Lot vượt quá `SYMBOL_VOLUME_MAX` hoặc không khớp bước lot của broker sẽ bị từ chối, không bị âm thầm làm tròn hoặc giảm xuống.
- EA luôn bỏ TP do AI gửi và tự tính TP. Với BUY entry `4000`, cấu hình `200` pip và pip size `0.1` cho TP `4020`; với SELL entry `4000`, TP là `3980`.
- Đối với lệnh market (`buy`, `sell`, `buy now`, `sell now`), TP được tính từ Ask/Bid tại lúc gửi lệnh. Đối với lệnh chờ, TP được tính từ entry trong tín hiệu.

> Hãy thử bằng tài khoản demo trước. Tự động hóa giao dịch có thể mở lệnh thật ngay khi tín hiệu được gửi.

> Cơ chế tăng lot sau mỗi SL làm mức rủi ro tăng liên tục. EA không tự giảm lot ngoài trường hợp chạm TP; khi lot vượt giới hạn broker, tín hiệu tiếp theo sẽ bị từ chối.

Extension bỏ qua ảnh, video, tệp, pinned message và không gửi tên cuộc trò chuyện, người gửi, thời gian, số lượt xem hoặc reaction tới OpenAI.
Tin nhắn có URL kèm TradingView/link preview vẫn giữ phần text do người gửi nhập; tiêu đề và mô tả tự sinh của preview bị loại bỏ. Khi Telegram tái sử dụng DOM, extension chọn tin text nằm thấp nhất trên màn hình thay vì tin đứng cuối theo thứ tự HTML.

Kết quả khi đủ dữ liệu:

```json
{
  "type": "sell limit",
  "entry": "4156",
  "TP": "4132",
  "SL": "4160"
}
```

Kết quả là `{}` nếu không nhận diện được loại lệnh, hoặc nếu một trong bốn lệnh chờ không có entry. TP có thể là `""` vì EA luôn thay thế bằng TP cố định. Với `buy now` và `sell now`, `entry` luôn là `""`; với bốn lệnh chờ, entry phải là giá dương. Cả sáu loại này đều cho phép TP và SL là `""`.

Ví dụ market-now không có TP và SL trong tin nhắn:

```json
{
  "type": "buy now",
  "entry": "",
  "TP": "",
  "SL": ""
}
```

Ví dụ lệnh chờ chỉ có entry:

```json
{
  "type": "sell limit",
  "entry": "4156",
  "TP": "",
  "SL": ""
}
```

Extension chuẩn hóa cục bộ các lỗi chính tả rõ ràng trong từ khóa lệnh trước khi gửi text tới GPT-5.6 Sol. Ví dụ `SELLL Stopd` thành `SELL STOP`, còn `BUYĐD Stopd` thành `BUY STOP`. Extension không thay đổi các con số giá hoặc những từ thông thường.

## Quyền riêng tư

- Extension đọc Telegram chỉ trên `web.telegram.org`.
- Chỉ text của tin nhắn cuối được gửi tới OpenAI.
- API key và webhook token không được ghi vào mã nguồn. Chúng được lưu trong `chrome.storage.local` của profile Chrome để chế độ tự động có thể tiếp tục sau khi popup đóng hoặc Chrome khởi động lại.
- Phản hồi API được gọi với `store: false`.

Không nên phát hành extension có API key phía trình duyệt cho người dùng khác. Khi triển khai thực tế, hãy gọi OpenAI qua backend riêng và giữ API key trong biến môi trường của server.

## Lưu ý

Telegram có thể thay đổi cấu trúc HTML sau các bản cập nhật. Nếu extension báo không tìm thấy tin nhắn, hãy kiểm tra lại các selector trong `content-script.js`.

- Extension chỉ theo dõi một tab Telegram đã chọn. Khi chuyển sang cuộc trò chuyện khác, tin cuối đang có ở cuộc trò chuyện mới cũng chỉ được dùng làm mốc.
- Phải giữ Telegram đăng nhập và tab còn mở. Nếu tải lại extension tại `chrome://extensions`, hãy tải lại tab Telegram một lần.
- Trạng thái **đã gửi** nghĩa là webhook đã nhận và xếp hàng; xem tab **Experts** của MT5 để xác nhận EA đã đặt hoặc từ chối lệnh.
- Khi OpenAI hoặc webhook lỗi tạm thời, extension thử lại tối đa ba lần. Lỗi cuối cùng được hiển thị trong popup.

Kết quả chỉ là dữ liệu được trích xuất từ nội dung tin nhắn, không phải lời khuyên đầu tư hoặc khuyến nghị giao dịch.
