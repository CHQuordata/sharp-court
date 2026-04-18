const ALLOWED_ORIGIN = 'https://chquordata.github.io';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.status(200).json({ status: 'ok', version: '1.0', region: process.env.VERCEL_REGION || 'unknown' });
}
