import * as fs from 'fs';
import * as path from 'path';

export interface ChatPrompt {
  chatId: number;
  title?: string;
  singleMessagePrompt?: string;
  batchMessagePrompt?: string;
  updatedAt: number;
  updatedBy: number;
}

export class PromptManager {
  private customPrompts: Map<number, ChatPrompt> = new Map();
  private promptsFile: string;
  private dataDir: string;

  constructor(dataDir: string = 'data') {
    this.dataDir = path.resolve(process.cwd(), dataDir);
    this.promptsFile = path.join(this.dataDir, 'custom_prompts.json');
    this.ensureDataDirExists();
    this.loadPrompts();
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

  private loadPrompts(): void {
    try {
      if (fs.existsSync(this.promptsFile)) {
        const data = fs.readFileSync(this.promptsFile, 'utf-8');
        if (data && data.trim() !== '') {
          const prompts = JSON.parse(data) as ChatPrompt[];
          this.customPrompts.clear();
          prompts.forEach(prompt => {
            this.customPrompts.set(prompt.chatId, prompt);
          });
          console.log(`Загружено ${this.customPrompts.size} кастомных промптов из ${this.promptsFile}`);
        } else {
          console.log(`Файл кастомных промптов ${this.promptsFile} пуст, будет создан новый.`);
          this.customPrompts.clear();
          this.savePrompts();
        }
      } else {
        console.log(`Файл кастомных промптов не найден: ${this.promptsFile}, будет создан пустой список.`);
        this.customPrompts.clear();
        this.savePrompts();
      }
    } catch (error) {
      console.error(`Ошибка при загрузке кастомных промптов из ${this.promptsFile}:`, error);
      this.customPrompts.clear();
    }
  }

  private savePrompts(): void {
    try {
      const prompts = Array.from(this.customPrompts.values());
      fs.writeFileSync(this.promptsFile, JSON.stringify(prompts, null, 2), 'utf-8');
      console.log(`Сохранено ${prompts.length} кастомных промптов в ${this.promptsFile}`);
    } catch (error) {
      console.error(`Ошибка при сохранении кастомных промптов в ${this.promptsFile}:`, error);
    }
  }

  hasCustomPrompt(chatId: number): boolean {
    return this.customPrompts.has(chatId);
  }

  getCustomPrompt(chatId: number): ChatPrompt | undefined {
    return this.customPrompts.get(chatId);
  }

  getSingleMessagePrompt(chatId: number): string | undefined {
    return this.customPrompts.get(chatId)?.singleMessagePrompt;
  }

  getBatchMessagePrompt(chatId: number): string | undefined {
    return this.customPrompts.get(chatId)?.batchMessagePrompt;
  }

  setCustomPrompt(chatId: number, updatedBy: number, title?: string, singleMessagePrompt?: string, batchMessagePrompt?: string): boolean {
    const existingPrompt = this.customPrompts.get(chatId);
    
    if (existingPrompt) {
      // Обновляем существующий промпт
      this.customPrompts.set(chatId, {
        ...existingPrompt,
        title: title || existingPrompt.title,
        singleMessagePrompt: singleMessagePrompt !== undefined ? singleMessagePrompt : existingPrompt.singleMessagePrompt,
        batchMessagePrompt: batchMessagePrompt !== undefined ? batchMessagePrompt : existingPrompt.batchMessagePrompt,
        updatedAt: Date.now(),
        updatedBy
      });
    } else {
      // Создаем новый промпт
      this.customPrompts.set(chatId, {
        chatId,
        title,
        singleMessagePrompt,
        batchMessagePrompt,
        updatedAt: Date.now(),
        updatedBy
      });
    }
    
    this.savePrompts();
    return true;
  }

  removeCustomPrompt(chatId: number): boolean {
    if (!this.customPrompts.has(chatId)) {
      return false;
    }
    
    this.customPrompts.delete(chatId);
    this.savePrompts();
    return true;
  }

  getAllCustomPrompts(): ChatPrompt[] {
    return Array.from(this.customPrompts.values());
  }

  formatCustomPromptsForDisplay(): string {
    const prompts = this.getAllCustomPrompts();
    
    if (prompts.length === 0) {
      return "Список кастомных промптов пуст.";
    }
    
    return prompts.map((prompt, index) => {
      const date = new Date(prompt.updatedAt).toLocaleString('ru-RU');
      const hasSinglePrompt = prompt.singleMessagePrompt ? "✓" : "✗";
      const hasBatchPrompt = prompt.batchMessagePrompt ? "✓" : "✗";
      
      return `${index + 1}. Чат: ${prompt.title || prompt.chatId}\n   Одиночный промпт: ${hasSinglePrompt} | Батч промпт: ${hasBatchPrompt}\n   Обновлен: ${date}`;
    }).join('\n\n');
  }

  formatCustomPromptForDisplay(chatId: number): string {
    const prompt = this.getCustomPrompt(chatId);
    if (!prompt) {
      return `Промпты для чата ${chatId} не найдены.`;
    }
    
    const title = prompt.title || String(chatId);
    const updatedAt = new Date(prompt.updatedAt).toLocaleString('ru-RU');
    
    let result = `📝 *Промпты для чата "${title}" (ID: ${chatId})*\n\n`;
    result += `⏱️ Последнее обновление: ${updatedAt}\n\n`;
    
    if (prompt.singleMessagePrompt) {
      const previewText = this.getPromptPreview(prompt.singleMessagePrompt);
      result += `✅ *Одиночный промпт:* настроен\n`;
      result += `Начало промпта: \`${previewText}\`\n\n`;
    } else {
      result += `❌ *Одиночный промпт:* не настроен\n\n`;
    }
    
    if (prompt.batchMessagePrompt) {
      const previewText = this.getPromptPreview(prompt.batchMessagePrompt);
      result += `✅ *Батч-промпт:* настроен\n`;
      result += `Начало промпта: \`${previewText}\`\n\n`;
    } else {
      result += `❌ *Батч-промпт:* не настроен\n\n`;
    }
    
    return result;
  }
  
  /**
   * Возвращает начало промпта для предпросмотра
   * @param prompt Текст промпта
   * @returns Укороченная версия промпта
   */
  private getPromptPreview(prompt: string): string {
    if (!prompt) return '';
    
    // Обрезаем до 50 символов
    const maxLength = 50;
    let previewText = prompt.replace(/\n/g, ' ').trim();
    
    if (previewText.length > maxLength) {
      previewText = previewText.substring(0, maxLength) + '...';
    }
    
    // Экранируем символы Markdown
    return previewText.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }

  /**
   * Возвращает список доступных переменных для промптов
   * @param isBatchPrompt Если true, возвращает переменные для батч-промпта, иначе для одиночного промпта
   * @returns Строка с описанием всех доступных переменных
   */
  getAvailablePromptVariables(isBatchPrompt: boolean = false): string {
    if (isBatchPrompt) {
      return `Доступные переменные для батч-промпта:
      
\${messages} - список сообщений (автоматически форматированный)
\${messageCount} - количество сообщений в батче
\${chatId} - ID чата
\${model} - название модели (например, "gemini-2.0-flash")
\${date} - текущая дата и время

Пример использования: "Проанализируй \${messageCount} сообщений из чата \${chatId}..."`;
    } else {
      return `Доступные переменные для одиночного промпта:
      
\${messageText} - текст сообщения
\${userName} - имя пользователя
\${userBio} - био пользователя (если доступно)
\${hasAvatar} - наличие аватарки (true/false)
\${suspiciousProfile} - подозрительный профиль (true/false)
\${suspicionReason} - причина подозрительности (если есть)
\${messageId} - ID сообщения
\${chatId} - ID чата
\${model} - название модели (например, "gemini-2.0-flash")
\${date} - текущая дата и время

Пример использования: "Проверь сообщение от пользователя \${userName}: \${messageText}"`;
    }
  }
} 