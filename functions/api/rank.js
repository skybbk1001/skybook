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

function getSqlApiConfig(env) {
  const accountId = env.AE_ACCOUNT_ID || "";
  const apiToken = env.AE_API_TOKEN || "";
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken };
}

function formatSqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function formatSqlWithParams(sql, params = []) {
  if (!params.length) return sql;
  let index = 0;
  return sql.replace(/\?/g, () => formatSqlValue(params[index++]));
}

async function runSqlApi(env, sql, params = []) {
  const config = getSqlApiConfig(env);
  if (!config) {
    throw new Error("Missing Analytics Engine SQL API credentials.");
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`;
  const finalSql = formatSqlWithParams(sql, params);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      "content-type": "text/plain; charset=utf-8",
    },
    body: finalSql,
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
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  const hasExt = /\.[a-zA-Z0-9]+$/.test(path);
  if (path !== "/" && !hasExt && !path.endsWith("/")) path += "/";
  return path;
}

function formatSqlDateTime(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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
    dayStart: formatSqlDateTime(dayStart),
    weekStart: formatSqlDateTime(weekStart),
    monthStart: formatSqlDateTime(monthStart),
  };
}

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

async function queryNumber(env, sql, params, key, fallback = 0) {
  try {
    const result = await runSqlApi(env, sql, params);
    return getNumber(unwrapRows(result), key);
  } catch (err) {
    console.error("Analytics query failed:", err);
    return fallback;
  }
}

async function queryRows(env, sql, params) {
  try {
    const result = await runSqlApi(env, sql, params);
    return unwrapRows(result);
  } catch (err) {
    console.error("Analytics query failed:", err);
    return [];
  }
}

export async function onRequestGet({ env }) {
  const { dayStart, weekStart, monthStart } = getShanghaiRanges();

  const [total, month, week, day, pages] = await Promise.all([
    queryNumber(env, `SELECT SUM(double1) AS pv FROM ${TABLE}`, [], "pv", 0),
    queryNumber(
      env,
      `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE timestamp >= toDateTime(?)`,
      [monthStart],
      "pv",
      0
    ),
    queryNumber(
      env,
      `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE timestamp >= toDateTime(?)`,
      [weekStart],
      "pv",
      0
    ),
    queryNumber(
      env,
      `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE timestamp >= toDateTime(?)`,
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
  });
}
