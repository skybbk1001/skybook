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

function resolvePath(pageParam, baseUrl) {
  if (!pageParam) return "/";
  try {
    return new URL(pageParam, baseUrl).pathname || "/";
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

async function recordPageView(env, path, visitorId) {
  try {
    await env.ANALYTICS.writeDataPoint({
      indexes: [path],
      blobs: [visitorId],
      doubles: [1],
    });
    return null;
  } catch (err) {
    console.error("writeDataPoint failed:", err);
    return err;
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
  const pageParam = url.searchParams.get("page") || "";
  const pagePath = normalizePath(resolvePath(pageParam, request.url));

  const visitorId = await getVisitorId(request);
  const writeError = await recordPageView(env, pagePath, visitorId);
  if (debugEnabled) {
    debug.pagePath = pagePath;
    debug.writeError = writeError ? stringifyError(writeError) : "";
  }

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

  if (debugEnabled) {
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

    try {
      const result = await runQuery(
        env.ANALYTICS,
        `SELECT timestamp, index1, double1 FROM ${TABLE} ORDER BY timestamp DESC LIMIT 1`,
        []
      );
      const rows = unwrapRows(result);
      debug.latest = rows && rows.length ? rows[0] : null;
    } catch (err) {
      debug.latestError = stringifyError(err);
    }
  }

  return jsonResponse({
    page_pv: pagePv,
    site_pv: sitePv,
    site_uv: siteUv,
    ...(debugEnabled ? { debug } : {}),
  });
}
