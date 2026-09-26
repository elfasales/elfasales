import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import pg from "pg";

function loadToken() {
  const id = process.env.BOT_ID && process.env.BOT_ID.trim();
  const key = process.env.BOT_KEY && process.env.BOT_KEY.trim();
  if (id && key) return id + ":" + key;
  try {
    const raw = readFileSync(new URL("./.env", import.meta.url), "utf8");
    const line = raw.split(/\r?\n/).find((l) => l.startsWith("BOT_TOKEN="));
    const token = line?.slice("BOT_TOKEN=".length).trim();
    if (token && !token.includes("сюда")) return token;
  } catch {
    // на сервере файла .env нет
  }
  console.log("Нет токена.");
  process.exit(1);
}

const ADMIN_ID = 7648089072;
const token = loadToken();
const api = `https://api.telegram.org/bot${token}`;
let offset = 0;
const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("railway.internal") ? false : { rejectUnauthorized: false },
    })
  : null;

async function apiCall(method, body) {
  const res = await fetch(`${api}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || method);
  return data.result;
}

function isAdmin(initData) {
  if (!initData) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;
  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key !== "hash") pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const check = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  if (check !== hash) return false;
  try {
    const user = JSON.parse(params.get("user") || "{}");
    return Number(user.id) === ADMIN_ID;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 6000000) {
        reject(new Error("Фото слишком большое"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-telegram-init",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function readyDb() {
  if (!pool) throw new Error("Нет DATABASE_URL");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      city TEXT NOT NULL,
      name TEXT NOT NULL,
      mg INT NOT NULL,
      ml INT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      qty INT NOT NULL DEFAULT 0,
      in_stock BOOLEAN NOT NULL DEFAULT true,
      photo TEXT NOT NULL DEFAULT ''
    )
  `);
  await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS price INT NOT NULL DEFAULT 0");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id TEXT,
      user_name TEXT,
      city TEXT,
      items JSONB NOT NULL DEFAULT '[]',
      total INT NOT NULL DEFAULT 0
    )
  `);
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 200, { ok: true });
    return;
  }
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      send(res, 200, { ok: true, name: "ElfaSales API" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/products") {
      await readyDb();
      const { rows } = await pool.query(
        "SELECT id, city, name, mg, ml, description, qty, in_stock, photo, price FROM products
      );
      send(res, 200, rows);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/products") {
      if (!isAdmin(req.headers["x-telegram-init"])) {
        send(res, 403, { error: "Только админ" });
        return;
      }
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const ml = Number(body.ml);
      const mg = Number(body.mg);
      const qty = Number(body.qty);
      const price = Number(body.price || 0);
      if (!name || !ml || !Number.isFinite(mg)) {
        send(res, 400, { error: "Заполни название, крепость и миллилитры" });
        return;
      }
      await readyDb();
      const id = randomUUID();
      await pool.query(
        `INSERT INTO products (id, city, name, mg, ml, description, qty, in_stock, photo, price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          body.city === "tubingen" ? "tubingen" : "reutlingen",
          name,
          mg,
          ml,
          String(body.description || "").trim(),
          Number.isFinite(qty) ? qty : 0,
          Boolean(body.inStock),
          String(body.photo || ""),
          Number(body.price) || 0,
        ],
      );
      send(res, 200, { id });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/products") {
      if (!isAdmin(req.headers["x-telegram-init"])) {
        send(res, 403, { error: "Только админ" });
        return;
      }
      await readyDb();
      await pool.query("DELETE FROM products WHERE id = $1", [url.searchParams.get("id")]);
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/api/orders" || url.pathname === "/api/clients")) {
      if (!isAdmin(req.headers["x-telegram-init"])) {
        send(res, 403, { error: "Только админ" });
        return;
      }
      await readyDb();
      send(res, 200, []);
      return;
    }
    send(res, 404, { error: "Нет такого адреса" });
  } catch (err) {
    console.log("API:", err instanceof Error ? err.message : err);
    send(res, 500, { error: err instanceof Error ? err.message : "Ошибка базы" });
  }
});

const port = Number(process.env.PORT) || 8080;
server.listen(port, "0.0.0.0", () => console.log("API слушает порт", port));
console.log("Бот слушает /start.");

while (true) {
  try {
    const updates = await apiCall("getUpdates", { offset, timeout: 30 });
    for (const update of updates) {
      offset = update.update_id + 1;
      const text = update.message?.text ?? "";
      const chatId = update.message?.chat?.id;
      if (!chatId || !text.startsWith("/start")) continue;
      await apiCall("sendMessage", {
        chat_id: chatId,
        text: "Добро пожаловать!\nОткройте mini-app чтобы оформить заказ!",
        reply_markup: {
          inline_keyboard: [[
            { text: "Открыть магазин", web_app: { url: "https://elfasales.vercel.app" } },
          ]],
        },
      });
    }
  } catch (err) {
    console.log("Ошибка:", err instanceof Error ? err.message : err);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
