import { config } from "./config";
import { ModerationBot } from "./ModerationBot";

async function bootstrap() {
  console.log("Запуск ModBot...");
  console.log(`Версия Node.js: ${process.version}`);
  console.log(`Рабочая директория: ${process.cwd()}`);
  console.log("Конфигурация:", JSON.stringify({
    botToken: config.botToken ? `${config.botToken.slice(0, 5)}...` : "Не указан",
    geminiApiKey: config.geminiApiKey ? `${config.geminiApiKey.slice(0, 5)}...` : "Не указан",
    geminiApiUrl: config.geminiApiUrl,
    logLevel: config.logLevel
  }));
  
  const bot = new ModerationBot(config);
  try {
    // Telegraf регистрирует свои обработчики SIGINT/SIGTERM при вызове launch().
    // Нам все еще нужны наши, чтобы корректно вызывать bot.stop().
    console.log("Запуск бота...");
    await bot.start(); 
    // После bot.start() (который вызывает bot.launch()), процесс будет работать до получения сигнала.
    console.log("Бот успешно запущен и работает."); // Это сообщение может не появиться, если launch блокирующий
  } catch (error) {
    console.error("Критическая ошибка при запуске бота:", error);
    // Попытка остановить бота, если он был частично инициализирован
    if (bot && typeof bot.stop === 'function') {
        await bot.stop();
    }
    process.exit(1);
  }

  // Обработка сигналов для корректного завершения
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  signals.forEach((signal) => {
    process.on(signal, async () => {
      console.log(`\nПолучен сигнал ${signal}. Завершение работы...`);
      if (bot && typeof bot.stop === 'function') {
        await bot.stop();
      }
      process.exit(0);
    });
  });
}

bootstrap().catch((err) => {
  console.error("Непредвиденная критическая ошибка в bootstrap:", err);
  process.exit(1);
}); 