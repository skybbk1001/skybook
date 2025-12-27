const TABLE = "ANALYTICS";
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

function getSqlApiConfig(env) {
  const accountId = env.AE_ACCOUNT_ID || "";
  const apiToken = env.AE_API_TOKEN || "";
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken };
}

async function runSqlApi(env, sql) {
  const config = getSqlApiConfig(env);
  if (!config) {
    throw new Error("Missing Analytics Engine SQL API credentials.");
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      "content-type": "text/plain; charset=utf-8",
    },
    body: sql,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Analytics Engine SQL API failed (${response.status}): ${text}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    const text = await response.text();
    throw new Error(`Analytics Engine SQL API invalid response: ${text}`);
  }
  if (payload && payload.success === false) {
    const message =
      payload.errors && payload.errors.length
        ? payload.errors[0].message
        : "Analytics Engine SQL API error";
    throw new Error(message);
  }
  return payload.result || payload;
}

function normalizePath(input) {
  let path = (input || "").trim();
  if (!path) return "/";
  try {
    path = encodeURI(decodeURI(path));
  } catch (err) {
    path = encodeURI(path);
  }
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  const hasExt = /\.[a-zA-Z0-9]+$/.test(path);
  if (path !== "/" && !hasExt && !path.endsWith("/")) path += "/";
  return path;
}

const ROLLING_DAY_MS = 24 * 60 * 60 * 1000;
const ROLLING_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ROLLING_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const PATH_WHERE = "blob2 IS NOT NULL AND blob2 != ''";

function unwrapRows(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.result)) return result.result;
  if (result.result && Array.isArray(result.result.data)) return result.result.data;
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

async function queryNumber(env, sql, key, fallback = 0) {
  try {
    const result = await runSqlApi(env, sql);
    return getNumber(unwrapRows(result), key);
  } catch (err) {
    console.error("Analytics query failed:", err);
    return fallback;
  }
}

async function queryRows(env, sql) {
  try {
    const result = await runSqlApi(env, sql);
    return unwrapRows(result);
  } catch (err) {
    console.error("Analytics query failed:", err);
    return [];
  }
}

function normalizePages(pages) {
  return (pages || [])
    .map((item) => {
      const path = normalizePath(item.path || "");
      return {
        path,
        pv: Number(item.pv) || 0,
      };
    })
    .filter((item) => item.path && item.path !== "/");
}

function formatUtcDate(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export async function onRequestGet({ env }) {
  const now = new Date();
  const dayStart = new Date(now.getTime() - ROLLING_DAY_MS);
  const weekStart = new Date(now.getTime() - ROLLING_WEEK_MS);
  const monthStart = new Date(now.getTime() - ROLLING_MONTH_MS);
  const daySql = `timestamp >= toDateTime('${formatUtcDate(dayStart)}')`;
  const weekSql = `timestamp >= toDateTime('${formatUtcDate(weekStart)}')`;
  const monthSql = `timestamp >= toDateTime('${formatUtcDate(monthStart)}')`;

  const [total, month, week, day, pagesTotal, pagesMonth, pagesWeek, pagesDay] =
    await Promise.all([
      queryNumber(
        env,
        `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE ${PATH_WHERE}`,
        "pv",
        0
      ),
      queryNumber(
        env,
        `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE ${monthSql} AND ${PATH_WHERE}`,
        "pv",
        0
      ),
      queryNumber(
        env,
        `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE ${weekSql} AND ${PATH_WHERE}`,
        "pv",
        0
      ),
      queryNumber(
        env,
        `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE ${daySql} AND ${PATH_WHERE}`,
        "pv",
        0
      ),
      queryRows(
        env,
        `SELECT blob2 AS path, SUM(double1) AS pv FROM ${TABLE} WHERE ${PATH_WHERE} GROUP BY blob2 ORDER BY pv DESC LIMIT ${LIMIT}`
      ),
      queryRows(
        env,
        `SELECT blob2 AS path, SUM(double1) AS pv FROM ${TABLE} WHERE ${monthSql} AND ${PATH_WHERE} GROUP BY blob2 ORDER BY pv DESC LIMIT ${LIMIT}`
      ),
      queryRows(
        env,
        `SELECT blob2 AS path, SUM(double1) AS pv FROM ${TABLE} WHERE ${weekSql} AND ${PATH_WHERE} GROUP BY blob2 ORDER BY pv DESC LIMIT ${LIMIT}`
      ),
      queryRows(
        env,
        `SELECT blob2 AS path, SUM(double1) AS pv FROM ${TABLE} WHERE ${daySql} AND ${PATH_WHERE} GROUP BY blob2 ORDER BY pv DESC LIMIT ${LIMIT}`
      ),
    ]);

  return jsonResponse({
    summary: {
      total,
      month,
      week,
      day,
    },
    pages: {
      total: normalizePages(pagesTotal),
      month: normalizePages(pagesMonth),
      week: normalizePages(pagesWeek),
      day: normalizePages(pagesDay),
    },
    updatedAt: new Date().toISOString(),
  });
}
