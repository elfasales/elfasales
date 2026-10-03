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
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
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
  await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT ''");
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
         "SELECT id, city, name, mg, ml, description, qty, in_stock, photo, price, brand FROM products ORDER BY name",
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
        if (req.method === "PUT" && url.pathname === "/api/products") {
      if (!isAdmin(req.headers["x-telegram-init"])) {
        send(res, 403, { error: "Только админ" });
        return;
      }
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const ml = Number(body.ml);
      const mg = Number(body.mg);
      const qty = Number(body.qty);
      if (!body.id || !name || !ml || !Number.isFinite(mg)) {
        send(res, 400, { error: "Заполни название, крепость и миллилитры" });
        return;
      }
      await readyDb();
      const current = await pool.query("SELECT photo FROM products WHERE id = $1", [body.id]);
      const oldPhoto = current.rows[0] ? current.rows[0].photo : "";
      await pool.query(
        `UPDATE products SET city=$2, name=$3, mg=$4, ml=$5, description=$6, qty=$7, in_stock=$8, photo=$9, price=$10 WHERE id=$1`,
        [
          body.id,
          body.city === "tubingen" ? "tubingen" : "reutlingen",
          name,
          mg,
          ml,
          String(body.description || "").trim(),
          Number.isFinite(qty) ? qty : 0,
          Boolean(body.inStock),
          body.photo ? String(body.photo) : oldPhoto,
          Number(body.price) || 0,
        ],
      );
      send(res, 200, { id: body.id });
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
        if (req.method === "POST" && url.pathname === "/api/orders") {
      const initData = String(req.headers["x-telegram-init"] || "");
      const params = new URLSearchParams(initData);
      const hash = params.get("hash");
      let customer = null;
      if (hash) {
        const pairs = [];
        for (const [key, value] of params.entries()) {
          if (key !== "hash") pairs.push(`${key}=${value}`);
        }
        pairs.sort();
        const secret = createHmac("sha256", "WebAppData").update(token).digest();
        const check = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
        if (check === hash) {
          try { customer = JSON.parse(params.get("user") || "null"); } catch { customer = null; }
        }
      }
      if (!customer || !customer.id) {
        send(res, 403, { error: "Открой магазин из бота" });
        return;
      }
      const ban = await pool.query("SELECT blocked FROM clients WHERE user_id = $1", [String(customer.id)]);
      if (ban.rows[0] && ban.rows[0].blocked) {
        send(res, 403, { error: "Вы заблокированы" });
        return;
      }    
      const body = await readBody(req);
      const payment = body.payment === "bank" ? "bank" : body.payment === "cash" ? "cash" : "";
      if (!payment) {
        send(res, 400, { error: "Выбери оплату" });
        return;
      }
      await readyDb();
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment TEXT NOT NULL DEFAULT ''");
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT ''");
      const lines = [];
      let total = 0;
      for (const raw of body.items || []) {
        const qty = Number(raw.qty);
        if (!qty) continue;
        const found = await pool.query("SELECT id, name, price, qty FROM products WHERE id = $1", [raw.id]);
        const product = found.rows[0];
        if (!product || Number(product.qty) < qty) {
          send(res, 400, { error: "Не хватает: " + (product ? product.name : "товар") });
          return;
        }
        lines.push({ id: product.id, name: product.name, qty, price: Number(product.price) });
        total += Number(product.price) * qty;
      }
      if (!lines.length) {
        send(res, 400, { error: "Корзина пустая" });
        return;
      }
      const id = "ES-" + randomUUID().slice(0, 6).toUpperCase();
      const userName = [customer.first_name, customer.last_name].filter(Boolean).join(" ");
      const username = customer.username || "";
      await pool.query(
        `INSERT INTO orders (id, user_id, user_name, username, city, items, total, payment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, String(customer.id), userName, username, body.city || "", JSON.stringify(lines), total, payment],
      );
      for (const line of lines) {
        await pool.query(
          "UPDATE products SET qty = qty - $2, in_stock = (qty - $2) > 0 WHERE id = $1",
          [line.id, line.qty],
        );
      }
      send(res, 200, { id });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/orders") {
      if (!isAdmin(req.headers["x-telegram-init"])) {
        send(res, 403, { error: "Только админ" });
        return;
      }
      await readyDb();
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment TEXT NOT NULL DEFAULT ''");
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT ''");
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'");
      const { rows } = await pool.query(
        "SELECT id, created_at, user_id, user_name, username, city, items, total, payment, status FROM orders ORDER BY created_at DESC",
      );
      send(res, 200, rows);
      return;
    }
        if (req.method === "POST" && url.pathname === "/api/orders/status") {
      if (!isAdmin(req.headers["x-telegram-init"])) {
        send(res, 403, { error: "Только админ" });
        return;
      }
      const body = await readBody(req);
      const status = body.status === "done" ? "done" : body.status === "cancelled" ? "cancelled" : "";
      if (!body.id || !status) {
        send(res, 400, { error: "Нет статуса" });
        return;
      }
      await readyDb();
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'");
      const found = await pool.query("SELECT id, user_id FROM orders WHERE id = $1", [body.id]);
      const order = found.rows[0];
      if (!order) {
        send(res, 404, { error: "Заказ не найден" });
        return;
      }
      await pool.query("UPDATE orders SET status = $2 WHERE id = $1", [body.id, status]);
      const text = status === "done"
        ? `Ваш заказ ${order.id} выполнен.`
        : `Ваш заказ ${order.id} отменён.`;
      try {
        await apiCall("sendMessage", { chat_id: order.user_id, text });
      } catch (err) {
        console.log("Сообщение:", err instanceof Error ? err.message : err);
      }
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/orders") {
      if (!isAdmin(req.headers["x-telegram-init"])) {
        send(res, 403, { error: "Только админ" });
        return;
      }
      await readyDb();
      await pool.query("DELETE FROM orders WHERE id = $1", [url.searchParams.get("id")]);
      send(res, 200, { ok: true });
      return;
    }
        if (req.method === "GET" && url.pathname === "/api/my-orders") {
      const initData = String(req.headers["x-telegram-init"] || "");
      const params = new URLSearchParams(initData);
      const hash = params.get("hash");
      let customer = null;
      if (hash) {
        const pairs = [];
        for (const [key, value] of params.entries()) {
          if (key !== "hash") pairs.push(`${key}=${value}`);
        }
        pairs.sort();
        const secret = createHmac("sha256", "WebAppData").update(token).digest();
        const check = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
        if (check === hash) {
          try { customer = JSON.parse(params.get("user") || "null"); } catch { customer = null; }
        }
      }
      if (!customer || !customer.id) {
        send(res, 403, { error: "Открой магазин из бота" });
        return;
      }
            await readyDb();
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS clients (
          user_id TEXT PRIMARY KEY,
          num INT NOT NULL
        )
      `);
      const existing = await pool.query("SELECT num FROM clients WHERE user_id = $1", [String(customer.id)]);
      let num = existing.rows[0] && existing.rows[0].num;
      if (!num) {
        const next = await pool.query("SELECT COALESCE(MAX(num), 0) + 1 AS n FROM clients");
        num = next.rows[0].n;
        await pool.query("INSERT INTO clients (user_id, num) VALUES ($1, $2)", [String(customer.id), num]);
      }
      const { rows } = await pool.query(
        "SELECT items, status FROM orders WHERE user_id = $1",
        [String(customer.id)],
      );
      let bought = 0;
      let active = 0;
      for (const order of rows) {
        const items = Array.isArray(order.items) ? order.items : [];
        if (order.status === "done") {
          for (const item of items) bought += Number(item.qty) || 0;
        } else if (!order.status || order.status === "new") {
          active += 1;
        }
      }
      send(res, 200, { code: "ELS-" + num, bought, active });
      return;
    }
        if (req.method === "GET" && url.pathname === "/api/clients") {
      if (!isAdmin(req.headers["x-telegram-init"])) {
        send(res, 403, { error: "Только админ" });
        return;
      }
      await readyDb();
      await pool.query("CREATE TABLE IF NOT EXISTS clients (user_id TEXT PRIMARY KEY, num INT NOT NULL)");
      await pool.query("ALTER TABLE clients ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT ''");
      await pool.query("ALTER TABLE clients ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT ''");
      await pool.query("ALTER TABLE clients ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT false");
      const { rows } = await pool.query("SELECT user_id, num, name, username, blocked FROM clients ORDER BY num");
      send(res, 200, rows);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/clients/block") {
      if (!isAdmin(req.headers["x-telegram-init"])) {
        send(res, 403, { error: "Только админ" });
        return;
      }
      const body = await readBody(req);
      if (Number(body.id) === ADMIN_ID) {
        send(res, 400, { error: "Нельзя блокировать админа" });
        return;
      }
      await readyDb();
      await pool.query("UPDATE clients SET blocked = $2 WHERE user_id = $1", [String(body.id), Boolean(body.blocked)]);
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/mail") {
  if (!isAdmin(req.headers["x-telegram-init"])) {
    send(res, 403, { error: "Только админ" });
    return;
  }
  const body = await readBody(req);
  const text = String(body.text || "").trim();
  if (!text) {
    send(res, 400, { error: "Напиши текст" });
    return;
  }
  await readyDb();
  const { rows } = await pool.query("SELECT user_id, name, username FROM clients WHERE blocked = false");
  let sent = 0;
  const missed = [];
  for (const person of rows) {
    try {
      await apiCall("sendMessage", { chat_id: person.user_id, text: text.slice(0, 1000) });
      sent += 1;
    } catch {
      const who = person.name || "Без имени";
      const nick = person.username ? " @" + person.username : "";
      missed.push(who + nick);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  send(res, 200, { sent, failed: missed.length, missed });
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
      const from = update.message.from || {};
      const userId = String(from.id || chatId);
      const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
      const username = from.username || "";
      let blocked = false;
      try {
        await readyDb();
        await pool.query("CREATE TABLE IF NOT EXISTS clients (user_id TEXT PRIMARY KEY, num INT NOT NULL)");
        await pool.query("ALTER TABLE clients ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT ''");
        await pool.query("ALTER TABLE clients ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT ''");
        await pool.query("ALTER TABLE clients ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT false");
        const existing = await pool.query("SELECT blocked FROM clients WHERE user_id = $1", [userId]);
        if (existing.rows[0]) {
          blocked = Boolean(existing.rows[0].blocked);
          await pool.query("UPDATE clients SET name = $2, username = $3 WHERE user_id = $1", [userId, name, username]);
        } else {
          const next = await pool.query("SELECT COALESCE(MAX(num), 0) + 1 AS n FROM clients");
          await pool.query(
            "INSERT INTO clients (user_id, num, name, username, blocked) VALUES ($1,$2,$3,$4,false)",
            [userId, next.rows[0].n, name, username],
          );
        }
      } catch (err) {
        console.log("Клиент:", err instanceof Error ? err.message : err);
      }
      if (blocked) {
        await apiCall("sendMessage", { chat_id: chatId, text: "Вы заблокированы. Магазин недоступен." });
        continue;
      }
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
