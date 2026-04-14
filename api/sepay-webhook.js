// api/sepay-webhook.js — Cẩm Nang Giải Mã Nhân Tính
// CommonJS – fetch thuần, không npm packages

const ORDER_CODE_REGEX = /CGMN[A-Z0-9]{4}/i;
const PRICE = 149000;

/* ── Upstash KV helpers ── */
async function kvGet(key) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const data = await r.json();
  return data.result;
}
async function kvSet(key, value, ex) {
  await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, value, 'EX', ex]),
  });
}
async function kvIncr(key) {
  const r = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['INCR', key]),
  });
  const data = await r.json();
  return data.result;
}

/* ── Resend email ── */
async function sendEmail({ to, subject, html }) {
  const fromEmail = process.env.FROM_EMAIL || 'no-reply@hanadola.com';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: fromEmail, to, subject, html }),
  });
  const text = await r.text();
  console.log('[Resend] TO:', to, '| status:', r.status, '| resp:', text);
}

/* ── SePay eInvoice ── */
const EINVOICE_BASE = 'https://einvoice-api.sepay.vn';

async function createEInvoice({ order, transferAmount }) {
  const clientId          = process.env.SEPAY_EINVOICE_CLIENT_ID;
  const clientSecret      = process.env.SEPAY_EINVOICE_CLIENT_SECRET;
  const providerAccountId = process.env.SEPAY_EINVOICE_PROVIDER_ACCOUNT_ID;
  const templateCode      = process.env.SEPAY_EINVOICE_TEMPLATE_CODE;
  const invoiceSeries     = process.env.SEPAY_EINVOICE_SERIES;

  if (!clientId || !clientSecret || !providerAccountId) {
    console.log('[eInvoice] Thiếu biến môi trường — bỏ qua');
    return null;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  console.log('[eInvoice] Lấy token từ', EINVOICE_BASE + '/v1/token');
  const tokenRes = await fetch(`${EINVOICE_BASE}/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
    },
  });
  const tokenData = await tokenRes.json();
  console.log('[eInvoice] Token resp:', tokenRes.status, JSON.stringify(tokenData));
  const token = tokenData?.data?.access_token;
  if (!token) return null;

  const issuedDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const payload = {
    template_code:       templateCode,
    invoice_series:      invoiceSeries,
    issued_date:         issuedDate,
    currency:            'VND',
    provider_account_id: providerAccountId,
    payment_method:      'CK',
    buyer: {
      name:  order.name,
      email: order.email,
    },
    items: [
      {
        line_number: 1,
        line_type:   1,
        item_code:   'CGMN-001',
        item_name:   'Cẩm Nang Giải Mã Nhân Tính — Tài liệu số PDF',
        quantity:    1,
        unit_price:  transferAmount || PRICE,
        tax_rate:    -2,
      },
    ],
    is_draft: false,
  };

  console.log('[eInvoice] Tạo hóa đơn, payload:', JSON.stringify(payload));
  const invoiceRes = await fetch(`${EINVOICE_BASE}/v1/invoices/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const invoiceData = await invoiceRes.json();
  console.log('[eInvoice] Create resp:', invoiceRes.status, JSON.stringify(invoiceData));
  return invoiceData?.data || null;
}

/* ── Webhook handler ── */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'] || '';
  const expectedToken = process.env.SEPAY_API_KEY;
  if (expectedToken && authHeader !== `Apikey ${expectedToken}`) {
    console.warn('[Webhook] Auth thất bại:', authHeader);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  console.log('[Webhook] Nhận:', JSON.stringify(body));

  const content = body.content || body.description || '';
  const transferAmount = Number(body.transferAmount || body.amount || 0);

  const match = content.match(ORDER_CODE_REGEX);
  if (!match) {
    console.log('[Webhook] Không tìm thấy mã CGMN trong:', content);
    return res.status(200).json({ success: false, message: 'Không tìm thấy mã đơn hàng' });
  }

  const orderCode = match[0].toUpperCase();
  console.log('[Webhook] Mã đơn:', orderCode, '| Số tiền:', transferAmount);

  if (transferAmount < PRICE) {
    console.warn('[Webhook] Số tiền không đủ:', transferAmount, '< ', PRICE);
    return res.status(200).json({ success: false, message: 'Số tiền không đủ' });
  }

  const raw = await kvGet(`order:${orderCode}`);
  if (!raw) {
    console.warn('[Webhook] Không tìm thấy đơn:', orderCode);
    return res.status(200).json({ success: false, message: 'Không tìm thấy đơn hàng' });
  }

  const order = JSON.parse(raw);
  if (order.status === 'paid') {
    console.log('[Webhook] Đơn đã thanh toán trước đó:', orderCode);
    return res.status(200).json({ success: true, message: 'Đã xử lý trước đó' });
  }

  const paidAt = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  order.status = 'paid';
  order.paidAt = paidAt;
  order.transferAmount = transferAmount;
  await kvSet(`order:${orderCode}`, JSON.stringify(order), 86400 * 30);
  console.log('[Webhook] Đã cập nhật paid:', orderCode);

  const counter = await kvIncr('cgmn_invoice_counter');
  const invoiceNumber = `HD-CGMN-2026-${String(counter).padStart(4, '0')}`;

  let einvoiceData = null;
  try {
    einvoiceData = await createEInvoice({ order, transferAmount });
    if (einvoiceData) {
      order.invoiceTrackingCode = einvoiceData.tracking_code || null;
      order.invoiceNumber = invoiceNumber;
      await kvSet(`order:${orderCode}`, JSON.stringify(order), 86400 * 30);
      console.log('[eInvoice] ✅ tracking_code:', einvoiceData.tracking_code);
    } else {
      console.warn('[eInvoice] ⚠️ Không tạo được hóa đơn (xem log trên)');
    }
  } catch (err) {
    console.error('[eInvoice] ❌ Lỗi:', err.message);
  }

  const pdfUrl = process.env.PRODUCT_PDF_URL || '#';

  try {
    await sendEmail({
      to: order.email,
      subject: `✅ Thanh toán thành công — Cẩm Nang Giải Mã Nhân Tính`,
      html: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><style>
body{font-family:'Segoe UI',Georgia,serif;background:#0C0C0C;color:#FAF8F4;margin:0;padding:0}
.wrap{max-width:520px;margin:0 auto;padding:40px 24px}
.brand{font-size:11px;letter-spacing:3px;color:rgba(184,147,58,0.7);text-transform:uppercase;margin-bottom:32px}
h1{font-size:24px;font-weight:300;margin-bottom:6px;line-height:1.3}
h1 em{font-style:italic;color:#C0392B}
p{font-size:14px;color:rgba(250,248,244,0.6);line-height:1.8;margin-bottom:16px}
.box{background:#131210;border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:20px 24px;margin:20px 0}
.box-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px}
.box-row:last-child{border-bottom:none}
.box-label{color:rgba(250,248,244,0.4)}
.box-val{color:#FAF8F4;font-weight:500}
.invoice-num{color:rgba(184,147,58,0.9);font-weight:600}
.dl-btn{display:block;background:#C0392B;color:#fff;text-align:center;padding:16px;border-radius:6px;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:.5px;margin:24px 0}
.note{font-size:11px;color:rgba(138,133,126,0.6);line-height:1.7}
.footer{margin-top:32px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:rgba(138,133,126,0.4);text-align:center}
</style></head><body><div class="wrap">
<div class="brand">Hanadola Media & Technology · Góc Tĩnh Lặng</div>
<h1>Cảm ơn bạn, <em>${order.name}</em>!</h1>
<p>Thanh toán của bạn đã được xác nhận. Dưới đây là thông tin đơn hàng và đường dẫn tải về tài liệu số.</p>
<div class="box">
  <div class="box-row"><span class="box-label">Sản phẩm</span><span class="box-val">Cẩm Nang Giải Mã Nhân Tính</span></div>
  <div class="box-row"><span class="box-label">Mã đơn hàng</span><span class="box-val">${orderCode}</span></div>
  <div class="box-row"><span class="box-label">Số hóa đơn</span><span class="box-val invoice-num">${invoiceNumber}</span></div>
  <div class="box-row"><span class="box-label">Số tiền</span><span class="box-val">149.000 đ</span></div>
  <div class="box-row"><span class="box-label">Thanh toán lúc</span><span class="box-val">${paidAt}</span></div>
</div>
<a href="${pdfUrl}" class="dl-btn">📥 Tải về Cẩm Nang ngay</a>
<p class="note">
  🔒 Tài liệu này được cấp phép cho cá nhân bạn. Vui lòng không chia sẻ hoặc phân phối lại.<br>
  Nếu cần hỗ trợ, liên hệ: <strong style="color:#FAF8F4">admin@hanadola.com</strong> hoặc Zalo <strong style="color:#FAF8F4">0935 251 866</strong>
</p>
<div class="footer">© 2026 Công ty TNHH Hanadola Media & Technology<br>P903, Tầng 9, Diamond Plaza, 34 Lê Duẩn, TP.HCM · MST: 0319352856</div>
</div></body></html>`,
    });
  } catch (err) {
    console.error('[Email] Lỗi gửi email khách:', err.message);
  }

  const notifyEmail = process.env.NOTIFY_EMAIL;
  if (notifyEmail) {
    try {
      await sendEmail({
        to: notifyEmail,
        subject: `[CGMN] Đơn hàng mới — ${orderCode} — ${order.name}`,
        html: `<div style="font-family:'Segoe UI',sans-serif;max-width:480px;padding:24px;background:#0C0C0C;color:#FAF8F4;border-radius:8px">
<h2 style="color:#C0392B;font-size:18px;margin-bottom:16px">💰 Đơn hàng mới — Cẩm Nang GMN</h2>
<table style="width:100%;border-collapse:collapse;font-size:13px">
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(250,248,244,0.5);width:40%">Khách hàng</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-weight:600">${order.name}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(250,248,244,0.5)">Email</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">${order.email}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(250,248,244,0.5)">Điện thoại</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">${order.phone}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(250,248,244,0.5)">Mã đơn</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:#E8C97A;font-weight:600">${orderCode}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:rgba(250,248,244,0.5)">Số hóa đơn</td><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);color:#E8C97A">${invoiceNumber}</td></tr>
  <tr><td style="padding:8px 0;color:rgba(250,248,244,0.5)">Thanh toán lúc</td><td style="padding:8px 0">${paidAt}</td></tr>
</table>
</div>`,
      });
    } catch (err) {
      console.error('[Email] Lỗi gửi admin:', err.message);
    }
  }

  return res.status(200).json({ success: true, orderCode, invoiceNumber });
};
