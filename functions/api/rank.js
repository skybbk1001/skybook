const TABLE = "ANALYTICS";
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const LIMIT = 200;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function stringifyError(err) {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  return String(err);
}

function normalizePath(input) {
  let path = (input || "").trim();
  if (!path) return "/";
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  const hasExt = /\.[a-zA-Z0-9]+$/.test(path);
  if (path !== "/" && !hasExt && !path.endsWith("/")) path += "/";
  return path;
}

function getShanghaiRanges() {
  const now = new Date(Date.now() + TZ_OFFSET_MS);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();
  const dayOfWeek = now.getUTCDay();
  const dayStart = new Date(Date.UTC(year, month, date) - TZ_OFFSET_MS);
  const weekStart = new Date(
    Date.UTC(year, month, date - ((dayOfWeek + 6) % 7)) - TZ_OFFSET_MS
  );
  const monthStart = new Date(Date.UTC(year, month, 1) - TZ_OFFSET_MS);

  return {
    dayStart: dayStart.toISOString(),
    weekStart: weekStart.toISOString(),
    monthStart: monthStart.toISOString(),
  };
}

async function runQuery(binding, sql, params = []) {
  try {
    return await binding.query({ sql, params });
  } catch (err) {
    return await binding.query(sql, params);
  }
}

function unwrapRows(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.results)) return result.results;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.rows)) return result.rows;
  return [];
}

function getNumber(rows, key) {
  const row = rows && rows.length ? rows[0] : null;
  if (!row) return 0;
  const value = key in row ? row[key] : row[Object.keys(row)[0]];
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

async function queryNumber(env, sql, params, key, fallback = 0) {
  try {
    const result = await runQuery(env.ANALYTICS, sql, params);
    return getNumber(unwrapRows(result), key);
  } catch (err) {
    console.error("Analytics query failed:", err);
    return fallback;
  }
}

async function queryRows(env, sql, params) {
  try {
    const result = await runQuery(env.ANALYTICS, sql, params);
    return unwrapRows(result);
  } catch (err) {
    console.error("Analytics query failed:", err);
    return [];
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.ANALYTICS) {
    return jsonResponse({ error: "Missing ANALYTICS binding." }, 500);
  }

  const url = new URL(request.url);
  const debugEnabled = url.searchParams.get("debug") === "1";
  const debug = debugEnabled
    ? {
        table: TABLE,
        queryAvailable: typeof env.ANALYTICS.query === "function",
      }
    : null;

  const { dayStart, weekStart, monthStart } = getShanghaiRanges();

  const [total, month, week, day, pages] = await Promise.all([
    queryNumber(env, `SELECT SUM(double1) AS pv FROM ${TABLE}`, [], "pv", 0),
    queryNumber(
      env,
      `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE timestamp >= ?`,
      [monthStart],
      "pv",
      0
    ),
    queryNumber(
      env,
      `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE timestamp >= ?`,
      [weekStart],
      "pv",
      0
    ),
    queryNumber(
      env,
      `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE timestamp >= ?`,
      [dayStart],
      "pv",
      0
    ),
    queryRows(
      env,
      `SELECT index1 AS path, SUM(double1) AS pv FROM ${TABLE} GROUP BY index1 ORDER BY pv DESC LIMIT ${LIMIT}`,
      []
    ),
  ]);

  if (debugEnabled) {
    debug.range = { dayStart, weekStart, monthStart };
    try {
      const result = await runQuery(
        env.ANALYTICS,
        `SELECT COUNT(*) AS total FROM ${TABLE}`,
        []
      );
      debug.count = getNumber(unwrapRows(result), "total");
    } catch (err) {
      debug.countError = stringifyError(err);
    }
  }

  const normalizedPages = pages
    .map((item) => {
      const path = normalizePath(item.path || item.index1 || "");
      return {
        path,
        pv: Number(item.pv) || 0,
      };
    })
    .filter((item) => item.path && item.path !== "/");

  return jsonResponse({
    summary: {
      total,
      month,
      week,
      day,
    },
    pages: normalizedPages,
    updatedAt: new Date().toISOString(),
    ...(debugEnabled ? { debug } : {}),
  });
}
