import * as fs from 'fs';
import * as path from 'path';

/**
 * Сервис для управления вайтлистом пользователей
 */
export class WhitelistService {
  private whitelist: Map<number, WhitelistedUser> = new Map();
  private whitelistFile: string;
  // ID админов указываются в формате целых чисел как в Telegram
  private admins: number[] = [8048008473, 955802048, 7134704410]; 

  constructor(dataDir: string = 'data') {
    // Создаем абсолютный путь к директории данных
    const absoluteDataDir = path.resolve(process.cwd(), dataDir);
    
    console.log(`Директория для хранения данных: ${absoluteDataDir}`);
    console.log(`Список администраторов: ${this.admins.join(", ")}`);
    
    // Создаем директорию для данных, если она не существует
    try {
      if (!fs.existsSync(absoluteDataDir)) {
        fs.mkdirSync(absoluteDataDir, { recursive: true });
        console.log(`Создана директория для данных: ${absoluteDataDir}`);
      }
    } catch (error) {
      console.error(`Ошибка при создании директории данных ${absoluteDataDir}:`, error);
    }
    
    this.whitelistFile = path.join(absoluteDataDir, 'whitelist.json');
    this.loadWhitelist();
    
    // Если вайтлист пустой, создадим файл с пустым массивом
    if (this.whitelist.size === 0) {
      this.saveWhitelist();
    }
  }

  /**
   * Загружает вайтлист из файла
   */
  private loadWhitelist(): void {
    try {
      if (fs.existsSync(this.whitelistFile)) {
        const data = fs.readFileSync(this.whitelistFile, 'utf-8');
        const users = JSON.parse(data) as WhitelistedUser[];
        
        this.whitelist.clear();
        users.forEach(user => {
          this.whitelist.set(user.userId, user);
        });
        
        console.log(`Загружено ${this.whitelist.size} пользователей в вайтлист из ${this.whitelistFile}`);
      } else {
        console.log(`Файл вайтлиста не найден: ${this.whitelistFile}, будет создан пустой вайтлист`);
      }
    } catch (error) {
      console.error(`Ошибка при загрузке вайтлиста из ${this.whitelistFile}:`, error);
    }
  }

  /**
   * Сохраняет вайтлист в файл
   */
  private saveWhitelist(): void {
    try {
      const users = Array.from(this.whitelist.values());
      fs.writeFileSync(this.whitelistFile, JSON.stringify(users, null, 2), 'utf-8');
      console.log(`Сохранено ${users.length} пользователей в вайтлист: ${this.whitelistFile}`);
    } catch (error) {
      console.error(`Ошибка при сохранении вайтлиста в ${this.whitelistFile}:`, error);
    }
  }

  /**
   * Проверяет, находится ли пользователь в вайтлисте
   */
  isWhitelisted(userId: number): boolean {
    return this.whitelist.has(userId);
  }

  /**
   * Добавляет пользователя в вайтлист
   */
  addToWhitelist(userId: number, username?: string, reason?: string, addedBy?: number): boolean {
    if (this.isWhitelisted(userId)) {
      return false; // Пользователь уже в вайтлисте
    }
    
    this.whitelist.set(userId, {
      userId,
      username,
      reason: reason || 'Добавлен вручную',
      addedAt: Date.now(),
      addedBy
    });
    
    this.saveWhitelist();
    return true;
  }

  /**
   * Удаляет пользователя из вайтлиста
   */
  removeFromWhitelist(userId: number): boolean {
    if (!this.isWhitelisted(userId)) {
      return false; // Пользователь не найден в вайтлисте
    }
    
    this.whitelist.delete(userId);
    this.saveWhitelist();
    return true;
  }

  /**
   * Получает список всех пользователей в вайтлисте
   */
  getWhitelistedUsers(): WhitelistedUser[] {
    return Array.from(this.whitelist.values());
  }

  /**
   * Получает информацию о пользователе в вайтлисте
   */
  getWhitelistedUser(userId: number): WhitelistedUser | undefined {
    return this.whitelist.get(userId);
  }

  /**
   * Проверяет, имеет ли пользователь права администратора для управления вайтлистом
   */
  isAdmin(userId: number): boolean {
    console.log(`Проверка администратора: userId=${userId}, тип: ${typeof userId}`);
    console.log(`Список администраторов: ${this.admins.join(", ")}`);
    
    // Обеспечиваем, что userId - число
    const numericUserId = Number(userId);
    
    const result = this.admins.includes(numericUserId);
    console.log(`Результат проверки: ${result}`);
    return result;
  }
  
  /**
   * Регистрирует пользователя как администратора (только для отладки)
   */
  registerAdmin(userId: number): boolean {
    console.log(`Попытка зарегистрировать администратора: ${userId}`);
    
    // Обеспечиваем, что userId - число
    const numericUserId = Number(userId);
    
    // Проверяем, не является ли пользователь уже администратором
    if (this.admins.includes(numericUserId)) {
      console.log(`Пользователь ${userId} уже является администратором`);
      return false;
    }
    
    // Добавляем пользователя в список администраторов
    this.admins.push(numericUserId);
    console.log(`Пользователь ${userId} добавлен в список администраторов`);
    console.log(`Обновленный список администраторов: ${this.admins.join(", ")}`);
    
    return true;
  }

  /**
   * Форматирует список пользователей в вайтлисте для вывода
   */
  formatWhitelistForDisplay(): string {
    const users = this.getWhitelistedUsers();
    
    if (users.length === 0) {
      return "Вайтлист пуст";
    }
    
    return users.map((user, index) => {
      const date = new Date(user.addedAt).toLocaleString('ru-RU');
      return `${index + 1}. ${user.username || 'ID: ' + user.userId} - ${user.reason} (Добавлен: ${date})`;
    }).join('\n');
  }
}

/**
 * Информация о пользователе в вайтлисте
 */
export interface WhitelistedUser {
  userId: number;
  username?: string;
  reason?: string;
  addedAt: number;
  addedBy?: number;
} 