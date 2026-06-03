const PROPERTY_ID = '532661238';

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GA4_CLIENT_ID,
      client_secret: process.env.GA4_CLIENT_SECRET,
      refresh_token: process.env.GA4_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('No se pudo obtener access token: ' + JSON.stringify(data));
  return data.access_token;
}

async function runReport(accessToken, dateRange, metrics, dimensions = []) {
  const body = {
    dateRanges: [dateRange],
    metrics: metrics.map(name => ({ name })),
  };
  if (dimensions.length) body.dimensions = dimensions.map(name => ({ name }));

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA4 API error: ${err}`);
  }
  return res.json();
}

function getValue(report, row = 0, col = 0) {
  try { return report.rows[row].metricValues[col].value; }
  catch { return '0'; }
}

function formatDuration(seconds) {
  const s = Math.round(Number(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function pct(curr, prev) {
  const c = Number(curr), p = Number(prev);
  if (!p) return '+0.0%';
  const diff = ((c - p) / p) * 100;
  return (diff >= 0 ? '+' : '') + diff.toFixed(1) + '%';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Autenticación simple por token
  const token = req.headers['x-dashboard-token'];
  if (token !== process.env.DASHBOARD_TOKEN) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const period = req.query.period || '30d';
  const dateRangeMap = {
    '7d':  { startDate: '7daysAgo',  endDate: 'today' },
    '30d': { startDate: '30daysAgo', endDate: 'today' },
    '90d': { startDate: '90daysAgo', endDate: 'today' },
  };
  const dateRange = dateRangeMap[period] || dateRangeMap['30d'];
  const daysMap = { '7d': 7, '30d': 30, '90d': 90 };
  const days = daysMap[period] || 30;
  const prevRange = {
    startDate: `${days * 2}daysAgo`,
    endDate:   `${days + 1}daysAgo`,
  };

  try {
    const accessToken = await getAccessToken();

    const [current, previous, events] = await Promise.all([
      runReport(accessToken, dateRange, ['totalUsers', 'screenPageViews', 'averageSessionDuration', 'bounceRate']),
      runReport(accessToken, prevRange, ['totalUsers', 'screenPageViews', 'averageSessionDuration', 'bounceRate']),
      runReport(accessToken, dateRange, ['eventCount'], ['eventName']),
    ]);

    const visitors    = getValue(current, 0, 0);
    const pageviews   = getValue(current, 0, 1);
    const duration    = getValue(current, 0, 2);
    const bounce      = getValue(current, 0, 3);
    const pVisitors   = getValue(previous, 0, 0);
    const pPageviews  = getValue(previous, 0, 1);
    const pDuration   = getValue(previous, 0, 2);
    const pBounce     = getValue(previous, 0, 3);

    // WhatsApp clicks desde eventos
    let waClicks = 0;
    if (events.rows) {
      const row = events.rows.find(r => r.dimensionValues[0].value === 'whatsapp_clicked');
      if (row) waClicks = Number(row.metricValues[0].value);
    }

    const bounceDiff = Number(bounce) - Number(pBounce);
    const bounceChange = (bounceDiff >= 0 ? '+' : '') + (bounceDiff * 100).toFixed(1) + '%';

    res.status(200).json({
      period,
      visitors:        Number(visitors),
      pageviews:       Number(pageviews),
      time:            formatDuration(duration),
      bounce:          (Number(bounce) * 100).toFixed(1) + '%',
      wa:              waClicks,
      visitorsChange:  pct(visitors,  pVisitors),
      pageviewsChange: pct(pageviews, pPageviews),
      timeChange:      pct(duration,  pDuration),
      bounceChange,
      waChange:        '+0.0%',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
