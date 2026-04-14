// api/create-order.js — Cẩm Nang Giải Mã Nhân Tính
// CommonJS – fetch thuần, không npm packages

const PRICE = 149000; // VND

function generateOrderCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'CGMN' + s;
}

async function kvSet(key, value, ex) {
  const r = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, value, 'EX', ex]),
  });
  return r;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, phone } = req.body || {};
  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Thiếu thông tin: name, email, phone' });
  }

  const orderCode = generateOrderCode();
  const orderData = {
    orderCode,
    name,
    email,
    phone,
    amount: PRICE,
    status: 'pending',
    createdAt: Date.now(),
  };

  // Lưu KV – TTL 2 giờ
  await kvSet(`order:${orderCode}`, JSON.stringify(orderData), 7200);
  console.log('[CreateOrder] Tạo đơn:', orderCode, '|', name, '|', email);

  return res.status(200).json({
    success: true,
    orderCode,
    amount: PRICE,
    bankCode: 'ACB',
    bankAccount: '20176968',
    accountName: 'CONG TY TNHH HANADOLA MEDIA AND TECHNOLOGY',
    description: `CGMN ${orderCode}`,
  });
};
