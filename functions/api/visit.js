const TABLE = "ANALYTICS";
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

function resolvePath(pageParam, baseUrl) {
  const raw = (pageParam || "").trim();
  if (!raw) return "/";
  let decoded = raw;
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch (err) {
      break;
    }
  }
  try {
    if (/^https?:\/\//i.test(decoded)) {
      return new URL(decoded).pathname || "/";
    }
    if (decoded.startsWith("/")) return decoded;
    return new URL(decoded, baseUrl).pathname || "/";
  } catch (err) {
    return "/";
  }
}
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getVisitorId(request) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ua = request.headers.get("user-agent") || "";
  if (!ip && !ua) return "anonymous";
  return sha256Hex(`${ip}|${ua}`);
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

async function recordPageView(env, path, visitorId) {
  try {
    await env.ANALYTICS.writeDataPoint({
      indexes: [path],
      blobs: [visitorId],
      doubles: [1],
    });
  } catch (err) {
    console.error("writeDataPoint failed:", err);
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.ANALYTICS) {
    return jsonResponse({ error: "Missing ANALYTICS binding." }, 500);
  }

  const url = new URL(request.url);
  const pageParam = url.searchParams.get("page") || "";
  const pagePath = normalizePath(resolvePath(pageParam, request.url));

  const visitorId = await getVisitorId(request);
  await recordPageView(env, pagePath, visitorId);

  const [pagePv, sitePv] = await Promise.all([
    queryNumber(
      env,
      `SELECT SUM(double1) AS pv FROM ${TABLE} WHERE index1 = ?`,
      [pagePath],
      "pv",
      0
    ),
    queryNumber(env, `SELECT SUM(double1) AS pv FROM ${TABLE}`, [], "pv", 0),
  ]);

  const siteUv = await queryNumber(
    env,
    `SELECT COUNT(DISTINCT blob1) AS uv FROM ${TABLE}`,
    [],
    "uv",
    sitePv
  );

  return jsonResponse({
    page_pv: pagePv,
    site_pv: sitePv,
    site_uv: siteUv,
  });
}

