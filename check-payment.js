// api/check-payment.js — Cẩm Nang Giải Mã Nhân Tính
// CommonJS – fetch thuần, không npm packages

async function kvGet(key) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const data = await r.json();
  return data.result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { orderCode } = req.query;
  if (!orderCode || !/^CGMN[A-Z0-9]{4}$/i.test(orderCode)) {
    return res.status(400).json({ error: 'Mã đơn hàng không hợp lệ' });
  }

  const raw = await kvGet(`order:${orderCode}`);
  if (!raw) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

  const order = JSON.parse(raw);
  return res.status(200).json({
    status: order.status,
    orderCode: order.orderCode,
    paidAt: order.paidAt || null,
  });
};
