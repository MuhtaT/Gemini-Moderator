import * as fs from 'fs';
import * as path from 'path';

export interface AllowedChat {
  chatId: number;
  title?: string; // Для удобства можно хранить название чата
  addedAt: number;
  addedBy: number; // ID администратора, который добавил чат
}

export class AllowedChatsService {
  private allowedChats: Map<number, AllowedChat> = new Map();
  private allowedChatsFile: string;
  private dataDir: string;

  constructor(dataDir: string = 'data') {
    this.dataDir = path.resolve(process.cwd(), dataDir);
    this.allowedChatsFile = path.join(this.dataDir, 'allowed_chats.json');
    this.ensureDataDirExists();
    this.loadAllowedChats();

    if (this.allowedChats.size === 0) {
      this.saveAllowedChats(); // Создаем файл, если его нет
    }
  }

  private ensureDataDirExists(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
        console.log(`Создана директория для данных: ${this.dataDir}`);
      }
    } catch (error) {
      console.error(`Ошибка при создании директории данных ${this.dataDir}:`, error);
    }
  }

  private loadAllowedChats(): void {
    try {
      if (fs.existsSync(this.allowedChatsFile)) {
        const data = fs.readFileSync(this.allowedChatsFile, 'utf-8');
        if (data) {
          const chats = JSON.parse(data) as AllowedChat[];
          this.allowedChats.clear();
          chats.forEach(chat => {
            this.allowedChats.set(chat.chatId, chat);
          });
          console.log(`Загружено ${this.allowedChats.size} разрешенных чатов из ${this.allowedChatsFile}`);
        } else {
          console.log(`Файл разрешенных чатов ${this.allowedChatsFile} пуст, будет создан новый.`);
          this.allowedChats.clear(); // Убедимся, что кэш пуст
        }
      } else {
        console.log(`Файл разрешенных чатов не найден: ${this.allowedChatsFile}, будет создан пустой список.`);
        this.allowedChats.clear(); // Убедимся, что кэш пуст
      }
    } catch (error) {
      console.error(`Ошибка при загрузке разрешенных чатов из ${this.allowedChatsFile}:`, error);
      this.allowedChats.clear(); // Очищаем кэш в случае ошибки
    }
  }

  private saveAllowedChats(): void {
    try {
      const chats = Array.from(this.allowedChats.values());
      fs.writeFileSync(this.allowedChatsFile, JSON.stringify(chats, null, 2), 'utf-8');
      console.log(`Сохранено ${chats.length} разрешенных чатов в ${this.allowedChatsFile}`);
    } catch (error) {
      console.error(`Ошибка при сохранении разрешенных чатов в ${this.allowedChatsFile}:`, error);
    }
  }

  addChat(chatId: number, addedBy: number, title?: string): boolean {
    if (this.allowedChats.has(chatId)) {
      console.log(`Чат ${chatId} уже в списке разрешенных.`);
      return false;
    }
    const newChat: AllowedChat = {
      chatId,
      title,
      addedAt: Date.now(),
      addedBy,
    };
    this.allowedChats.set(chatId, newChat);
    this.saveAllowedChats();
    console.log(`Чат ${chatId} (Название: ${title || 'Не указано'}) добавлен в список разрешенных администратором ${addedBy}.`);
    return true;
  }

  removeChat(chatId: number): boolean {
    if (!this.allowedChats.has(chatId)) {
      console.log(`Чат ${chatId} не найден в списке разрешенных.`);
      return false;
    }
    this.allowedChats.delete(chatId);
    this.saveAllowedChats();
    console.log(`Чат ${chatId} удален из списка разрешенных.`);
    return true;
  }

  isChatAllowed(chatId: number): boolean {
    const isAllowed = this.allowedChats.has(chatId);
    // console.log(`Проверка чата ${chatId}: ${isAllowed ? 'разрешен' : 'не разрешен'}`); // Можно раскомментировать для детального логгирования
    return isAllowed;
  }

  getAllowedChats(): AllowedChat[] {
    return Array.from(this.allowedChats.values());
  }

  formatAllowedChatsForDisplay(): string {
    const chats = this.getAllowedChats();
    if (chats.length === 0) {
      return "Список разрешенных чатов пуст.";
    }
    return chats.map((chat, index) => {
      const date = new Date(chat.addedAt).toLocaleString('ru-RU');
      return `${index + 1}. ID: ${chat.chatId} (Название: ${chat.title || 'Не указано'}) - Добавлен: ${date} админом ${chat.addedBy}`;
    }).join('\n');
  }
} 