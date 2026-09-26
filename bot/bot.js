import { readFileSync } from "node:fs";

function loadToken() {
  if (process.env.BOT_TOKEN && !process.env.BOT_TOKEN.includes("сюда")) {
    return process.env.BOT_TOKEN.trim();
  }
  try {
    const raw = readFileSync(new URL("./.env", import.meta.url), "utf8");
    const line = raw.split(/\r?\n/).find((l) => l.startsWith("BOT_TOKEN="));
    const token = line?.slice("BOT_TOKEN=".length).trim();
    if (token && !token.includes("сюда")) return token;
  } catch {
    // на сервере файла .env нет, токен берётся из настроек
  }
  console.log("Нет токена.");
  process.exit(1);
}

const token = loadToken();
const api = `https://api.telegram.org/bot${token}`;
let offset = 0;

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
        text: "ElfaSales. Магазин открывается кнопкой «Магазин» слева внизу.",
      });
    }
  } catch (err) {
    console.log("Ошибка:", err instanceof Error ? err.message : err);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
