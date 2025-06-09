import * as dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  botToken: string;
  geminiApiKey: string;
  geminiApiUrl: string;
  logLevel?: string;
}

export const config: AppConfig = {
  botToken: process.env.BOT_TOKEN || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiApiUrl: process.env.GEMINI_API_URL || "https://generativelanguage.tifixixr.workers.dev/v1beta",
  logLevel: process.env.LOG_LEVEL || "info",
};

if (!config.botToken) {
  console.error(
    "КРИТИЧЕСКАЯ ОШИБКА: BOT_TOKEN не установлен в .env файле."
  );
  console.error("Пожалуйста, скопируйте .env.example в .env и заполните его.");
  process.exit(1);
}

if (!config.geminiApiKey) {
  console.error(
    "ПРЕДУПРЕЖДЕНИЕ: GEMINI_API_KEY не установлен в .env файле. Функции модерации будут ограничены."
  );
} 