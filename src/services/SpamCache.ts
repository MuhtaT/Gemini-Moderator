/**
 * Класс для кэширования информации о спамерах и их сообщениях
 */
export class SpamCache {
  private spamUsers: Map<number, SpamUserInfo> = new Map();
  private spamMessages: Set<string> = new Set();

  /**
   * Добавляет пользователя в кэш спамеров
   */
  addSpamUser(userId: number, userInfo: SpamUserInfo): void {
    this.spamUsers.set(userId, userInfo);
    console.log(`Пользователь ${userId} добавлен в кэш спамеров`);
  }

  /**
   * Проверяет, является ли пользователь известным спамером
   */
  isKnownSpammer(userId: number): boolean {
    return this.spamUsers.has(userId);
  }

  /**
   * Получает информацию о спам-пользователе
   */
  getSpamUserInfo(userId: number): SpamUserInfo | undefined {
    return this.spamUsers.get(userId);
  }

  /**
   * Добавляет сообщение в кэш спам-сообщений
   */
  addSpamMessage(messageText: string): void {
    // Нормализуем текст сообщения для более точного сравнения
    const normalizedText = this.normalizeMessage(messageText);
    this.spamMessages.add(normalizedText);
    console.log(`Спам-сообщение добавлено в кэш`);
  }

  /**
   * Проверяет, похоже ли сообщение на известный спам
   */
  isSimilarToKnownSpam(messageText: string): boolean {
    const normalizedText = this.normalizeMessage(messageText);
    return this.spamMessages.has(normalizedText);
  }

  /**
   * Очищает старые записи в кэше
   * Можно вызывать периодически для экономии памяти
   */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    
    // Очищаем старых пользователей
    for (const [userId, userInfo] of this.spamUsers.entries()) {
      if (now - userInfo.timestamp > maxAgeMs) {
        this.spamUsers.delete(userId);
        console.log(`Пользователь ${userId} удален из кэша по истечении срока`);
      }
    }
    
    // TODO: Если нужно, можно добавить очистку спам-сообщений,
    // но для этого нужно хранить timestamp для каждого сообщения
  }

  /**
   * Нормализует текст сообщения для более точного сравнения
   * Удаляет лишние пробелы, переводит в нижний регистр и т.д.
   */
  private normalizeMessage(text: string): string {
    return text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }
}

/**
 * Информация о спам-пользователе
 */
export interface SpamUserInfo {
  userId: number;
  username?: string;
  bio?: string;
  spamReason: string;
  timestamp: number; // Время добавления в кэш
  banCount?: number; // Сколько раз пользователь был забанен
  messageExamples?: string[]; // Примеры спам-сообщений
  suspicionLevel?: number; // Уровень подозрительности от 0 до 1
} 