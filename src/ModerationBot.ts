import { Telegraf, Context, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { AppConfig } from "./config";
import { GeminiService, ModerateMessageRequest, ModerateMessageResponse } from "./services/GeminiService";
import { SpamCache, SpamUserInfo } from "./services/SpamCache";
import { WhitelistService } from "./services/WhitelistService";
import { AllowedChatsService } from "./services/AllowedChatsService";
import { PromptManager } from "./services/PromptManager";
import axios from "axios";

// Можно расширить Context, если понадобятся свои поля
interface MyContext extends Context {
  session?: {
    awaitingUserId?: boolean;
    awaitingUserIdForRemoval?: boolean;
    awaitingChatIdForAddition?: boolean;
    awaitingChatIdForRemoval?: boolean;
    awaitingChatIdForPrompts?: boolean;
    awaitingSinglePrompt?: boolean;
    awaitingBatchPrompt?: boolean;
    editingChatId?: number;
  };
}

export class ModerationBot {
  private bot: Telegraf<MyContext>;
  private config: AppConfig;
  private geminiService: GeminiService;
  private spamCache: SpamCache;
  private whitelistService: WhitelistService;
  private allowedChatsService: AllowedChatsService;
  private promptManager: PromptManager;
  private sessions: Map<number, any> = new Map(); // Простое хранилище сессий
  
  // Настройки модерации
  private moderationConfig = {
    // Минимальный уровень уверенности для принятия решения о спаме
    confidenceThreshold: 0.7,
    // Интервал очистки кэша (24 часа)
    cacheCleanupInterval: 24 * 60 * 60 * 1000,
    // Максимальный возраст записей в кэше (3 дня)
    maxCacheAge: 3 * 24 * 60 * 60 * 1000,
  };

  constructor(config: AppConfig) {
    this.config = config;
    this.bot = new Telegraf<MyContext>(this.config.botToken);
    // Инициализируем GeminiService с настройками батчинга
    this.geminiService = new GeminiService(
      config,
      "gemini-2.0-flash", // Используем gemini-2.0-flash
      3000, // Таймаут батча в 3 секунды
      5     // Максимальный размер батча - 5 сообщений
    );
    this.spamCache = new SpamCache();
    this.whitelistService = new WhitelistService();
    this.allowedChatsService = new AllowedChatsService();
    this.promptManager = new PromptManager();
    
    // Настраиваем периодическую очистку кэша
    setInterval(() => {
      this.spamCache.cleanup(this.moderationConfig.maxCacheAge);
    }, this.moderationConfig.cacheCleanupInterval);
    
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.bot.start((ctx) => this.handleStart(ctx));
    this.bot.help((ctx) => this.handleHelp(ctx));

    // Глобальный обработчик всех входящих сообщений для дебага
    this.bot.use(async (ctx, next) => {
      if (ctx.message && 'text' in ctx.message) {
        console.log(`===== ВХОДЯЩЕЕ СООБЩЕНИЕ =====`);
        console.log(`От пользователя: ${ctx.from?.id} ${ctx.from?.username || ""}`);
        console.log(`Текст: ${ctx.message.text}`);
        console.log(`Тип чата: ${ctx.chat?.type} (ID: ${ctx.chat?.id})`);
        if (ctx.message.text.startsWith('/')) {
          console.log(`Обнаружена команда: ${ctx.message.text}`);
          
          // Дополнительная проверка на команду /whitelist
          if (ctx.message.text.startsWith('/whitelist')) {
            console.log(`Перехвачена команда whitelist в middleware`);
            if (ctx.chat?.type === 'private') {
              await this.handleWhitelistCommand(ctx);
              return; // Не продолжаем выполнение цепочки middleware
            }
          }
          // Добавляем перехват команд для управления чатами
          if (ctx.message.text.startsWith('/addchat') || 
              ctx.message.text.startsWith('/removechat') || 
              ctx.message.text.startsWith('/listchats')) {
            console.log(`Перехвачена команда управления чатами в middleware`);
            if (ctx.chat?.type === 'private') {
              await this.handleChatManagementCommand(ctx);
              return;
            }
          }
          // Добавляем перехват команды для управления промптами
          if (ctx.message.text.startsWith('/prompts')) {
            console.log(`Перехвачена команда управления промптами в middleware`);
            if (ctx.chat?.type === 'private') {
              await this.handlePromptsCommand(ctx);
              return;
            }
          }
        }
      }
      await next(); // Передаем выполнение следующему обработчику
    });

    // Обработка текстовых сообщений в чатах
    this.bot.on(message("text"), async (ctx) => {
      // Проверяем, является ли это личным сообщением
      if (ctx.chat?.type === 'private') {
        await this.handlePrivateMessage(ctx);
        return;
      }
      
      try {
        const messageText = ctx.message.text;
        const user = ctx.from;
        
        console.log(
          `Новое сообщение от: ${user.username || user.id} (ID: ${user.id}), Текст: ${messageText}, Чат: ${ctx.chat?.id}`
        );

        // Если пользователь в вайтлисте, пропускаем модерацию
        if (this.whitelistService.isWhitelisted(user.id)) {
          console.log(`Пользователь ${user.id} находится в вайтлисте, пропускаем модерацию`);
          return;
        }

        // Быстрая проверка: если пользователь уже в кэше спамеров
        if (this.spamCache.isKnownSpammer(user.id)) {
          console.log(`Пользователь ${user.id} найден в кэше спамеров. Удаление сообщения...`);
          await this.deleteMessageAndMaybeBan(ctx, true);
          return;
        }
        
        // Быстрая проверка: если сообщение похоже на известный спам
        if (this.spamCache.isSimilarToKnownSpam(messageText)) {
          console.log(`Сообщение похоже на известный спам. Удаление...`);
          await this.deleteMessageAndMaybeBan(ctx, false);
          
          // Если сообщение явно спам, добавляем пользователя в кэш
          this.spamCache.addSpamUser(user.id, {
            userId: user.id,
            username: user.username,
            spamReason: "Сообщение совпадает с известным спамом",
            timestamp: Date.now(),
            messageExamples: [messageText],
          });
          
          return;
        }

        // Тестовый ответ на "тестбот"
        if (messageText.toLowerCase().includes("тестбот")) {
          try {
            await ctx.reply("Я живой! (Telegraf с Gemini API)");
            console.log(`Ответил на тестовое сообщение в чате ${ctx.chat.id}`);
          } catch (error) {
            console.error("Ошибка при отправке тестового ответа:", error);
          }
        }

        // Проверка через Gemini API
        await this.moderateWithGemini(ctx);
        
      } catch (error) {
        console.error("Ошибка при обработке сообщения:", error);
      }
    });

    // Обработка новых пользователей в чате
    this.bot.on("new_chat_members", async (ctx) => {
      // Проверяем, разрешен ли чат для модерации (только для supergroup)
      if (ctx.chat?.type === 'supergroup' && !this.allowedChatsService.isChatAllowed(ctx.chat.id)) {
        console.log(`Модерация новых участников для чата ${ctx.chat.id} (supergroup) не разрешена.`);
        return;
      }
      
      for (const newMember of ctx.message.new_chat_members) {
        // Проверяем, не находится ли новый участник в кэше спамеров
        if (this.spamCache.isKnownSpammer(newMember.id)) {
          const spamInfo = this.spamCache.getSpamUserInfo(newMember.id);
          console.log(`Новый участник ${newMember.id} найден в кэше спамеров. Бан...`);
          
          try {
            // Баним пользователя
            await ctx.banChatMember(newMember.id);
            console.log(`Пользователь ${newMember.id} забанен при входе в чат ${ctx.chat.id}`);
            
            // Обновляем счетчик банов в кэше
            if (spamInfo) {
              this.spamCache.addSpamUser(newMember.id, {
                ...spamInfo,
                banCount: (spamInfo.banCount || 0) + 1,
              });
            }
          } catch (error) {
            console.error(`Ошибка при бане пользователя ${newMember.id}:`, error);
          }
        } else {
          // Новый участник не в кэше - проверяем его профиль
          await this.checkNewMemberProfile(ctx, newMember);
        }
      }
    });
    
    // Обработчик команды /whitelist для управления вайтлистом
    this.bot.command('whitelist', (ctx) => this.handleWhitelistCommand(ctx));
    
    // Обработчик команды /prompts для управления промптами
    this.bot.command('prompts', (ctx) => this.handlePromptsCommand(ctx));
    
    // Обработчик команд whitelist с подкомандами (например, /whitelist add)
    this.bot.hears(/^\/whitelist\s+(.+)$/, (ctx) => {
      console.log("Получена команда /whitelist с подкомандой");
      return this.handleWhitelistCommand(ctx);
    });
    
    // Обработчик кнопок для управления вайтлистом
    this.bot.action(/whitelist_(.+)/, (ctx) => this.handleWhitelistAction(ctx));
    
    // Команды для управления разрешенными чатами
    this.bot.command('addchat', (ctx) => this.handleChatManagementCommand(ctx));
    this.bot.command('removechat', (ctx) => this.handleChatManagementCommand(ctx));
    this.bot.command('listchats', (ctx) => this.handleChatManagementCommand(ctx));
    
    // Добавляем обработчик для кнопок управления чатами
    this.bot.action(/allowedchats_(.+)/, (ctx) => this.handleAllowedChatsAction(ctx));
    
    // Добавляем команду и обработчики для управления промптами
    this.bot.command('prompts', (ctx) => this.handlePromptsCommand(ctx));
    this.bot.action(/prompts_(.+)/, (ctx) => this.handlePromptsAction(ctx));
  }
  
  /**
   * Обработка команды /start
   */
  private async handleStart(ctx: Context): Promise<void> {
    try {
      const userId = ctx.from?.id;
      
      // Если сообщение в личке и от админа
      if (ctx.chat?.type === 'private' && userId && this.whitelistService.isAdmin(userId)) {
        await ctx.reply(
          `Привет, ${ctx.from.first_name}! Я бот для модерации чата.\n\n` +
          `Ты являешься администратором и можешь управлять вайтлистом и списком разрешенных чатов для модерации.\n\n` +
          `Используй команду /whitelist для управления вайтлистом.\n` +
          `Используй команды /addchat, /removechat, /listchats для управления разрешенными чатами.`
        );
      } else if (ctx.chat?.type === 'private') {
        await ctx.reply(
          `Привет, ${ctx.from?.first_name || 'пользователь'}! Я бот для модерации чата.`
        );
      } else {
        // В публичных чатах не отвечаем на /start, если чат не разрешен
        if (ctx.chat?.type === 'supergroup' && !this.allowedChatsService.isChatAllowed(ctx.chat.id)) {
          return;
        }
        await ctx.reply("Привет! Я бот для модерации чата.");
      }
    } catch (error) {
      console.error('Ошибка при обработке команды /start:', error);
    }
  }
  
  /**
   * Обработка команды /help
   */
  private async handleHelp(ctx: Context): Promise<void> {
    try {
      if (ctx.chat?.type === 'private' && ctx.from?.id && this.whitelistService.isAdmin(ctx.from.id)) {
        await ctx.reply(
          `Я помогаю модерировать чат. Команды:\n\n` +
          `/whitelist - управление вайтлистом\n` +
          `/whitelist add - добавить пользователя в вайтлист\n` +
          `/whitelist remove - удалить пользователя из вайтлиста\n` +
          `/whitelist list - показать список пользователей в вайтлисте\n` +
          `/addchat - добавить чат в список разрешенных для модерации\n` +
          `/removechat - удалить чат из списка разрешенных\n` +
          `/listchats - показать список разрешенных чатов`
        );
      } else {
        // В публичных чатах не отвечаем на /help, если чат не разрешен
        if (ctx.chat?.type === 'supergroup' && !this.allowedChatsService.isChatAllowed(ctx.chat.id)) {
          return;
        }
        await ctx.reply("Я помогаю модерировать ваш чат. Я автоматически проверяю сообщения на спам и рекламу в разрешенных чатах.");
      }
    } catch (error) {
      console.error('Ошибка при обработке команды /help:', error);
    }
  }
  
  /**
   * Обработка личных сообщений
   */
  private async handlePrivateMessage(ctx: Context): Promise<void> {
    try {
      if (!ctx.from) return;
      
      console.log(`Обработка личного сообщения от ${ctx.from.id}`);
      
      // Проверяем, является ли сообщение текстовым
      if (!('text' in ctx.message)) return;
      
      const messageText = ctx.message.text;
      
      // Проверяем на команду /whitelist через текстовое сообщение (альтернативный способ)
      if (messageText === '/whitelist') {
        console.log(`Обнаружена команда /whitelist через текстовое сообщение`);
        await this.handleWhitelistCommand(ctx);
        return;
      }
      
      // Проверяем на команду /prompts через текстовое сообщение
      if (messageText === '/prompts') {
        console.log(`Обнаружена команда /prompts через текстовое сообщение`);
        await this.handlePromptsCommand(ctx);
        return;
      }
      
      // Проверяем на команду для добавления админа (для отладки)
      if (messageText.startsWith('/makeadmin')) {
        const idMatch = messageText.match(/\/makeadmin\s+(\d+)/);
        if (idMatch && idMatch[1]) {
          const adminId = parseInt(idMatch[1]);
          const result = this.whitelistService.registerAdmin(adminId);
          await ctx.reply(`Попытка добавить админа ${adminId}: ${result ? 'успешно' : 'не удалось'}`);
        } else {
          await ctx.reply('Используйте формат: /makeadmin 123456789');
        }
        return;
      }
      
      // Проверяем на команду для вывода ID пользователя (для отладки)
      if (messageText === '/myid') {
        await ctx.reply(`Ваш ID: ${ctx.from.id}`);
        return;
      }
      
      // Проверяем, является ли пользователь администратором
      if (!this.whitelistService.isAdmin(ctx.from.id)) {
        await ctx.reply("Я могу обрабатывать команды только от администраторов.");
        return;
      }
      
      const myCtx = ctx as MyContext;
      
      // Получаем или создаем сессию для пользователя
      if (!this.sessions.has(ctx.from.id)) {
        this.sessions.set(ctx.from.id, {});
      }
      
      const session = this.sessions.get(ctx.from.id);
      myCtx.session = session;
      
      // Если сообщение содержит ID пользователя (для добавления в вайтлист)
      if (session.awaitingUserId) {
        const userId = parseInt(ctx.message.text.trim());
        
        if (isNaN(userId)) {
          await ctx.reply("Пожалуйста, введите корректный ID пользователя (только цифры).");
          return;
        }
        
        // Получаем дополнительную информацию о пользователе
        try {
          // Пытаемся получить информацию о пользователе 
          // (это может не сработать, если пользователь никогда не общался с ботом)
          const chatMember = await this.bot.telegram.getChatMember(
            ctx.chat.id, 
            userId
          ).catch(() => null);
          
          const username = chatMember?.user?.username || null;
          
          // Добавляем пользователя в вайтлист
          const added = this.whitelistService.addToWhitelist(
            userId, 
            username, 
            "Добавлен администратором", 
            ctx.from.id
          );
          
          if (added) {
            await ctx.reply(
              `Пользователь ${username || userId} успешно добавлен в вайтлист.`,
              Markup.inlineKeyboard([
                Markup.button.callback('← Назад к меню', 'whitelist_menu')
              ])
            );
          } else {
            await ctx.reply(
              `Пользователь ${username || userId} уже находится в вайтлисте.`,
              Markup.inlineKeyboard([
                Markup.button.callback('← Назад к меню', 'whitelist_menu')
              ])
            );
          }
        } catch (error) {
          console.error(`Ошибка при получении информации о пользователе ${userId}:`, error);
          
          // Даже если не смогли получить информацию, все равно добавляем в вайтлист
          const added = this.whitelistService.addToWhitelist(
            userId, 
            null, 
            "Добавлен администратором без проверки", 
            ctx.from.id
          );
          
          if (added) {
            await ctx.reply(
              `Пользователь ${userId} добавлен в вайтлист. Не удалось получить дополнительную информацию о нем.`,
              Markup.inlineKeyboard([
                Markup.button.callback('← Назад к меню', 'whitelist_menu')
              ])
            );
          } else {
            await ctx.reply(
              `Пользователь ${userId} уже находится в вайтлисте.`,
              Markup.inlineKeyboard([
                Markup.button.callback('← Назад к меню', 'whitelist_menu')
              ])
            );
          }
        }
        
        // Сбрасываем состояние
        session.awaitingUserId = false;
      }
      
      // Если ожидаем ID для удаления из вайтлиста
      if (session.awaitingUserIdForRemoval) {
        const userId = parseInt(ctx.message.text.trim());
        
        if (isNaN(userId)) {
          await ctx.reply("Пожалуйста, введите корректный ID пользователя (только цифры).");
          return;
        }
        
        // Удаляем пользователя из вайтлиста
        const removed = this.whitelistService.removeFromWhitelist(userId);
        
        if (removed) {
          await ctx.reply(
            `Пользователь ${userId} успешно удален из вайтлиста.`,
            Markup.inlineKeyboard([
              Markup.button.callback('← Назад к меню', 'whitelist_menu')
            ])
          );
        } else {
          await ctx.reply(
            `Пользователь ${userId} не найден в вайтлисте.`,
            Markup.inlineKeyboard([
              Markup.button.callback('← Назад к меню', 'whitelist_menu')
            ])
          );
        }
        
        // Сбрасываем состояние
        session.awaitingUserIdForRemoval = false;
      }

      // Обработка ввода ID чата для добавления
      if (session.awaitingChatIdForAddition) {
        const chatIdInput = ctx.message.text.trim();
        const chatId = parseInt(chatIdInput);

        if (isNaN(chatId)) {
          await ctx.reply("Пожалуйста, введите корректный ID чата (только цифры, может быть отрицательным).");
          session.awaitingChatIdForAddition = false; // Сбрасываем состояние
          return;
        }
        
        // ID супергруппы должен быть отрицательным
        if (chatId > 0) { 
            await ctx.reply("ID чата supergroup обычно начинается с -100 (например, -100123456789). Пожалуйста, проверьте введенный ID.");
            session.awaitingChatIdForAddition = false; // Сбрасываем состояние
            return; 
        }

        try {
          const chatInfo = await this.bot.telegram.getChat(chatId).catch((e) => {
            console.error(`Ошибка при вызове getChat для ID ${chatId}:`, e.message);
            return null;
          });
          const chatTitle = chatInfo && 'title' in chatInfo ? chatInfo.title : 'Не удалось получить название';

          if (chatInfo && chatInfo.type !== 'supergroup') {
            await ctx.reply(`Чат ${chatTitle} (ID: ${chatId}) не является супергруппой. Бот может модерировать только супергруппы.`);
            session.awaitingChatIdForAddition = false; 
            return;
          }

          const added = this.allowedChatsService.addChat(chatId, ctx.from.id, chatTitle);
          if (added) {
            await ctx.reply(
              `Чат ${chatTitle} (ID: ${chatId}) успешно добавлен в список разрешенных.`, 
              Markup.inlineKeyboard([Markup.button.callback('← Назад к меню чатов', 'allowedchats_menu')])
            );
          } else {
            await ctx.reply(
              `Чат ${chatTitle} (ID: ${chatId}) уже находится в списке разрешенных.`, 
              Markup.inlineKeyboard([Markup.button.callback('← Назад к меню чатов', 'allowedchats_menu')])
            );
          }
        } catch (error: any) { 
          console.error(`Критическая ошибка при добавлении чата ID ${chatId} (awaitingChatIdForAddition):`, error.message);
          await ctx.reply(`Произошла ошибка при добавлении чата ID ${chatId}. Пожалуйста, проверьте логи бота для получения подробной информации.`);
        }
        session.awaitingChatIdForAddition = false;
      }

      // Обработка ввода ID чата для удаления
      if (session.awaitingChatIdForRemoval) {
        const chatIdInput = ctx.message.text.trim();
        const chatId = parseInt(chatIdInput);

        if (isNaN(chatId)) {
          await ctx.reply("Пожалуйста, введите корректный ID чата (только цифры, может быть отрицательным).");
          session.awaitingChatIdForRemoval = false; // Сбрасываем состояние
          return;
        }
        
        // ID супергруппы должен быть отрицательным
        if (chatId > 0) { 
            await ctx.reply("ID чата supergroup обычно начинается с -100 (например, -100123456789). Пожалуйста, проверьте введенный ID.");
            session.awaitingChatIdForRemoval = false; // Сбрасываем состояние
            return; 
        }

        try {
          // Для удаления нам не обязательно получать title, но можно оставить для консистентности или будущих нужд
          // const chatInfo = await this.bot.telegram.getChat(chatId).catch(() => null); 
          // const chatTitle = chatInfo && 'title' in chatInfo ? chatInfo.title : String(chatId);

          const removed = this.allowedChatsService.removeChat(chatId);
          if (removed) {
            await ctx.reply(
              `Чат ID: ${chatId} успешно удален из списка разрешенных.`, 
              Markup.inlineKeyboard([Markup.button.callback('← Назад к меню чатов', 'allowedchats_menu')])
            );
          } else {
            await ctx.reply(
              `Чат ID: ${chatId} не найден в списке разрешенных.`, 
              Markup.inlineKeyboard([Markup.button.callback('← Назад к меню чатов', 'allowedchats_menu')])
            );
          }
        } catch (error: any) { 
          console.error(`Критическая ошибка при удалении чата ID ${chatId} (awaitingChatIdForRemoval):`, error.message);
          await ctx.reply(`Произошла ошибка при удалении чата ID ${chatId}. Пожалуйста, проверьте логи бота.`);
        }
        session.awaitingChatIdForRemoval = false;
      }
      
      // Обработка ввода ID чата для настройки промптов
      if (session.awaitingChatIdForPrompts) {
        const chatIdInput = ctx.message.text.trim();
        const chatId = parseInt(chatIdInput);

        if (isNaN(chatId)) {
          await ctx.reply("Пожалуйста, введите корректный ID чата (только цифры, может быть отрицательным).");
          session.awaitingChatIdForPrompts = false;
          return;
        }
        
        try {
          // Пытаемся получить информацию о чате
          let chatTitle = String(chatId);
          
          try {
            const chatInfo = await this.bot.telegram.getChat(chatId).catch(() => null);
            if (chatInfo && 'title' in chatInfo) {
              chatTitle = chatInfo.title;
            }
          } catch (error) {
            console.warn(`Не удалось получить информацию о чате ${chatId}:`, error);
          }
          
          // Создаем или обновляем запись о промптах для чата
          this.promptManager.setCustomPrompt(chatId, ctx.from.id, chatTitle);
          
          await ctx.reply(
            `Чат "${chatTitle}" (ID: ${chatId}) добавлен в список для кастомных промптов. Теперь вы можете настроить промпты для него.`,
            Markup.inlineKeyboard([
              Markup.button.callback('Настроить промпты', `prompts_manage_${chatId}`)
            ])
          );
        } catch (error) {
          console.error(`Ошибка при добавлении чата ${chatId} для промптов:`, error);
          await ctx.reply(`Произошла ошибка при добавлении чата ID ${chatId}. Пожалуйста, попробуйте еще раз.`);
        }
        
        session.awaitingChatIdForPrompts = false;
      }
    } catch (error: any) {
      console.error('Ошибка при обработке личного сообщения:', error.message);
      try {
        await ctx.reply("Произошла непредвиденная ошибка при обработке вашего сообщения. Администратор был уведомлен (через логи).");
      } catch (replyError: any) {
        console.error('Ошибка при отправке сообщения об ошибке пользователю:', replyError.message);
      }
    }
  }
  
  /**
   * Обработка команды /whitelist
   */
  private async handleWhitelistCommand(ctx: Context, command?: string): Promise<void> {
    try {
      console.log("=== Обработка команды /whitelist ===");
      console.log(`Получена команда /whitelist от пользователя ${ctx.from?.id}`);
      
      if (!ctx.from) return;
      
      // Проверяем, является ли пользователь администратором
      const isAdmin = this.whitelistService.isAdmin(ctx.from.id);
      console.log(`Пользователь ${ctx.from.id}: isAdmin = ${isAdmin}`);
      
      if (!isAdmin) {
        console.log(`Пользователь ${ctx.from.id} не является администратором`);
        await ctx.reply("У вас нет прав для управления вайтлистом.");
        return;
      }
      
      // Проверяем, является ли сообщение из личного чата
      console.log(`Тип чата: ${ctx.chat?.type}`);
      if (ctx.chat?.type !== 'private') {
        await ctx.reply("Управление вайтлистом доступно только в личных сообщениях с ботом.");
        return;
      }
      
      // Отображаем главное меню управления вайтлистом
      console.log("Вызываем метод showWhitelistMenu");
      await this.showWhitelistMenu(ctx);
    } catch (error) {
      console.error('Ошибка при обработке команды /whitelist:', error);
    }
  }
  
  /**
   * Обработка действий с кнопками для вайтлиста
   */
  private async handleWhitelistAction(ctx: any): Promise<void> {
    try {
      if (!ctx.from) return;
      
      // Проверяем, является ли пользователь администратором
      if (!this.whitelistService.isAdmin(ctx.from.id)) {
        await ctx.reply("У вас нет прав для управления вайтлистом.");
        await ctx.answerCbQuery();
        return;
      }
      
      // Извлекаем действие из данных кнопки
      const action = ctx.match[1];
      console.log(`Действие с вайтлистом: ${action}`);
      
      // Получаем или создаем сессию для пользователя
      if (!this.sessions.has(ctx.from.id)) {
        this.sessions.set(ctx.from.id, {});
      }
      
      const session = this.sessions.get(ctx.from.id);
      const myCtx = ctx as MyContext;
      myCtx.session = session;
      
      switch (action) {
        case 'menu':
          // Показываем главное меню вайтлиста
          await this.showWhitelistMenu(ctx);
          break;
          
        case 'add':
          // Запрашиваем ID пользователя для добавления
          await ctx.editMessageText(
            "Введите ID пользователя, которого хотите добавить в вайтлист:",
            Markup.inlineKeyboard([
              Markup.button.callback('Отмена', 'whitelist_menu')
            ])
          );
          
          // Устанавливаем флаг, что ожидаем ID пользователя
          session.awaitingUserId = true;
          session.awaitingUserIdForRemoval = false;
          break;
          
        case 'remove':
          // Запрашиваем ID пользователя для удаления
          await ctx.editMessageText(
            "Введите ID пользователя, которого хотите удалить из вайтлиста:",
            Markup.inlineKeyboard([
              Markup.button.callback('Отмена', 'whitelist_menu')
            ])
          );
          
          // Устанавливаем флаг, что ожидаем ID пользователя для удаления
          session.awaitingUserIdForRemoval = true;
          session.awaitingUserId = false;
          break;
          
        case 'list':
          // Показываем список пользователей в вайтлисте
          const whitelistText = this.whitelistService.formatWhitelistForDisplay();
          
          await ctx.editMessageText(
            `📋 Список пользователей в вайтлисте:\n\n${whitelistText}`,
            Markup.inlineKeyboard([
              Markup.button.callback('← Назад к меню', 'whitelist_menu')
            ])
          );
          break;
      }
      
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Ошибка при обработке действия с вайтлистом:', error);
      await ctx.answerCbQuery('Произошла ошибка').catch(console.error);
    }
  }
  
  /**
   * Отображает главное меню управления вайтлистом
   */
  private async showWhitelistMenu(ctx: any): Promise<void> {
    try {
      console.log("Отображение меню вайтлиста");
      
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить в вайтлист', 'whitelist_add')],
        [Markup.button.callback('➖ Удалить из вайтлиста', 'whitelist_remove')],
        [Markup.button.callback('📋 Список вайтлиста', 'whitelist_list')],
        [Markup.button.callback('🛡️ Управление чатами', 'allowedchats_menu')] // Кнопка для перехода в меню чатов
      ]);
      
      const whitelistCount = this.whitelistService.getWhitelistedUsers().length;
      const messageText = `🛡️ *Управление вайтлистом*\n\nПользователей в вайтлисте: ${whitelistCount}\n\nВыберите действие:`;

      if (ctx.callbackQuery) {
        await ctx.editMessageText(messageText, { ...keyboard, parse_mode: 'Markdown' });
      } else {
        await ctx.reply(messageText, { ...keyboard, parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error('Ошибка при отображении меню вайтлиста:', error);
    }
  }

  /**
   * Модерация сообщения с использованием Gemini API
   */
  private async moderateWithGemini(ctx: MyContext): Promise<void> {
    const message = ctx.message;
    if (!message || !('text' in message)) return;
    
    const user = ctx.from;
    if (!user) return;
    
    const messageText = message.text;
    const chatId = ctx.chat.id;
    
    // Если пользователь в вайтлисте, пропускаем модерацию
    if (this.whitelistService.isWhitelisted(user.id)) {
      console.log(`Пользователь ${user.id} находится в вайтлисте, пропускаем модерацию`);
      return;
    }
  
    // Получаем дополнительную информацию о пользователе
    let userBio = "";
    let userInfo = `Имя: ${user.first_name || ""} ${user.last_name || ""}`;
    let isSuspiciousProfile = false;
    let hasAvatar = false;
    
    try {
      // Попытка получить полную информацию о пользователе
      const chatMember = await ctx.getChatMember(user.id);
      
      if (user.username) {
        userInfo += `\nUsername: @${user.username}`;
      }
      
      if ('user' in chatMember && chatMember.user) {
        // Если есть дополнительная информация в chatMember
        if (chatMember.user.username) {
          userInfo += `\nUsername: @${chatMember.user.username}`;
        }
        
        // Пытаемся получить био пользователя, если доступно
        try {
          const userFullInfo = await this.bot.telegram.getChat(user.id);
          if ('bio' in userFullInfo && userFullInfo.bio) {
            userBio = userFullInfo.bio;
            userInfo += `\nБио: ${userFullInfo.bio}`;
            
            // Проверяем био на подозрительные ссылки
            isSuspiciousProfile = this.hasSuspiciousBioLinks(userFullInfo.bio);
            
            if (isSuspiciousProfile) {
              console.log(`Обнаружено подозрительное био у пользователя ${user.id}: ${userFullInfo.bio}`);
            }
          }
          
          // Проверяем наличие аватарки
          try {
            const userProfilePhotos = await this.bot.telegram.getUserProfilePhotos(user.id, 0, 1);
            hasAvatar = userProfilePhotos.total_count > 0;
            console.log(`Пользователь ${user.id} ${hasAvatar ? "имеет" : "не имеет"} аватар`);
          } catch (error) {
            console.warn(`Не удалось проверить наличие аватарки у пользователя ${user.id}:`, error);
          }
        } catch (error) {
          console.warn(`Не удалось получить био пользователя ${user.id}:`, error);
        }
      }
    } catch (error) {
      console.warn(`Не удалось получить информацию о пользователе ${user.id}:`, error);
    }
    
    // Быстрая проверка на короткие безобидные сообщения от подозрительных профилей
    if (isSuspiciousProfile && this.isInnocentLookingMessage(messageText)) {
      console.log(`Подозрительное короткое сообщение от пользователя ${user.id} с подозрительным био: "${messageText}"`);
    }
    
    console.log(`Анализ сообщения от пользователя ${user.id}. Информация о пользователе: ${userInfo}`);
    
    // Создаем запрос для модерации
    const moderationRequest: ModerateMessageRequest = {
      messageText: messageText,
      userName: user.username || user.first_name || `User${user.id}`,
      userBio,
      hasAvatar,
      suspiciousProfile: isSuspiciousProfile,
      suspicionReason: isSuspiciousProfile ? "Подозрительное био с рекламными ссылками" : undefined,
      messageId: message.message_id,
      chatId: ctx.chat.id
    };
    
    try {
      // Проверяем, есть ли кастомный промпт для данного чата
      let moderationResult: ModerateMessageResponse;
      
      if (this.promptManager.hasCustomPrompt(chatId) && this.promptManager.getSingleMessagePrompt(chatId)) {
        console.log(`Используем кастомный промпт для чата ${chatId}`);
        const customPrompt = this.promptManager.getSingleMessagePrompt(chatId);
        moderationResult = await this.geminiService.moderateWithCustomPrompt(moderationRequest, customPrompt!);
      } else {
        // Используем батчинг для оптимизации запросов к API с дефолтным промптом
        moderationResult = await this.geminiService.queueMessageForModeration(moderationRequest);
      }
      
      console.log(`Результат модерации для ${user.id}:`, moderationResult);
      
      // Если сообщение определено как спам с достаточной уверенностью
      // ИЛИ если профиль подозрительный и уверенность выше среднего
      const confidenceThreshold = isSuspiciousProfile 
        ? this.moderationConfig.confidenceThreshold * 0.8 // Снижаем порог для подозрительных профилей
        : this.moderationConfig.confidenceThreshold;
      
      if (moderationResult.isSpam && moderationResult.confidence >= confidenceThreshold) {
        console.log(`Сообщение от ${user.id} определено как спам (уверенность: ${moderationResult.confidence}). Причина: ${moderationResult.reason}`);
        
        // Удаляем сообщение и, возможно, баним пользователя
        await this.deleteMessageAndMaybeBan(ctx, moderationResult.shouldBan);
        
        // Добавляем информацию в кэш
        this.spamCache.addSpamUser(user.id, {
          userId: user.id,
          username: user.username,
          bio: userBio,
          spamReason: moderationResult.reason,
          timestamp: Date.now(),
          messageExamples: [messageText],
        });
        
        // Добавляем сообщение в кэш спам-сообщений
        this.spamCache.addSpamMessage(messageText);
      }
    } catch (error) {
      console.error("Ошибка при модерации с Gemini:", error);
    }
  }
  
  /**
   * Проверяет, является ли сообщение "безобидной наживкой"
   * Возвращает true только если сообщение похоже на "наживку", 
   * но окончательное решение должно приниматься с учетом анализа профиля
   */
  private isInnocentLookingMessage(text: string): boolean {
    if (!text) return false;
    
    // Если сообщение содержит мат или токсичность, это не наживка
    const toxicWords = [
      "хуй", "пизд", "ебал", "еблан", "ебан", "блять", "бля", "нахуй", "похуй", "заебал",
      "fuck", "shit", "bitch", "asshole", "cunt", "dick", "pussy", "whore", "slut",
      "тупой", "идиот", "дебил", "придурок", "недоумок", "кретин", "мразь", "тварь"
    ];
    
    // Если в сообщении есть хоть одно токсичное слово, это не наживка
    if (toxicWords.some(word => text.toLowerCase().includes(word))) {
      return false;
    }
    
    // Если сообщение содержит упоминания $GOVNO или Overbafer1, 
    // это, скорее всего, не наживка, а нормальное сообщение для этого чата
    if (text.toLowerCase().includes("$govno") || 
        text.toLowerCase().includes("govno") || 
        text.toLowerCase().includes("overbafer1") ||
        text.toLowerCase().includes("говно")) {
      return false;
    }
    
    // ВАЖНО: этот метод теперь должен использоваться только в сочетании с проверкой био
    // Простые приветствия без подозрительного био - не наживка!
    // Этот метод не должен самостоятельно определять сообщение как наживку,
    // а только помогать в общей оценке в сочетании с анализом профиля.
    
    // Если сообщение короткое (до 20 символов)
    if (text.length <= 20) {
      // Типичные короткие фразы, которые МОГУТ быть наживками (но решение принимается с учетом профиля)
      const potentialBaitPatterns = [
        /привет/i,
        /прив/i,
        /хай/i,
        /как дела/i,
        /что нового/i,
        /я красивая/i,
        /красотка/i,
        /о, круто/i,
        /да, верно/i,
        /действительно/i,
        /согласна/i,
        /интересно/i,
        /классно/i,
        /супер/i,
        /здорово/i,
        /ого/i,
        /вау/i,
        /👍/,
        /❤️/,
        /😊/,
        /😍/
      ];
      
      // Возвращаем true только если есть шаблон, но окончательное решение
      // должно приниматься с учетом анализа профиля
      return potentialBaitPatterns.some(pattern => pattern.test(text));
    }
    
    return false;
  }

  /**
   * Удаляет сообщение и, при необходимости, банит пользователя
   */
  private async deleteMessageAndMaybeBan(ctx: MyContext, shouldBan: boolean): Promise<void> {
    if (!ctx.message) return;
    
    try {
      // Удаляем сообщение
      await ctx.deleteMessage(ctx.message.message_id);
      console.log(`Сообщение ${ctx.message.message_id} удалено из чата ${ctx.chat?.id}`);
      
      // Если нужно банить пользователя
      if (shouldBan && ctx.from) {
        await ctx.banChatMember(ctx.from.id);
        console.log(`Пользователь ${ctx.from.id} забанен в чате ${ctx.chat?.id}`);
        
        // Обновляем счетчик банов в кэше, если пользователь там есть
        const userId = ctx.from.id;
        const spamInfo = this.spamCache.getSpamUserInfo(userId);
        if (spamInfo) {
          this.spamCache.addSpamUser(userId, {
            ...spamInfo,
            banCount: (spamInfo.banCount || 0) + 1,
          });
        }
      }
    } catch (error) {
      console.error("Ошибка при удалении сообщения или бане:", error);
    }
  }
  
  /**
   * Получает аватар пользователя в формате base64
   */
  private async getUserAvatarBase64(userId: number): Promise<string | undefined> {
    try {
      // 1. Получаем фотографии профиля пользователя
      const userProfilePhotos = await this.bot.telegram.getUserProfilePhotos(userId, 0, 1);
      
      if (userProfilePhotos.total_count === 0) {
        console.log(`У пользователя ${userId} нет фото профиля`);
        return undefined;
      }
      
      // Получаем фото с наивысшим разрешением (последнее в массиве)
      const photo = userProfilePhotos.photos[0][userProfilePhotos.photos[0].length - 1];
      
      // 2. Получаем информацию о файле
      const fileInfo = await this.bot.telegram.getFile(photo.file_id);
      
      if (!fileInfo.file_path) {
        console.log(`Не удалось получить путь к файлу для ${userId}`);
        return undefined;
      }
      
      // 3. Формируем URL для скачивания файла
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${fileInfo.file_path}`;
      
      // 4. Скачиваем изображение
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      
      // 5. Конвертируем в base64
      const base64 = Buffer.from(response.data, 'binary').toString('base64');
      
      console.log(`Аватар пользователя ${userId} успешно получен`);
      return base64;
    } catch (error) {
      console.error(`Ошибка при получении аватара пользователя ${userId}:`, error);
      return undefined;
    }
  }

  /**
   * Проверка подозрительных ссылок в био пользователя
   */
  private hasSuspiciousBioLinks(bio: string | undefined): boolean {
    if (!bio) return false;
    
    const lowerBio = bio.toLowerCase();
    
    // Исключаем упоминания $GOVNO и Overbafer1
    if (lowerBio.includes("$govno") || lowerBio.includes("govno") || lowerBio.includes("overbafer1")) {
      // Если в био есть только упоминания $GOVNO/Overbafer1 без других подозрительных фраз,
      // считаем профиль нормальным
      const bioWithoutGovno = lowerBio
        .replace(/\$govno/g, "")
        .replace(/govno/g, "")
        .replace(/overbafer1/g, "");
        
      // Если в оставшемся тексте нет подозрительных ссылок, возвращаем false
      if (!bioWithoutGovno.includes("t.me/") && 
          !bioWithoutGovno.includes("http://") && 
          !bioWithoutGovno.includes("https://")) {
        return false;
      }
    }
    
    // Проверяем наличие русского мата в био
    const russianProfanity = [
      "хуй", "пизд", "ебал", "еблан", "ебан", "блять", "бля", "нахуй", "похуй", "заебал",
      "хуе", "хуя", "ебл", "ебать", "ебет", "ебут", "выеб", "уеб", "пидор", "пидар",
      "мудак", "мудил", "долбоеб", "долбаеб", "залуп", "дроч", "пидр", "гондон", "говноед",
      "хер", "хрен", "дебил", "идиот", "мразь", "тварь", "шлюха", "сука", "суки", "шлюх"
    ];
    
    // Если в био есть только мат и нет подозрительных фраз, это нормальный профиль (токсичный, но разрешенный)
    const hasProfanity = russianProfanity.some(word => lowerBio.includes(word));
    const hasLinks = bio.includes("t.me/") || bio.includes("http://") || bio.includes("https://");
    
    if (hasProfanity && !hasLinks) {
      // Это просто токсичное био без ссылок, что разрешено
      return false;
    }
    
    // Проверяем наличие подозрительных фраз в био
    const suspiciousPhrases = [
      "только для избранных",
      "для избранных",
      "мой канал",
      "мой онлифанс",
      "личный канал",
      "заработок",
      "доход",
      "инвестиции",
      "прогнозы",
      "сигналы",
      "арбитраж",
      "крипто",
      "эксклюзив",
      "приват",
      "фото 18+",
      "контент 18+",
      "заходи",
      "переходи",
      "подписывайся",
      "👉",
      "🔞",
      "💰",
      "💸",
      "📈"
    ];
    
    // Если в био есть ссылка и одна из подозрительных фраз
    const hasLink = bio.includes("t.me/") || bio.includes("http://") || bio.includes("https://");
    const hasSuspiciousPhrase = suspiciousPhrases.some(phrase => lowerBio.includes(phrase));
    
    return hasLink && hasSuspiciousPhrase;
  }

  /**
   * Проверка профиля нового участника чата
   */
  private async checkNewMemberProfile(ctx: MyContext, newMember: any): Promise<void> {
    try {
      console.log(`Проверка профиля нового участника: ${newMember.id} (${newMember.username || newMember.first_name})`);
      
      // Собираем информацию о пользователе
      let userBio = "";
      let userInfo = `Имя: ${newMember.first_name || ""} ${newMember.last_name || ""}`;
      let hasAvatar = false;
      
      if (newMember.username) {
        userInfo += `\nUsername: @${newMember.username}`;
      }
      
      // Пытаемся получить био пользователя
      let isSuspiciousProfile = false;
      try {
        const userFullInfo = await this.bot.telegram.getChat(newMember.id);
        if ('bio' in userFullInfo && userFullInfo.bio) {
          userBio = userFullInfo.bio;
          userInfo += `\nБио: ${userFullInfo.bio}`;
          
          // Проверяем био на подозрительные ссылки
          isSuspiciousProfile = this.hasSuspiciousBioLinks(userFullInfo.bio);
        }
        
        // Проверяем наличие аватарки
        try {
          const userProfilePhotos = await this.bot.telegram.getUserProfilePhotos(newMember.id, 0, 1);
          hasAvatar = userProfilePhotos.total_count > 0;
          console.log(`Пользователь ${newMember.id} ${hasAvatar ? "имеет" : "не имеет"} аватар`);
        } catch (error) {
          console.warn(`Не удалось проверить наличие аватарки у пользователя ${newMember.id}:`, error);
        }
      } catch (error) {
        console.warn(`Не удалось получить био пользователя ${newMember.id}:`, error);
      }
      
      console.log(`Информация о новом участнике ${newMember.id}: ${userInfo}`);
      
      // Быстрая проверка по био - если био однозначно подозрительное, баним сразу
      if (isSuspiciousProfile) {
        console.log(`Профиль ${newMember.id} имеет подозрительное био. Отправляем на тщательную проверку...`);
        // НЕ баним сразу, а отправляем на дополнительную проверку через Gemini
        // с пониженным порогом уверенности
      }
      
      // Проверяем профиль через Gemini
      // Создаем специальный промпт для проверки профиля
      let profilePrompt = `Проверь профиль нового пользователя в Telegram чате на спам или рекламу:
Имя пользователя: ${newMember.first_name || ""} ${newMember.last_name || ""}
${newMember.username ? `Username: @${newMember.username}` : ""}
${userBio ? `Био: ${userBio}` : "Био отсутствует"}
${hasAvatar ? "У пользователя есть аватарка" : "У пользователя нет аватарки"}

ВАЖНЫЙ КОНТЕКСТ: Этот чат посвящен криптовалютному мемкоину $GOVNO на блокчейне TON, созданному популярным YouTube-блогером Overbafer1. Упоминания $GOVNO, Overbafer1, TON в профиле НЕ являются признаком спама, а нормальным контекстом для данного чата.

ВАЖНО О БИО ПОЛЬЗОВАТЕЛЕЙ: Тебе предоставляется ПОЛНОЕ и НЕИЗМЕНЕННОЕ био пользователя. Если указано, что в био написано "Слава $GOVNO 💩 Слава overbafer1" или любой другой текст, значит именно это там и написано, без каких-либо скрытых ссылок. НЕ ПРИДУМЫВАЙ наличие ссылок, если они явно не указаны в переданном био!

ВНИМАНИЕ: Если у пользователя в био нет ссылок на каналы, сайты или других пользователей, а есть только упоминания $GOVNO или Overbafer1 - это НЕ спамер и НЕ шлюхобот. Такие пользователи полностью легитимны!

КРИТИЧЕСКИ ВАЖНОЕ ПРАВИЛО: БЛОКИРОВАТЬ ТОЛЬКО РЕКЛАМНЫЕ ПРОФИЛИ И ШЛЮХОБОТОВ. Любые другие профили разрешены, даже если они странные, токсичные или неуместные. Определяй только очевидных спамеров и шлюхоботов.

ОСОБЕННОСТЬ ЧАТА: Это свободное комьюнити с токсичной культурой. Мат, оскорбления, агрессивные высказывания, угрозы и любой токсичный контент в имени или био НЕ считаются признаком спама и должны разрешаться. Модерация должна отсеивать ТОЛЬКО шлюхоботов и спамеров, но НЕ обычных пользователей с токсичным контентом.

Проверь, является ли этот профиль "шлюхоботом" (фейковые профили с привлекательными девушками, которые будут спамить рекламой) или "крипто-спамером" (рекламирующим крипто-услуги, сигналы, прогнозы).

Профили шлюхоботов часто имеют:
- Женские имена
- В имени пользователя встречаются женские имена, часто с цифрами или подчеркиваниями
- В био может быть ссылка на телеграм канал, сайт или упоминание заработка
- Ссылки на "приватные" или "секретные" каналы
- Фразы типа "только для избранных" или "мой личный канал"

Профили крипто-спамеров часто имеют:
- Био, связанное с криптовалютами, трейдингом, инвестициями
- Упоминание прибыли, заработка или обучения
- Ссылки на телеграм-каналы с сигналами или аналитикой

ЛЕГИТИМНЫЕ ТЕМЫ В ПРОФИЛЕ (НЕ СПАМ):
- Упоминания $GOVNO, фразы "Слава $GOVNO" и подобные
- Упоминания Overbafer1
- Упоминания TON, DeDust, STON.fi в контексте $GOVNO
- ЛЮБЫЕ токсичные высказывания, мат, оскорбления (свобода слова важнее всего!)

${isSuspiciousProfile ? "ВНИМАНИЕ: В био пользователя обнаружены подозрительные ссылки и фразы!" : ""}

Определи, является ли этот профиль подозрительным.`;

      const moderationTool = {
        functionDeclarations: [
          {
            name: "evaluate_profile",
            description: "Оценивает профиль пользователя на признаки спама",
            parameters: {
              type: "object",
              properties: {
                isSuspicious: {
                  type: "boolean",
                  description: "Является ли профиль подозрительным (true) или нормальным (false)",
                },
                suspicionLevel: {
                  type: "number",
                  description: "Уровень подозрительности от 0.0 до 1.0, где 1.0 - максимальная подозрительность",
                },
                reason: {
                  type: "string",
                  description: "Почему профиль считается подозрительным или нормальным",
                },
                profileType: {
                  type: "string",
                  description: "Тип профиля: 'normal', 'slutbot', 'crypto_spammer', 'other'",
                },
                shouldBan: {
                  type: "boolean",
                  description: "Стоит ли сразу банить пользователя (для очевидных случаев)",
                },
              },
              required: [
                "isSuspicious",
                "suspicionLevel",
                "reason",
                "profileType",
                "shouldBan",
              ],
            },
          },
        ],
      };

      try {
        const response = await this.geminiService.generateContent(profilePrompt, {
          temperature: isSuspiciousProfile ? 0.05 : 0.1, // Более низкая температура для уже подозрительных профилей
          tools: [moderationTool],
        });

        try {
          // Парсим ответ функции
          const functionCallData = JSON.parse(response);
          if (functionCallData.name === "evaluate_profile" && functionCallData.args) {
            const result = functionCallData.args;
            console.log(`Результат проверки профиля ${newMember.id}:`, result);
            
            // Если профиль подозрительный с высоким уровнем уверенности
            // ИЛИ если био уже признано подозрительным и уровень подозрительности выше среднего
            const suspicionThreshold = isSuspiciousProfile 
              ? this.moderationConfig.confidenceThreshold * 0.8  // Снижаем порог для уже подозрительных профилей
              : this.moderationConfig.confidenceThreshold;
              
            if (result.isSuspicious && result.suspicionLevel >= suspicionThreshold && 
                (result.profileType === 'slutbot' || result.profileType === 'crypto_spammer')) {
              console.log(`Профиль ${newMember.id} определен как подозрительный (${result.profileType}). Уровень: ${result.suspicionLevel}`);
              
              // Если рекомендуется бан или профиль явно подозрительный с высоким уровнем уверенности
              if (result.shouldBan || 
                 (isSuspiciousProfile && result.suspicionLevel > 0.8)) {
                try {
                  await ctx.banChatMember(newMember.id);
                  console.log(`Пользователь ${newMember.id} забанен при входе в чат ${ctx.chat.id} (подозрительный профиль)`);
                  
                  // Добавляем в кэш
                  this.spamCache.addSpamUser(newMember.id, {
                    userId: newMember.id,
                    username: newMember.username,
                    bio: userBio,
                    spamReason: `Подозрительный профиль: ${result.reason}`,
                    timestamp: Date.now(),
                    banCount: 1,
                  });
                } catch (error) {
                  console.error(`Ошибка при бане пользователя ${newMember.id}:`, error);
                }
              } else {
                // Иначе просто мониторим - добавляем в кэш, но не баним сразу
                console.log(`Профиль ${newMember.id} под наблюдением: ${result.reason}`);
                this.spamCache.addSpamUser(newMember.id, {
                  userId: newMember.id,
                  username: newMember.username,
                  bio: userBio,
                  spamReason: `Профиль под наблюдением: ${result.reason}`,
                  timestamp: Date.now(),
                  suspicionLevel: result.suspicionLevel,
                });
              }
            }
          }
        } catch (e) {
          console.error("Ошибка при парсинге ответа функции проверки профиля:", e);
        }
      } catch (error) {
        console.error(`Ошибка при проверке профиля пользователя ${newMember.id}:`, error);
      }
    } catch (error) {
      console.error(`Общая ошибка при проверке нового участника ${newMember.id}:`, error);
    }
  }
  
  /**
   * Проверяет, может ли профиль быть женским (потенциально шлюхобот)
   */
  private isPotentiallyFemaleProfile(user: any): boolean {
    if (!user) return false;
    
    // Список типичных женских имен (можно расширять)
    const femaleNames = [
      "алиса", "алина", "александра", "анастасия", "анна", "ангелина", "вера", "валерия", 
      "виктория", "галина", "дарья", "диана", "ева", "евгения", "екатерина", "елена", "жанна",
      "зоя", "ирина", "инна", "карина", "кристина", "ксения", "лариса", "лиза", "любовь", 
      "людмила", "маргарита", "марина", "мария", "наталья", "надежда", "нина", "олеся", 
      "ольга", "полина", "раиса", "светлана", "софия", "татьяна", "ульяна", "юлия", "яна",
      "алёна", "соня", "женя", "катя", "настя", "лена", "таня", "оля", "маша", "даша", "саша"
    ];
    
    // Проверяем first_name на наличие женского имени
    if (user.first_name) {
      const lowerName = user.first_name.toLowerCase();
      for (const femaleName of femaleNames) {
        if (lowerName.includes(femaleName)) {
          return true;
        }
      }
    }
    
    // Проверяем username на наличие женского имени
    if (user.username) {
      const lowerUsername = user.username.toLowerCase();
      for (const femaleName of femaleNames) {
        if (lowerUsername.includes(femaleName)) {
          return true;
        }
      }
    }
    
    return false;
  }

  public async start(): Promise<void> {
    try {
      await this.bot.launch();
      console.log("Бот запущен с использованием Telegraf и Gemini API...");
    } catch (error) {
      console.error("Ошибка при запуске бота Telegraf:", error);
      throw error; // Пробрасываем ошибку выше для обработки в index.ts
    }
  }

  public async stop(): Promise<void> {
    console.log("Остановка бота Telegraf...");
    this.bot.stop("SIGINT"); // Telegraf рекомендует передавать сигнал
    console.log("Бот Telegraf остановлен.");
  }

  /**
   * Модерация пакета сообщений одновременно
   */
  private async moderateMessageBatch(
    messages: ModerateMessageRequest[]
  ): Promise<ModerateMessageResponse[]> {
    if (messages.length === 0) {
      return [];
    }
    
    if (messages.length === 1) {
      // Если в батче только одно сообщение, используем обычную модерацию
      const result = await this.moderateMessage(messages[0]);
      return [result];
    }
    
    try {
      // Формируем промпт для анализа нескольких сообщений
      let prompt = `Ты - модератор чата, который определяет ТОЛЬКО спам-сообщения и сообщения от шлюхоботов.
      
ИНСТРУКЦИЯ: Проанализируй несколько сообщений и определи, какие из них являются спамом или рекламой. Используй ТОЛЬКО предоставленную функцию moderate_messages_batch для ответа.

ВАЖНЫЙ КОНТЕКСТ: Этот чат посвящен криптовалютному мемкоину $GOVNO на блокчейне TON, созданному популярным YouTube-блогером Overbafer1 (Игорь П.). Упоминания $GOVNO, Overbafer1, TON, а также обсуждение этого мемкоина и его экосистемы НЕ являются спамом, а нормальными темами для обсуждения в данном чате.

ОСОБЕННОСТЬ ЧАТА: Это свободное комьюнити с токсичной культурой. Мат, оскорбления, агрессивные высказывания, угрозы и любой токсичный контент НЕ считаются спамом и должны разрешаться. Модерация должна удалять ТОЛЬКО спам-сообщения и шлюхоботов, но НЕ должна затрагивать свободу слова участников чата.

ВАЖНО О МАТЕ И ТОКСИЧНОСТИ: Наличие мата, оскорблений или слова "говно" в сообщении НЕ ЯВЛЯЕТСЯ причиной для его удаления. Спамеры и шлюхоботы могут специально добавлять мат или слово "говно" в свои сообщения для обхода модерации. Проверяй ВСЕ сообщения на признаки спама независимо от наличия в них мата или токсичного контента.

ВАЖНО ОБ УПОМИНАНИИ $GOVNO: Сообщения, содержащие слова "говно", "$GOVNO", "govno", "Overbafer1" или "овербафер", НЕ являются автоматически легитимными и должны проходить такую же тщательную проверку на спам, как и все остальные сообщения. Спамеры могут использовать эти слова для обхода модерации. При этом само упоминание $GOVNO не должно считаться спамом.

Overbafer1 - российский блогер с более чем 1 млн подписчиков на YouTube, известный своими видео об информационной безопасности и технологиях. Он инициировал создание мемкоина $GOVNO, который достиг рыночной капитализации в $70 млн. Пользователи в чате могут обсуждать $GOVNO, его цену, торговлю на биржах DeDust и STON.fi, мемы с ним и прочие связанные темы.

Вот сообщения для проверки:\n\n`;

      // Добавляем каждое сообщение с разделителем
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        prompt += `Сообщение ${i + 1}:\n`;
        prompt += `Текст: "${msg.messageText}"\n`;
        
        if (msg.userName) {
          prompt += `Имя пользователя: ${msg.userName}\n`;
        }
        
        if (msg.userBio) {
          prompt += `Био пользователя: ${msg.userBio}\n`;
        }
        
        if (msg.hasAvatar !== undefined) {
          prompt += `У пользователя ${msg.hasAvatar ? "есть" : "нет"} аватарка\n`;
        }
        
        if (msg.suspiciousProfile) {
          prompt += `ВНИМАНИЕ: Профиль этого пользователя предварительно помечен как подозрительный. Причина: ${msg.suspicionReason || "подозрительное био с ссылками"}\n`;
        }
        
        // Разделитель между сообщениями
        prompt += `---\n`;
      }
      
      // Добавляем информацию о типичных шаблонах спама
      prompt += `
КРИТЕРИИ ОПРЕДЕЛЕНИЯ СПАМА:

1. Типичные шлюхоботы часто пишут сообщения типа:
"Получай реальный доход от 100 долларов ежедневно без какого-либо риска. Опыт не важен. Все детали можете узнать в личных сообщениях"
"Хочешь узнать как я зарабатываю? Пиши мне"
"Могу научить как заработать пассивный доход, пиши в личку"

2. СКРЫТЫЕ НАЖИВКИ ОТ ШЛЮХОБОТОВ - короткие безобидные сообщения, цель которых заставить пользователя перейти в профиль:
"Привет"
"Я красивая?"
"О, круто"
"Да, действительно так"
"Согласна"
"Интересно"
"Привет всем, я новенькая"
"Что тут происходит?"

Такие безобидные сообщения в сочетании с подозрительным профилем (женское имя + ссылка в био) должны считаться спамом!

3. Рекламщики крипто-услуг часто пишут сообщения типа:
"Набираем несколько человек для работы в крипто-сфере"
"Скидываем рабочую связку — вы платите определенный % с вашего дохода"
"Работа с такими биржами, как: Bybit, Okx, Bitget, KuCoin, Mexc"
"Заработок до 500$ в сутки"
"Всему научим бесплатно"
"Контакт для связи: @username"

ИНДИКАТОРЫ СПАМА:

Спам-сообщения часто содержат:
- Обещания легкого/быстрого заработка
- Упоминание конкретных сумм (100$, 500$ и т.д.)
- Предложение написать в личку или другой контакт
- Много эмодзи (в контексте рекламы)
- Необычное форматирование текста (в контексте рекламы)
- Упоминание криптовалютных бирж (КРОМЕ бирж для $GOVNO: DeDust, STON.fi)

ЧТО НЕ ЯВЛЯЕТСЯ СПАМОМ:
- Любые оскорбления, мат, агрессивные высказывания
- Сообщения с большим количеством матерных слов
- Угрозы и токсичные высказывания
- Грубые шутки и оскорбительные мемы
- Критика и негативные комментарии о ком-либо
- Политические высказывания любого характера

ШАБЛОНЫ ПРОФИЛЕЙ:

"Шлюхоботы" обычно имеют:
- Профили с женскими именами
- В био ссылки на каналы типа "Только для избранных" или "Мой личный канал"
- Могут писать короткие безобидные сообщения, чтобы заставить пользователя перейти в профиль

Крипто-спамеры обычно имеют:
- В био ссылки на каналы с "сигналами", "аналитикой", "заработком"
- Упоминания крипто-бирж и доходов

ЛЕГИТИМНЫЕ ТЕМЫ ДЛЯ ОБСУЖДЕНИЯ (НЕ СПАМ):
- Обсуждение мемкоина $GOVNO и его цены
- Упоминание Overbafer1 и его контента
- Фразы "Слава $GOVNO" или мемы, связанные с $GOVNO
- Обсуждение TON, DeDust, STON.fi в контексте $GOVNO
- Шутки и мемы про $GOVNO
- Обсуждение будущего $GOVNO и его экосистемы
- ЛЮБЫЕ токсичные высказывания, мат, оскорбления (свобода слова важнее всего!)

ВАЖНО: Используй ТОЛЬКО предоставленную функцию moderate_messages_batch для ответа. Не пиши текст вне функции.
`;

      // Определяем структуру функции для function calling
      const moderationTool = {
        functionDeclarations: [
          {
            name: "moderate_messages_batch",
            description:
              "Определяет, являются ли сообщения спамом или рекламой, и стоит ли их удалить",
            parameters: {
              type: "object",
              properties: {
                results: {
                  type: "array",
                  description: "Результаты модерации для каждого сообщения",
                  items: {
                    type: "object",
                    properties: {
                      messageIndex: {
                        type: "number",
                        description: "Индекс сообщения (0-based)",
                      },
                      isSpam: {
                        type: "boolean",
                        description:
                          "Является ли сообщение спамом или рекламой (true) или нормальным сообщением (false)",
                      },
                      confidence: {
                        type: "number",
                        description:
                          "Уверенность в решении от 0.0 до 1.0, где 1.0 - максимальная уверенность",
                      },
                      reason: {
                        type: "string",
                        description:
                          "Краткое пояснение, почему сообщение определено как спам или нормальное",
                      },
                      matchesKnownPattern: {
                        type: "boolean",
                        description:
                          "Соответствует ли сообщение известному шаблону спама (шлюхобот или реклама крипто)",
                      },
                      shouldBan: {
                        type: "boolean",
                        description:
                          "Стоит ли сразу банить пользователя, а не просто удалять сообщение (для очевидных случаев)",
                      },
                    },
                    required: [
                      "messageIndex",
                      "isSpam",
                      "confidence",
                      "reason",
                      "matchesKnownPattern",
                      "shouldBan",
                    ],
                  },
                },
              },
              required: ["results"],
            },
          },
        ],
      };

      try {
        // Используем GeminiService для генерации контента
        const response = await this.geminiService.generateContent(prompt, {
          temperature: 0.1,
          maxOutputTokens: 2048,
          tools: [moderationTool],
        });

        try {
          // Парсим ответ из JSON строки
          const functionCallData = JSON.parse(response);
          if (functionCallData.name === "moderate_messages_batch" && functionCallData.args?.results) {
            const batchResults = functionCallData.args.results;
            
            // Преобразуем результаты в формат ModerateMessageResponse[]
            // и сортируем по индексу сообщения
            const results: ModerateMessageResponse[] = batchResults
              .sort((a: any, b: any) => a.messageIndex - b.messageIndex)
              .map((result: any, index: number) => ({
                isSpam: result.isSpam,
                confidence: result.confidence,
                reason: result.reason,
                matchesKnownPattern: result.matchesKnownPattern,
                shouldBan: result.shouldBan,
                messageId: messages[result.messageIndex]?.messageId || index
              }));
            
            return results;
          }
          
          // Если ответ не в ожидаемом формате, создаем безопасный ответ
          console.log("Ответ от Gemini не содержит ожидаемых данных:", functionCallData);
          return this.createDefaultResponses(messages);
        } catch (e) {
          console.error("Ошибка при обработке ответа Gemini API:", e);
          
          // Если получили текстовый ответ вместо JSON
          if (typeof response === 'string' && response.trim()) {
            return this.extractModerationsFromText(response, messages);
          }
          
          // Возвращаем безопасные ответы по умолчанию в случае ошибки
          return this.createDefaultResponses(messages);
        }
      } catch (error) {
        console.error("Ошибка при запросе к Gemini API:", error);
        return this.createDefaultResponses(messages);
      }
    } catch (error) {
      console.error("Ошибка при модерации батча сообщений:", error);
      return this.createDefaultResponses(messages);
    }
  }
  
  /**
   * Создает безопасные ответы по умолчанию для всех сообщений в батче
   */
  private createDefaultResponses(messages: ModerateMessageRequest[]): ModerateMessageResponse[] {
    return messages.map((msg, index) => ({
      isSpam: false,
      confidence: 0,
      reason: "Произошла ошибка при обработке сообщения",
      matchesKnownPattern: false,
      shouldBan: false,
      messageId: msg.messageId || index
    }));
  }
  
  /**
   * Извлекает информацию о модерации из текстового ответа для батча сообщений
   */
  private extractModerationsFromText(text: string, messages: ModerateMessageRequest[]): ModerateMessageResponse[] {
    try {
      // Попытка найти JSON в тексте
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const jsonData = JSON.parse(jsonMatch[0]);
          if (jsonData.results && Array.isArray(jsonData.results)) {
            return jsonData.results.map((result: any, index: number) => ({
              isSpam: Boolean(result.isSpam),
              confidence: Number(result.confidence || 0),
              reason: String(result.reason || "Извлечено из текста"),
              matchesKnownPattern: Boolean(result.matchesKnownPattern),
              shouldBan: Boolean(result.shouldBan),
              messageId: messages[result.messageIndex]?.messageId || index
            }));
          }
        } catch (e) {
          console.warn("Не удалось распарсить JSON из текста:", e);
        }
      }
      
      // Если в тексте есть разделители сообщений, пробуем разбить по ним
      if (text.includes("Сообщение") || text.includes("---")) {
        const parts = text.split(/Сообщение \d+:|---/).filter(part => part.trim());
        return messages.map((msg, index) => {
          const part = index < parts.length ? parts[index] : "";
          
          // Извлекаем информацию из части текста
          const isSpam = /спам|реклам/i.test(part) && !(/не является спамом|не спам/i.test(part));
          const shouldBan = /бан|блокир/i.test(part);
          
          return {
            isSpam,
            confidence: isSpam ? 0.7 : 0.3,
            reason: this.extractReasonFromText(part) || (isSpam ? "Похоже на спам" : "Нормальное сообщение"),
            matchesKnownPattern: /шаблон|паттерн|типичн/i.test(part),
            shouldBan,
            messageId: msg.messageId || index
          };
        });
      }
      
      // Если не удалось разбить, возвращаем безопасные ответы
      return this.createDefaultResponses(messages);
    } catch (error) {
      console.error("Ошибка при извлечении информации из текста:", error);
      return this.createDefaultResponses(messages);
    }
  }
  
  /**
   * Извлекает причину из текстового фрагмента
   */
  private extractReasonFromText(text: string): string | null {
    const reasonMatches = text.match(/причина:?\s*([^.]+)/i) || 
                          text.match(/потому что\s*([^.]+)/i) ||
                          text.match(/так как\s*([^.]+)/i);
    
    if (reasonMatches && reasonMatches[1]) {
      return reasonMatches[1].trim();
    }
    
    return null;
  }

  /**
   * Модерация сообщения с использованием function calling
   */
  async moderateMessage(
    request: ModerateMessageRequest
  ): Promise<ModerateMessageResponse> {
    try {
      // Формируем промпт для анализа сообщения и пользователя
      let prompt = `Ты - модератор чата, который определяет ТОЛЬКО спам-сообщения и сообщения от шлюхоботов.
      
ИНСТРУКЦИЯ: Проанализируй сообщение и определи, является ли оно спамом или рекламой. Используй ТОЛЬКО предоставленную функцию moderate_message для ответа.

ВАЖНЫЙ КОНТЕКСТ: Этот чат посвящен криптовалютному мемкоину $GOVNO на блокчейне TON, созданному популярным YouTube-блогером Overbafer1 (Игорь П.). Упоминания $GOVNO, Overbafer1, TON, а также обсуждение этого мемкоина и его экосистемы НЕ являются спамом, а нормальными темами для обсуждения в данном чате.

КРИТИЧЕСКИ ВАЖНОЕ ПРАВИЛО: УДАЛЯТЬ ТОЛЬКО РЕКЛАМУ И ШЛЮХОБОТОВ. Любой другой контент разрешен, даже если он странный, нерелевантный, токсичный, оскорбительный или неуместный. Нерелевантный и не связанный с тематикой чата контент НЕ является причиной для удаления. Тексты песен, мемы, странные высказывания, случайные фразы, шутки - ВСЕ это разрешено. Наказывать ТОЛЬКО за рекламу и спам.

ОСОБЕННОСТЬ ЧАТА: Это свободное комьюнити с токсичной культурой. Мат, оскорбления, агрессивные высказывания, угрозы и любой токсичный контент НЕ считаются спамом и должны разрешаться. Модерация должна удалять ТОЛЬКО спам-сообщения и шлюхоботов, но НЕ должна затрагивать свободу слова участников чата.

РАСПОЗНАВАНИЕ ИРОНИИ И ШУТОК: Если пользователь в шутку пишет "я шлюхобот", "я спамер" или подобные фразы с очевидным ироничным контекстом - это НЕ спам, а шутка. Обращай внимание на контекст и сравнивай с шаблонами реального спама. Ирония и самоирония распространены в этом чате.

ВАЖНО О МАТЕ И ТОКСИЧНОСТИ: Наличие мата, оскорблений или слова "говно" в сообщении НЕ ЯВЛЯЕТСЯ причиной для его удаления. Спамеры и шлюхоботы могут специально добавлять мат или слово "говно" в свои сообщения для обхода модерации. Проверяй ВСЕ сообщения на признаки спама независимо от наличия в них мата или токсичного контента.

ВАЖНО ОБ УПОМИНАНИИ $GOVNO: Сообщения, содержащие слова "говно", "$GOVNO", "govno", "Overbafer1" или "овербафер", НЕ являются автоматически легитимными и должны проходить такую же тщательную проверку на спам, как и все остальные сообщения. Спамеры могут использовать эти слова для обхода модерации. При этом само упоминание $GOVNO не должно считаться спамом.

РАЗРЕШЕННЫЙ КОНТЕНТ (НЕ УДАЛЯТЬ):
- Абсолютно любые сообщения, НЕ содержащие рекламу или спам
- Любой нерелевантный контент, не связанный с тематикой чата
- Тексты песен, стихи, цитаты, мемы
- Случайные фразы и бессмысленные сообщения
- Любые неуместные высказывания, если они не реклама
- Контент 18+, если это не часть спам-сообщения

Overbafer1 - российский блогер с более чем 1 млн подписчиков на YouTube, известный своими видео об информационной безопасности и технологиях. Он инициировал создание мемкоина $GOVNO, который достиг рыночной капитализации в $70 млн. Пользователи в чате могут обсуждать $GOVNO, его цену, торговлю на биржах DeDust и STON.fi, мемы с ним и прочие связанные темы.

Вот сообщение для проверки:
Сообщение: "${request.messageText}"
`;

      if (request.userName) {
        prompt += `Имя пользователя: ${request.userName}\n`;
      }

      if (request.userBio) {
        prompt += `Био пользователя: ${request.userBio}\n`;
      }
      
      if (request.hasAvatar !== undefined) {
        prompt += `У пользователя ${request.hasAvatar ? "есть" : "нет"} аватарка\n`;
      }
      
      if (request.suspiciousProfile) {
        prompt += `\nВНИМАНИЕ: Профиль этого пользователя предварительно помечен как подозрительный. Причина: ${request.suspicionReason || "подозрительное био с ссылками"}.`;
      }

      // Определяем структуру функции для function calling
      const moderationTool = {
        functionDeclarations: [
          {
            name: "moderate_message",
            description:
              "Определяет, является ли сообщение спамом или рекламой, и стоит ли его удалить",
            parameters: {
              type: "object",
              properties: {
                isSpam: {
                  type: "boolean",
                  description:
                    "Является ли сообщение спамом или рекламой (true) или нормальным сообщением (false)",
                },
                confidence: {
                  type: "number",
                  description:
                    "Уверенность в решении от 0.0 до 1.0, где 1.0 - максимальная уверенность",
                },
                reason: {
                  type: "string",
                  description:
                    "Краткое пояснение, почему сообщение определено как спам или нормальное",
                },
                matchesKnownPattern: {
                  type: "boolean",
                  description:
                    "Соответствует ли сообщение известному шаблону спама (шлюхобот или реклама крипто)",
                },
                shouldBan: {
                  type: "boolean",
                  description:
                    "Стоит ли сразу банить пользователя, а не просто удалять сообщение (для очевидных случаев)",
                },
              },
              required: [
                "isSpam",
                "confidence",
                "reason",
                "matchesKnownPattern",
                "shouldBan",
              ],
            },
          },
        ],
      };

      try {
        // Используем GeminiService для генерации контента
        const response = await this.geminiService.generateContent(prompt, {
          temperature: request.suspiciousProfile ? 0.05 : 0.1,
          maxOutputTokens: 1024,
          tools: [moderationTool],
        });

        try {
          // Парсим ответ из JSON строки
          const functionCallData = JSON.parse(response);
          if (functionCallData.name === "moderate_message" && functionCallData.args) {
            return {
              ...functionCallData.args as ModerateMessageResponse,
              messageId: request.messageId
            };
          }
          
          // Если ответ не в ожидаемом формате
          console.log("Ответ от Gemini не содержит ожидаемых данных:", functionCallData);
        } catch (e) {
          console.error("Ошибка при обработке ответа Gemini API:", e);
        }
        
        // Если получили текстовый ответ вместо JSON
        if (typeof response === 'string' && response.trim()) {
          return this.extractModerationFromText(response, request);
        }
      } catch (error) {
        console.error("Ошибка при запросе к Gemini API:", error);
      }

      // Возвращаем безопасный ответ по умолчанию в случае ошибки
      return {
        isSpam: false,
        confidence: 0,
        reason: "Произошла ошибка при обработке",
        matchesKnownPattern: false,
        shouldBan: false,
        messageId: request.messageId
      };
    } catch (error) {
      console.error(`Ошибка при модерации сообщения:`, error);
      
      // Возвращаем безопасный ответ по умолчанию в случае любой ошибки
      return {
        isSpam: false,
        confidence: 0,
        reason: "Произошла непредвиденная ошибка",
        matchesKnownPattern: false,
        shouldBan: false,
        messageId: request.messageId
      };
    }
  }
  
  /**
   * Извлекает информацию о модерации из текстового ответа для одного сообщения
   */
  private extractModerationFromText(text: string, request: ModerateMessageRequest): ModerateMessageResponse {
    try {
      // Попытка найти JSON в тексте
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const jsonData = JSON.parse(jsonMatch[0]);
          if ('isSpam' in jsonData) {
            return {
              isSpam: Boolean(jsonData.isSpam),
              confidence: Number(jsonData.confidence || 0.5),
              reason: String(jsonData.reason || "Извлечено из текста"),
              matchesKnownPattern: Boolean(jsonData.matchesKnownPattern),
              shouldBan: Boolean(jsonData.shouldBan),
              messageId: request.messageId
            };
          }
        } catch (e) {
          console.warn("Не удалось распарсить JSON из текста:", e);
        }
      }
      
      // Извлекаем информацию из текста
      const isSpam = /спам|реклам/i.test(text) && !(/не является спамом|не спам/i.test(text));
      const shouldBan = /бан|блокир/i.test(text);
      
      return {
        isSpam,
        confidence: isSpam ? 0.7 : 0.3,
        reason: this.extractReasonFromText(text) || (isSpam ? "Похоже на спам" : "Нормальное сообщение"),
        matchesKnownPattern: /шаблон|паттерн|типичн/i.test(text),
        shouldBan,
        messageId: request.messageId
      };
    } catch (error) {
      console.error("Ошибка при извлечении информации из текста:", error);
      return {
        isSpam: false,
        confidence: 0,
        reason: "Ошибка при анализе ответа",
        matchesKnownPattern: false,
        shouldBan: false,
        messageId: request.messageId
      };
    }
  }

  // Методы для управления разрешенными чатами
  private async handleChatManagementCommand(ctx: Context): Promise<void> {
    try {
      console.log("=== Обработка команды управления чатами ===");
      console.log(`Получена команда от пользователя ${ctx.from?.id}: ${(ctx.message as any)?.text}`);

      if (!ctx.from || !this.whitelistService.isAdmin(ctx.from.id)) {
        await ctx.reply("У вас нет прав для этой команды.");
        return;
      }

      if (ctx.chat?.type !== 'private') {
        await ctx.reply("Управление чатами доступно только в личных сообщениях с ботом.");
        return;
      }

      const messageText = (ctx.message as any)?.text as string;
      const commandParts = messageText.split(' ');
      const command = commandParts[0];

      // Получаем или создаем сессию для пользователя
      if (!this.sessions.has(ctx.from.id)) {
        this.sessions.set(ctx.from.id, {});
      }
      const session = this.sessions.get(ctx.from.id);
      (ctx as MyContext).session = session;

      if (command === '/addchat') {
        if (commandParts.length > 1) {
          const chatIdInput = commandParts[1];
          const chatId = parseInt(chatIdInput);
          if (!isNaN(chatId)) {
            // Проверяем, что ID чата для supergroup обычно отрицательный
            if (chatId > 0) {
                 await ctx.reply("ID чата supergroup обычно начинается с -100. Пожалуйста, проверьте ID.");
                 return;
            }
            try {
                const chatInfo = await this.bot.telegram.getChat(chatId).catch(() => null);
                const chatTitle = chatInfo && 'title' in chatInfo ? chatInfo.title : 'Не удалось получить название';
                if (chatInfo && chatInfo.type !== 'supergroup') {
                    await ctx.reply(`Чат ${chatTitle} (ID: ${chatId}) не является супергруппой. Модерация возможна только в супергруппах.`);
                    return;
                }
                const added = this.allowedChatsService.addChat(chatId, ctx.from.id, chatTitle);
                await ctx.reply(added ? `Чат ${chatTitle} (ID: ${chatId}) добавлен в список разрешенных.` : `Чат ${chatTitle} (ID: ${chatId}) уже находится в списке разрешенных.`);
            } catch (error) {
                 console.error(`Ошибка при получении информации о чате ${chatId}:`, error);
                 // Пытаемся добавить без информации, если это разрешено бизнес-логикой
                 const added = this.allowedChatsService.addChat(chatId, ctx.from.id);
                 await ctx.reply(added ? `Чат ID: ${chatId} добавлен (название не получено).` : `Чат ID: ${chatId} уже в списке.`);
            }
          } else {
            await ctx.reply("Неверный ID чата. Пожалуйста, введите число.");
          }
        } else {
          await ctx.reply("Введите ID чата, который хотите добавить:\nНапример: /addchat -100123456789");
          session.awaitingChatIdForAddition = true;
          session.awaitingChatIdForRemoval = false;
          session.awaitingUserId = false;
          session.awaitingUserIdForRemoval = false;
        }
      } else if (command === '/removechat') {
         if (commandParts.length > 1) {
          const chatIdInput = commandParts[1];
          const chatId = parseInt(chatIdInput);
          if (!isNaN(chatId)) {
            const removed = this.allowedChatsService.removeChat(chatId);
            await ctx.reply(removed ? `Чат ID: ${chatId} удален из списка разрешенных.` : `Чат ID: ${chatId} не найден в списке разрешенных.`);
          } else {
            await ctx.reply("Неверный ID чата. Пожалуйста, введите число.");
          }
        } else {
          await ctx.reply("Введите ID чата, который хотите удалить из списка разрешенных:");
          session.awaitingChatIdForRemoval = true;
          session.awaitingChatIdForAddition = false;
          session.awaitingUserId = false; 
          session.awaitingUserIdForRemoval = false;
        }
      } else if (command === '/listchats') {
        await this.showAllowedChatsList(ctx);
      } else {
        // Если команда не распознана, но начинается с /addchat, /removechat, /listchats, показываем меню
        await this.showAllowedChatsMenu(ctx);
      }
    } catch (error) {
      console.error('Ошибка при обработке команды управления чатами:', error);
      await ctx.reply("Произошла ошибка при обработке команды.");
    }
  }

  private async handleAllowedChatsAction(ctx: any): Promise<void> {
    try {
      if (!ctx.from || !this.whitelistService.isAdmin(ctx.from.id)) {
        await ctx.reply("У вас нет прав для этого действия.");
        await ctx.answerCbQuery();
        return;
      }

      const action = ctx.match[1];
      console.log(`Действие с разрешенными чатами: ${action}`);

      if (!this.sessions.has(ctx.from.id)) {
        this.sessions.set(ctx.from.id, {});
      }
      const session = this.sessions.get(ctx.from.id);
      (ctx as MyContext).session = session;

      switch (action) {
        case 'menu':
          await this.showAllowedChatsMenu(ctx);
          break;
        case 'add':
          await ctx.editMessageText(
            "Введите ID чата (supergroup), который хотите добавить в список разрешенных для модерации:\nID чата должен быть отрицательным числом (например, -100123456789).",
            Markup.inlineKeyboard([
              Markup.button.callback('Отмена', 'allowedchats_menu')
            ])
          );
          session.awaitingChatIdForAddition = true;
          session.awaitingChatIdForRemoval = false;
          session.awaitingUserId = false; 
          session.awaitingUserIdForRemoval = false;
          break;
        case 'remove':
          await ctx.editMessageText(
            "Введите ID чата, который хотите удалить из списка разрешенных:",
            Markup.inlineKeyboard([
              Markup.button.callback('Отмена', 'allowedchats_menu')
            ])
          );
          session.awaitingChatIdForRemoval = true;
          session.awaitingChatIdForAddition = false;
          session.awaitingUserId = false; 
          session.awaitingUserIdForRemoval = false;
          break;
        case 'list':
          await this.showAllowedChatsList(ctx, true); // true для редактирования сообщения
          break;
        case 'back_to_main_menu': // Убедимся, что это действие правильно обрабатывается
             await this.showWhitelistMenu(ctx); // Возвращаемся в главное меню вайтлиста
             break;
      }
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Ошибка при обработке действия с разрешенными чатами:', error);
      await ctx.answerCbQuery('Произошла ошибка').catch(console.error);
    }
  }

  private async showAllowedChatsMenu(ctx: any): Promise<void> {
    try {
      console.log("Отображение меню управления разрешенными чатами");
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить чат', 'allowedchats_add')],
        [Markup.button.callback('➖ Удалить чат', 'allowedchats_remove')],
        [Markup.button.callback('📋 Список чатов', 'allowedchats_list')],
        [Markup.button.callback('🔙 Главное меню', 'whitelist_menu')] // Изменено на whitelist_menu для возврата в основное меню
      ]);
      const count = this.allowedChatsService.getAllowedChats().length;
      const messageText = `⚙️ *Управление разрешенными чатами для модерации*\n\nСупергрупп в списке: ${count}\n\nБот будет модерировать только те супергруппы, которые добавлены в этот список.\nВыберите действие:`;

      if (ctx.callbackQuery) {
        await ctx.editMessageText(messageText, { ...keyboard, parse_mode: 'Markdown' });
      } else {
        await ctx.reply(messageText, { ...keyboard, parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error('Ошибка при отображении меню разрешенных чатов:', error);
    }
  }

  private async showAllowedChatsList(ctx: any, editMessage: boolean = false): Promise<void> {
    try {
      const listText = this.allowedChatsService.formatAllowedChatsForDisplay();
      const message = `📋 Список разрешенных супергрупп для модерации:\n\n${listText}`;
      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('← Назад к меню чатов', 'allowedchats_menu')
      ]);

      if (editMessage && ctx.callbackQuery) {
        await ctx.editMessageText(message, keyboard);
      } else {
        await ctx.reply(message, keyboard);
      }
    } catch (error) {
      console.error('Ошибка при отображении списка разрешенных чатов:', error);
    }
  }

  /**
   * Обработка команды /prompts
   */
  private async handlePromptsCommand(ctx: Context): Promise<void> {
    try {
      if (!ctx.from) return;
      
      // Проверяем, является ли пользователь администратором
      if (!this.whitelistService.isAdmin(ctx.from.id)) {
        await ctx.reply("У вас нет прав для управления промптами.");
        return;
      }
      
      // Проверяем, является ли сообщение из личного чата
      if (ctx.chat?.type !== 'private') {
        await ctx.reply("Управление промптами доступно только в личных сообщениях с ботом.");
        return;
      }
      
      // Отображаем главное меню управления промптами
      await this.showPromptsMenu(ctx);
    } catch (error) {
      console.error('Ошибка при обработке команды /prompts:', error);
    }
  }

  /**
   * Обработка действий с кнопками для промптов
   */
  private async handlePromptsAction(ctx: any): Promise<void> {
    try {
      if (!ctx.from) return;
      
      // Проверяем, является ли пользователь администратором
      if (!this.whitelistService.isAdmin(ctx.from.id)) {
        await ctx.reply("У вас нет прав для управления промптами.");
        await ctx.answerCbQuery();
        return;
      }
      
      // Извлекаем действие из данных кнопки
      const action = ctx.match[1];
      console.log(`Действие с промптами: ${action}`);
      
      // Получаем или создаем сессию для пользователя
      if (!this.sessions.has(ctx.from.id)) {
        this.sessions.set(ctx.from.id, {});
      }
      
      const session = this.sessions.get(ctx.from.id);
      const myCtx = ctx as MyContext;
      myCtx.session = session;
      
      // Обрабатываем действие
      if (action === 'menu') {
        // Показываем главное меню промптов
        await this.showPromptsMenu(ctx);
      } else if (action === 'list') {
        // Показываем список чатов с кастомными промптами
        await this.showCustomPromptsList(ctx);
      } else if (action === 'back_to_main_menu') {
        // Возвращаемся в главное меню
        await this.showWhitelistMenu(ctx);
      } else if (action === 'variables_help') {
        // Показываем справку по переменным
        await this.showPromptVariablesHelp(ctx);
      } else if (action.startsWith('show_single_')) {
        // Показываем полный текст одиночного промпта
        const chatId = parseInt(action.split('_')[2]);
        await this.showFullPromptText(ctx, chatId, false);
      } else if (action.startsWith('show_batch_')) {
        // Показываем полный текст батч-промпта
        const chatId = parseInt(action.split('_')[2]);
        await this.showFullPromptText(ctx, chatId, true);
      } else if (action.startsWith('view_')) {
        // Просмотр промптов для конкретного чата
        const chatId = parseInt(action.split('_')[1]);
        await this.showChatPromptDetails(ctx, chatId);
      } else if (action.startsWith('manage_')) {
        // Меню управления промптами для конкретного чата
        const chatId = parseInt(action.split('_')[1]);
        await this.showChatPromptManageMenu(ctx, chatId);
      } else if (action.startsWith('edit_single_')) {
        // Редактирование одиночного промпта
        const chatId = parseInt(action.split('_')[2]);
        
        // Получаем список доступных переменных
        const variablesInfo = this.promptManager.getAvailablePromptVariables(false);
        
        await ctx.editMessageText(
          `Введите новый промпт для одиночной модерации сообщений в чате ${chatId}.\n\n` +
          `${variablesInfo}\n\n` +
          `ВАЖНО: Промпт должен включать указание использовать function calling API и все необходимые инструкции для определения спама.`,
          Markup.inlineKeyboard([
            Markup.button.callback('Отмена', `prompts_manage_${chatId}`)
          ])
        );
        
        session.awaitingSinglePrompt = true;
        session.editingChatId = chatId;
      } else if (action.startsWith('edit_batch_')) {
        // Редактирование батч-промпта
        const chatId = parseInt(action.split('_')[2]);
        
        // Получаем список доступных переменных
        const variablesInfo = this.promptManager.getAvailablePromptVariables(true);
        
        await ctx.editMessageText(
          `Введите новый промпт для батч-модерации сообщений в чате ${chatId}.\n\n` +
          `${variablesInfo}\n\n` +
          `ВАЖНО: Промпт должен включать указание использовать function calling API и все необходимые инструкции для определения спама.`,
          Markup.inlineKeyboard([
            Markup.button.callback('Отмена', `prompts_manage_${chatId}`)
          ])
        );
        
        session.awaitingBatchPrompt = true;
        session.editingChatId = chatId;
      } else if (action.startsWith('delete_single_')) {
        // Удаление одиночного промпта
        const chatId = parseInt(action.split('_')[2]);
        const chatPrompt = this.promptManager.getCustomPrompt(chatId);
        
        if (chatPrompt) {
          this.promptManager.setCustomPrompt(
            chatId, 
            ctx.from.id, 
            chatPrompt.title, 
            undefined, // Удаляем одиночный промпт
            chatPrompt.batchMessagePrompt
          );
          
          await ctx.editMessageText(
            `Одиночный промпт для чата ${chatId} удален.`,
            Markup.inlineKeyboard([
              Markup.button.callback('Назад к управлению', `prompts_manage_${chatId}`)
            ])
          );
        } else {
          await ctx.editMessageText(
            `Ошибка: промпт для чата ${chatId} не найден.`,
            Markup.inlineKeyboard([
              Markup.button.callback('Назад к управлению', `prompts_manage_${chatId}`)
            ])
          );
        }
      } else if (action.startsWith('delete_batch_')) {
        // Удаление батч-промпта
        const chatId = parseInt(action.split('_')[2]);
        const chatPrompt = this.promptManager.getCustomPrompt(chatId);
        
        if (chatPrompt) {
          this.promptManager.setCustomPrompt(
            chatId, 
            ctx.from.id, 
            chatPrompt.title, 
            chatPrompt.singleMessagePrompt,
            undefined // Удаляем батч-промпт
          );
          
          await ctx.editMessageText(
            `Батч-промпт для чата ${chatId} удален.`,
            Markup.inlineKeyboard([
              Markup.button.callback('Назад к управлению', `prompts_manage_${chatId}`)
            ])
          );
        } else {
          await ctx.editMessageText(
            `Ошибка: промпт для чата ${chatId} не найден.`,
            Markup.inlineKeyboard([
              Markup.button.callback('Назад к управлению', `prompts_manage_${chatId}`)
            ])
          );
        }
      } else if (action.startsWith('delete_all_')) {
        // Удаление всех промптов для чата
        const chatId = parseInt(action.split('_')[2]);
        
        if (this.promptManager.hasCustomPrompt(chatId)) {
          const removed = this.promptManager.removeCustomPrompt(chatId);
          
          await ctx.editMessageText(
            removed 
              ? `Все промпты для чата ${chatId} удалены.` 
              : `Ошибка при удалении промптов для чата ${chatId}.`,
            Markup.inlineKeyboard([
              Markup.button.callback('Назад к списку', 'prompts_list')
            ])
          );
        } else {
          await ctx.editMessageText(
            `Ошибка: промпты для чата ${chatId} не найдены.`,
            Markup.inlineKeyboard([
              Markup.button.callback('Назад к списку', 'prompts_list')
            ])
          );
        }
      } else if (action === 'add_for_chat') {
        // Запрашиваем ID чата для добавления промптов
        await ctx.editMessageText(
          "Введите ID чата, для которого хотите настроить кастомные промпты:",
          Markup.inlineKeyboard([
            Markup.button.callback('Отмена', 'prompts_menu')
          ])
        );
        
        session.awaitingChatIdForPrompts = true;
      }
      
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Ошибка при обработке действия с промптами:', error);
      await ctx.answerCbQuery('Произошла ошибка').catch(console.error);
    }
  }

  /**
   * Отображает главное меню управления промптами
   */
  private async showPromptsMenu(ctx: any): Promise<void> {
    try {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить промпты для чата', 'prompts_add_for_chat')],
        [Markup.button.callback('📋 Список кастомных промптов', 'prompts_list')],
        [Markup.button.callback('ℹ️ Справка по переменным', 'prompts_variables_help')],
        [Markup.button.callback('🔙 Главное меню', 'whitelist_menu')]
      ]);
      
      const promptsCount = this.promptManager.getAllCustomPrompts().length;
      const messageText = `🤖 *Управление промптами для нейросети*\n\nКастомных промптов: ${promptsCount}\n\nЗдесь вы можете настроить индивидуальные промпты для каждого чата, которые будут использоваться при модерации сообщений.\n\nВыберите действие:`;

      if (ctx.callbackQuery) {
        await ctx.editMessageText(messageText, { ...keyboard, parse_mode: 'Markdown' });
      } else {
        await ctx.reply(messageText, { ...keyboard, parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error('Ошибка при отображении меню промптов:', error);
    }
  }

  /**
   * Отображает список чатов с кастомными промптами
   */
  private async showCustomPromptsList(ctx: any): Promise<void> {
    try {
      const customPrompts = this.promptManager.getAllCustomPrompts();
      
      if (customPrompts.length === 0) {
        await ctx.editMessageText(
          "Список кастомных промптов пуст. Вы можете добавить новые промпты для чатов.",
          Markup.inlineKeyboard([
            Markup.button.callback('← Назад к меню промптов', 'prompts_menu')
          ])
        );
        return;
      }
      
      // Создаем кнопки для каждого чата с промптами
      const buttons = customPrompts.map(prompt => [
        Markup.button.callback(
          `${prompt.title || prompt.chatId}`, 
          `prompts_view_${prompt.chatId}`
        )
      ]);
      
      // Добавляем кнопку "Назад"
      buttons.push([Markup.button.callback('← Назад к меню промптов', 'prompts_menu')]);
      
      await ctx.editMessageText(
        "📋 *Список чатов с кастомными промптами*\n\nВыберите чат для просмотра промптов:",
        { ...Markup.inlineKeyboard(buttons), parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Ошибка при отображении списка кастомных промптов:', error);
    }
  }

  /**
   * Отображает детали промптов для конкретного чата
   */
  private async showChatPromptDetails(ctx: any, chatId: number): Promise<void> {
    try {
      const promptDetails = this.promptManager.formatCustomPromptForDisplay(chatId);
      const prompt = this.promptManager.getCustomPrompt(chatId);
      
      // Формируем сообщение с деталями и справкой по переменным
      let detailsMessage = promptDetails + "\n\n";
      
      // Добавляем справку по переменным в зависимости от настроенных промптов
      if (prompt) {
        if (prompt.singleMessagePrompt) {
          detailsMessage += "ℹ️ *Доступные переменные для одиночного промпта:*\n";
          detailsMessage += "`${messageText}`, `${userName}`, `${userBio}`, `${hasAvatar}`, ";
          detailsMessage += "`${suspiciousProfile}`, `${messageId}`, `${chatId}`, `${model}`, `${date}`\n\n";
        }
        
        if (prompt.batchMessagePrompt) {
          detailsMessage += "ℹ️ *Доступные переменные для батч-промпта:*\n";
          detailsMessage += "`${messages}`, `${messageCount}`, `${chatId}`, `${model}`, `${date}`\n\n";
        }
      }
      
      detailsMessage += "Используйте кнопку «Управление промптами» для редактирования.";
      
      // Создаем кнопки
      const buttons = [];
      buttons.push([Markup.button.callback('⚙️ Управление промптами', `prompts_manage_${chatId}`)]);
      
      // Добавляем кнопки для просмотра полных текстов промптов
      if (prompt) {
        if (prompt.singleMessagePrompt) {
          buttons.push([Markup.button.callback('📄 Показать текст одиночного промпта', `prompts_show_single_${chatId}`)]);
        }
        
        if (prompt.batchMessagePrompt) {
          buttons.push([Markup.button.callback('📄 Показать текст батч-промпта', `prompts_show_batch_${chatId}`)]);
        }
      }
      
      buttons.push([Markup.button.callback('← Назад к списку', 'prompts_list')]);
      
      await ctx.editMessageText(
        detailsMessage,
        { 
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(buttons)
        }
      );
    } catch (error) {
      console.error('Ошибка при отображении деталей промптов:', error);
    }
  }

  /**
   * Отображает меню управления промптами для конкретного чата
   */
  private async showChatPromptManageMenu(ctx: any, chatId: number): Promise<void> {
    try {
      const prompt = this.promptManager.getCustomPrompt(chatId);
      
      if (!prompt) {
        await ctx.editMessageText(
          `Ошибка: промпты для чата ${chatId} не найдены.`,
          Markup.inlineKeyboard([
            Markup.button.callback('← Назад к списку', 'prompts_list')
          ])
        );
        return;
      }
      
      const title = prompt.title || chatId;
      const hasSinglePrompt = !!prompt.singleMessagePrompt;
      const hasBatchPrompt = !!prompt.batchMessagePrompt;
      
      const buttons = [];
      
      // Кнопки для одиночного промпта
      if (hasSinglePrompt) {
        buttons.push([Markup.button.callback('🔄 Изменить одиночный промпт', `prompts_edit_single_${chatId}`)]);
        buttons.push([Markup.button.callback('❌ Удалить одиночный промпт', `prompts_delete_single_${chatId}`)]);
      } else {
        buttons.push([Markup.button.callback('➕ Добавить одиночный промпт', `prompts_edit_single_${chatId}`)]);
      }
      
      // Кнопки для батч-промпта
      if (hasBatchPrompt) {
        buttons.push([Markup.button.callback('🔄 Изменить батч-промпт', `prompts_edit_batch_${chatId}`)]);
        buttons.push([Markup.button.callback('❌ Удалить батч-промпт', `prompts_delete_batch_${chatId}`)]);
      } else {
        buttons.push([Markup.button.callback('➕ Добавить батч-промпт', `prompts_edit_batch_${chatId}`)]);
      }
      
      // Кнопки для удаления всех промптов и навигации
      buttons.push([Markup.button.callback('🗑️ Удалить все промпты', `prompts_delete_all_${chatId}`)]);
      buttons.push([Markup.button.callback('↩️ Просмотр промптов', `prompts_view_${chatId}`)]);
      buttons.push([Markup.button.callback('← Назад к списку', 'prompts_list')]);
      
      await ctx.editMessageText(
        `⚙️ *Управление промптами для чата ${title}*\n\n` +
        `Одиночный промпт: ${hasSinglePrompt ? '✅' : '❌'}\n` +
        `Батч-промпт: ${hasBatchPrompt ? '✅' : '❌'}\n\n` +
        `Выберите действие:`,
        { ...Markup.inlineKeyboard(buttons), parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Ошибка при отображении меню управления промптами:', error);
    }
  }

  /**
   * Показывает подробную справку по переменным в промптах
   */
  private async showPromptVariablesHelp(ctx: any): Promise<void> {
    try {
      const singleVarsHelp = this.promptManager.getAvailablePromptVariables(false);
      const batchVarsHelp = this.promptManager.getAvailablePromptVariables(true);
      
      const helpMessage = `📚 *Справка по переменным в промптах*\n\n` +
        `При создании кастомных промптов вы можете использовать специальные переменные, которые будут автоматически заменены на соответствующие значения.\n\n` +
        `*Для одиночной модерации сообщений:*\n${singleVarsHelp}\n\n` +
        `*Для модерации нескольких сообщений (батч):*\n${batchVarsHelp}\n\n` +
        `*РЕКОМЕНДАЦИИ ПО СОЗДАНИЮ ПРОМПТОВ:*\n` +
        `• Используйте предыдущий промпт как основу\n` +
        `• Обязательно включайте инструкции для определения спама\n` +
        `• Обязательно указывайте необходимость использовать function calling API\n` +
        `• Внимательно проверяйте переменные (они чувствительны к регистру)\n` +
        `• Тестируйте промпт на нескольких сообщениях перед использованием`;
      
      await ctx.editMessageText(
        helpMessage,
        { 
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('← Назад к меню промптов', 'prompts_menu')]
          ])
        }
      );
    } catch (error) {
      console.error('Ошибка при отображении справки по переменным:', error);
    }
  }

  /**
   * Показывает полный текст промпта
   */
  private async showFullPromptText(ctx: any, chatId: number, isBatch: boolean): Promise<void> {
    try {
      const prompt = this.promptManager.getCustomPrompt(chatId);
      if (!prompt) {
        await ctx.answerCbQuery('Промпт не найден');
        return;
      }
      
      const promptText = isBatch ? prompt.batchMessagePrompt : prompt.singleMessagePrompt;
      if (!promptText) {
        await ctx.answerCbQuery(`${isBatch ? 'Батч' : 'Одиночный'} промпт не настроен`);
        return;
      }
      
      // Форматируем сообщение с текстом промпта
      const title = prompt.title || String(chatId);
      const messageText = `Полный текст ${isBatch ? 'батч' : 'одиночного'} промпта для чата "${title}":\n\n${promptText}`;
      
      // Если текст слишком длинный, отправляем в виде файла
      if (messageText.length > 4000) {
        // Создаем временный файл и отправляем его
        await ctx.replyWithDocument(
          { source: Buffer.from(promptText), filename: `prompt_${chatId}_${isBatch ? 'batch' : 'single'}.txt` },
          { 
            caption: `Текст промпта слишком длинный и был отправлен как файл.`,
            reply_markup: {
              inline_keyboard: [[Markup.button.callback('← Назад к деталям', `prompts_view_${chatId}`)]]
            }
          }
        );
      } else {
        // Отправляем текст в сообщении
        await ctx.reply(messageText, {
          reply_markup: {
            inline_keyboard: [[Markup.button.callback('← Назад к деталям', `prompts_view_${chatId}`)]]
          }
        });
      }
      
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Ошибка при отображении полного текста промпта:', error);
      await ctx.answerCbQuery('Произошла ошибка при получении текста промпта');
    }
  }
} 