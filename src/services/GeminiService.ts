import axios from "axios";
import { AppConfig } from "../config";

// Определяем типы для запросов и ответов Gemini API
export interface GeminiContent {
  parts: Array<{
    text?: string;
    inlineData?: {
      mimeType: string;
      data: string; // base64 encoded data
    };
  }>;
}

export interface GeminiRequestData {
  contents: GeminiContent[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
  safetySettings?: Array<{
    category: string;
    threshold: string;
  }>;
  tools?: Array<{
    functionDeclarations: FunctionDeclaration[];
  }>;
}

export interface GeminiStreamingData {
  candidates: Array<{
    content: {
      parts: Array<{
        text?: string;
        functionCall?: {
          name: string;
          args: Record<string, any>;
        };
      }>;
    };
    finishReason: string;
    safetyRatings: Array<{
      category: string;
      probability: string;
    }>;
    index: number;
  }>;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, {
      type: string;
      description: string;
    }>;
    required?: string[];
  };
}

export interface ModerateMessageRequest {
  messageText: string;
  userName?: string;
  userBio?: string;
  hasAvatar?: boolean; // Теперь просто указываем наличие аватарки вместо ее передачи
  suspiciousProfile?: boolean;
  suspicionReason?: string;
  messageId?: number; // Для идентификации сообщения в батче
  chatId?: number; // Для идентификации чата
}

export interface ModerateMessageResponse {
  isSpam: boolean;
  confidence: number;
  reason: string;
  matchesKnownPattern: boolean;
  shouldBan: boolean;
  messageId?: number; // Для привязки к оригинальному сообщению в батче
}

// Батч запросов на модерацию
export interface ModerationBatch {
  messages: ModerateMessageRequest[]; // Сообщения в текущем батче
  timer: NodeJS.Timeout | null; // Таймер для отправки батча
  lastMessageTime: number; // Время последнего сообщения
}

export class GeminiService {
  private apiUrl: string;
  private apiKey: string;
  private model: string;
  private batchMap: Map<number, ModerationBatch> = new Map(); // Мапа для батчинга по chatId
  private batchTimeout: number;
  private maxBatchSize: number;

  constructor(
    config: AppConfig, 
    model = "gemini-2.0-flash", 
    batchTimeout = 3000, 
    maxBatchSize = 10
  ) {
    this.apiUrl = config.geminiApiUrl;
    this.apiKey = config.geminiApiKey;
    this.model = model;
    this.batchTimeout = batchTimeout;
    this.maxBatchSize = maxBatchSize;
    
    console.log(`GeminiService инициализирован с моделью ${model}, таймаутом батча ${batchTimeout}мс, размером батча ${maxBatchSize}`);
  }

  /**
   * Базовый метод для генерации контента с Gemini API
   */
  async generateContent(
    prompt: string,
    options: {
      temperature?: number;
      maxOutputTokens?: number;
      tools?: Array<{ functionDeclarations: FunctionDeclaration[] }>;
    } = {}
  ): Promise<string> {
    try {
      const requestData: GeminiRequestData = {
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: options.temperature || 0.2,
          maxOutputTokens: options.maxOutputTokens || 1024,
        },
      };

      if (options.tools) {
        requestData.tools = options.tools;
      }

      const response = await axios.post(
        `${this.apiUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
        requestData
      );

      // Проверяем наличие функции в ответе
      if (
        response.data.candidates &&
        response.data.candidates[0].content?.parts?.[0]?.functionCall
      ) {
        const functionCall = response.data.candidates[0].content.parts[0].functionCall;
        return JSON.stringify(functionCall);
      }

      // Проверяем наличие текста в ответе
      if (
        response.data.candidates &&
        response.data.candidates[0].content?.parts?.[0]?.text
      ) {
        return response.data.candidates[0].content.parts[0].text;
      }

      throw new Error("Неожиданный формат ответа от Gemini API");
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        console.error("Ошибка API Gemini:", error.response.status, error.response.data);
      } else {
        console.error("Ошибка при обращении к Gemini API:", error);
      }
      throw error;
    }
  }

  /**
   * Генерация с потоковым ответом
   */
  async *generateContentStream(
    prompt: string,
    options: {
      temperature?: number;
      maxOutputTokens?: number;
      tools?: Array<{ functionDeclarations: FunctionDeclaration[] }>;
    } = {}
  ): AsyncGenerator<string, void, unknown> {
    try {
      const requestData: GeminiRequestData = {
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: options.temperature || 0.2,
          maxOutputTokens: options.maxOutputTokens || 1024,
        },
      };

      if (options.tools) {
        requestData.tools = options.tools;
      }

      const response = await axios.post(
        `${this.apiUrl}/models/${this.model}:streamGenerateContent?key=${this.apiKey}`,
        requestData,
        {
          responseType: "stream",
        }
      );

      let buffer = "";
      for await (const chunk of response.data) {
        const chunkStr = chunk.toString();
        buffer += chunkStr;

        // Обрабатываем каждую строку по отдельности
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Последняя строка может быть неполной

        for (const line of lines) {
          if (line.trim() === "") continue;
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
            if (dataStr === "[DONE]") {
              return;
            }

            try {
              const data: GeminiStreamingData = JSON.parse(dataStr);
              if (
                data.candidates &&
                data.candidates[0].content?.parts?.[0]?.text
              ) {
                yield data.candidates[0].content.parts[0].text;
              } else if (
                data.candidates &&
                data.candidates[0].content?.parts?.[0]?.functionCall
              ) {
                yield JSON.stringify(
                  data.candidates[0].content.parts[0].functionCall
                );
              }
            } catch (e) {
              console.error("Ошибка парсинга строки потока:", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Ошибка в потоковой генерации:", error);
      throw error;
    }
  }

  /**
   * Преобразует текстовый ответ модели в структурированный результат модерации
   * Это нужно для обработки случаев, когда модель не возвращает корректный JSON
   */
  private extractModerationFromText(text: string): ModerateMessageResponse {
    try {
      console.log("Извлечение модерации из текста:", text.substring(0, 200) + "...");
      
      // КОММЕНТИРУЕМ автоматическое игнорирование сообщений с матом
      // Все сообщения должны проходить полную проверку
      // const toxicPatterns = [
      //   /мат/i, /оскорблен/i, /токсичн/i, /свобод[а-я]+ слов/i, 
      //   /не является спамом/i, /не спам/i, /легитимн/i
      // ];
      
      // if (toxicPatterns.some(pattern => pattern.test(text))) {
      //   console.log("Текст содержит упоминания о мате/оскорблениях, считаем нормальным сообщением");
      //   return {
      //     isSpam: false,
      //     confidence: 0.9,
      //     reason: "Легитимное сообщение (возможно токсичное, но это разрешено)",
      //     matchesKnownPattern: false,
      //     shouldBan: false
      //   };
      // }
      
      // КОММЕНТИРУЕМ автоматическое игнорирование сообщений с упоминанием $GOVNO и Overbafer1
      // Все сообщения должны проходить полную проверку
      // if (text.toLowerCase().includes("$govno") || 
      //     text.toLowerCase().includes("overbafer1") || 
      //     text.toLowerCase().includes("не является спамом")) {
      //   // Если текст упоминает легитимные темы чата и не содержит явных признаков спама
      //   if (!text.toLowerCase().includes("спам") || 
      //       text.toLowerCase().includes("не спам") ||
      //       text.toLowerCase().includes("не является спамом")) {
      //     return {
      //       isSpam: false,
      //       confidence: 0.9,
      //       reason: "Легитимное обсуждение тем чата ($GOVNO, Overbafer1)",
      //       matchesKnownPattern: false,
      //       shouldBan: false
      //     };
      //   }
      // }
      
      // Попытка найти JSON в ответе (если модель вывела JSON в обычном тексте)
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          const jsonData = JSON.parse(jsonMatch[0]);
          // Проверяем, что JSON содержит нужные поля
          if (jsonData.isSpam !== undefined && jsonData.confidence !== undefined) {
            console.log("Найден JSON в тексте ответа:", jsonData);
            return {
              isSpam: Boolean(jsonData.isSpam),
              confidence: Number(jsonData.confidence),
              reason: jsonData.reason || "Извлечено из JSON в тексте",
              matchesKnownPattern: Boolean(jsonData.matchesKnownPattern),
              shouldBan: Boolean(jsonData.shouldBan)
            };
          }
        } catch (e) {
          console.warn("Найден фрагмент похожий на JSON, но парсинг не удался:", e);
        }
      }
      
      // Если JSON не найден, ищем ключевые слова в тексте
      
      // Определяем, является ли сообщение спамом
      // Сначала ищем явные утверждения о спаме
      let isSpam = false;
      if (/не является спамом|не спам|не рекламa/i.test(text)) {
        isSpam = false;
      } else if (/является спамом|это спам|это реклама/i.test(text)) {
        isSpam = true;
      } else {
        // Иначе проверяем наличие ключевых слов
        isSpam = /спам|реклам|подозрительн|вредоносн/i.test(text);
      }
      
      // Пытаемся найти уверенность в тексте (число от 0 до 1 или проценты)
      let confidence = 0;
      const confidenceMatch = text.match(/уверенность:?\s*([\d.]+)%?/i) || 
                              text.match(/confidence:?\s*([\d.]+)%?/i) ||
                              text.match(/с уверенностью\s*([\d.]+)%?/i);
      if (confidenceMatch) {
        confidence = parseFloat(confidenceMatch[1]);
        // Если число больше 1, то скорее всего это проценты
        if (confidence > 1) confidence = confidence / 100;
      } else {
        // Если не нашли числовое значение, пытаемся найти словесное описание
        if (/высок[а-я]+ уверенност|с высокой уверенностью/i.test(text)) {
          confidence = 0.9;
        } else if (/средн[а-я]+ уверенност/i.test(text)) {
          confidence = 0.7;
        } else if (/низк[а-я]+ уверенност/i.test(text)) {
          confidence = 0.3;
        } else {
          // По умолчанию устанавливаем умеренную уверенность
          confidence = isSpam ? 0.75 : 0.25;
        }
      }
      
      // Пытаемся найти причину
      let reason = "Не удалось извлечь причину из ответа";
      const reasonPatterns = [
        /причина:?\s*([^\n.]+)[.\n]/i,
        /reason:?\s*([^\n.]+)[.\n]/i,
        /потому что\s*([^\n.]+)[.\n]/i,
        /поскольку\s*([^\n.]+)[.\n]/i,
        /так как\s*([^\n.]+)[.\n]/i
      ];
      
      for (const pattern of reasonPatterns) {
        const match = text.match(pattern);
        if (match) {
          reason = match[1].trim();
          break;
        }
      }
      
      if (reason === "Не удалось извлечь причину из ответа" && isSpam) {
        // Если это спам, но причина не найдена, используем часть текста
        const sentences = text.split(/[.!?]+/);
        for (const sentence of sentences) {
          if (sentence.toLowerCase().includes("спам") || 
              sentence.toLowerCase().includes("реклам") ||
              sentence.toLowerCase().includes("подозрит")) {
            reason = sentence.trim();
            break;
          }
        }
      }
      
      // Пытаемся определить, стоит ли банить
      const shouldBan = /следует забанить|нужно забанить|рекоменд[а-я]+ бан|заблокировать пользователя/i.test(text) ||
                        /бан|ban|блокир|заблокир/i.test(text);
      
      // Соответствует ли известному шаблону
      const matchesKnownPattern = /соответств[а-я]+ известн|известн[а-я]+ шаблон|паттерн|pattern/i.test(text) ||
                                  /похож[а-я]+ на шаблон|типичн[а-я]+ шлюхобот|типичн[а-я]+ спам/i.test(text);
      
      console.log(`Извлечено из текста: isSpam=${isSpam}, confidence=${confidence}, shouldBan=${shouldBan}`);
      
      return {
        isSpam,
        confidence: confidence,
        reason,
        matchesKnownPattern: matchesKnownPattern || isSpam,
        shouldBan
      };
    } catch (error) {
      console.error("Ошибка при извлечении информации из текста:", error);
      return {
        isSpam: false,
        confidence: 0,
        reason: "Ошибка обработки ответа модели",
        matchesKnownPattern: false,
        shouldBan: false
      };
    }
  }

  /**
   * Добавляет сообщение в батч и планирует его отправку
   */
  async queueMessageForModeration(
    request: ModerateMessageRequest
  ): Promise<Promise<ModerateMessageResponse>> {
    // Если chatId не указан, используем значение по умолчанию
    const chatId = request.chatId || 0;
    
    return new Promise((resolve, reject) => {
      let batch = this.batchMap.get(chatId);
      
      // Если батча для этого чата еще нет, создаем новый
      if (!batch) {
        batch = {
          messages: [],
          timer: null,
          lastMessageTime: Date.now()
        };
        this.batchMap.set(chatId, batch);
      }
      
      // Добавляем сообщение в батч
      batch.messages.push({
        ...request,
        messageId: request.messageId || batch.messages.length // Если ID не указан, используем индекс
      });
      batch.lastMessageTime = Date.now();
      
      // Обновляем колбэк для текущего сообщения
      const messageIndex = batch.messages.length - 1;
      
      // Функция для обработки результатов модерации для этого конкретного сообщения
      const handleResult = (results: ModerateMessageResponse[]) => {
        if (messageIndex < results.length) {
          resolve(results[messageIndex]);
        } else {
          reject(new Error("Не найден результат модерации для сообщения"));
        }
      };
      
      // Если это первое сообщение в батче, устанавливаем таймер
      if (batch.messages.length === 1) {
        // Очищаем предыдущий таймер, если он был
        if (batch.timer) {
          clearTimeout(batch.timer);
        }
        
        // Устанавливаем новый таймер
        batch.timer = setTimeout(async () => {
          // Обрабатываем и удаляем батч
          const messagesToProcess = [...batch.messages];
          this.batchMap.delete(chatId);
          
          try {
            // Отправляем батч на модерацию
            const results = await this.moderateMessageBatch(messagesToProcess);
            
            // Обрабатываем результаты для всех сообщений в этом батче
            for (let i = 0; i < messagesToProcess.length; i++) {
              handleResult(results);
            }
          } catch (error) {
            reject(error);
          }
        }, this.batchTimeout);
      } else if (batch.messages.length >= this.maxBatchSize) {
        // Если достигли максимального размера батча, отправляем сразу
        if (batch.timer) {
          clearTimeout(batch.timer);
          batch.timer = null;
        }
        
        // Обрабатываем и удаляем батч
        const messagesToProcess = [...batch.messages];
        this.batchMap.delete(chatId);
        
        // Отправляем батч на модерацию асинхронно
        this.moderateMessageBatch(messagesToProcess)
          .then(results => handleResult(results))
          .catch(error => reject(error));
      }
    });
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
      
ВАЖНО: ТЫ ДОЛЖЕН ОТВЕЧАТЬ ТОЛЬКО ЧЕРЕЗ ВЫЗОВ ФУНКЦИИ moderate_messages_batch. НЕ ПИШИ ТЕКСТОВЫЙ ОТВЕТ.
КРИТИЧЕСКИ ВАЖНО: ИСПОЛЬЗУЙ ТОЛЬКО FUNCTION CALLING API, А НЕ ТЕКСТОВЫЙ ОТВЕТ.
ТЫ НЕ МОЖЕШЬ ОТВЕТИТЬ ОБЫЧНЫМ ТЕКСТОМ. ТОЛЬКО ВЫЗОВОМ ФУНКЦИИ.

ИНСТРУКЦИЯ: Проанализируй несколько сообщений и определи, какие из них являются спамом или рекламой. Используй ТОЛЬКО предоставленную функцию moderate_messages_batch для ответа.

ВАЖНЫЙ КОНТЕКСТ: Этот чат посвящен криптовалютному мемкоину $GOVNO на блокчейне TON, созданному популярным YouTube-блогером Overbafer1 (Игорь П.). Упоминания $GOVNO, Overbafer1, TON, а также обсуждение этого мемкоина и его экосистемы НЕ являются спамом, а нормальными темами для обсуждения в данном чате.

КРИТИЧЕСКИ ВАЖНОЕ ПРАВИЛО: УДАЛЯТЬ ТОЛЬКО РЕКЛАМУ И ШЛЮХОБОТОВ. Любой другой контент разрешен, даже если он странный, нерелевантный, токсичный, оскорбительный или неуместный. Нерелевантный и не связанный с тематикой чата контент НЕ является причиной для удаления. Тексты песен, мемы, странные высказывания, случайные фразы, шутки - ВСЕ это разрешено. Наказывать ТОЛЬКО за рекламу и спам.

ВНИМАНИЕ ПО ПРИВЕТСТВЕННЫМ СООБЩЕНИЯМ: Если пользователь просто пишет "привет", "хай", "здарова" или другое короткое приветствие, и при этом в его профиле/био НЕТ ССЫЛОК на каналы, сайты или других пользователей - это НЕ шлюхобот и НЕ спам. Простые приветствия без подозрительных ссылок в био - нормальное общение!

ВАЖНО О БИО ПОЛЬЗОВАТЕЛЕЙ: Тебе предоставляется ПОЛНОЕ и НЕИЗМЕНЕННОЕ био пользователя. Если указано, что в био написано "Слава $GOVNO 💩 Слава overbafer1" или любой другой текст, значит именно это там и написано, без каких-либо скрытых ссылок. НЕ ПРИДУМЫВАЙ наличие ссылок, если они явно не указаны в переданном био!

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
- Тексты песен, даже с неприятным содержанием
- Мемы и цитаты из популярной культуры
- Любые сообщения, не связанные с тематикой чата
- Странные и бессмысленные высказывания
- Неуместный юмор
- Контент 18+, если он не является частью спама

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
- ЛЮБОЙ контент, не являющийся рекламой или спамом

ВАЖНО: Используй ТОЛЬКО предоставленную функцию moderate_messages_batch для ответа. Не пиши текст вне функции.
ПОВТОРЯЮ: ТЫ ДОЛЖЕН ОТВЕЧАТЬ ТОЛЬКО ЧЕРЕЗ ВЫЗОВ ФУНКЦИИ moderate_messages_batch. НИКАКОГО ТЕКСТА ВНЕ ФУНКЦИИ.
ЕСЛИ СООБЩЕНИЕ ЯВЛЯЕТСЯ СПАМОМ - У ПАРАМЕТРА isSpam ДОЛЖНО БЫТЬ ЗНАЧЕНИЕ true И В ПРИЧИНЕ (reason) ДОЛЖНО БЫТЬ УКАЗАНО ПОЧЕМУ ЭТО СПАМ.
ЕСЛИ СООБЩЕНИЕ НЕ ЯВЛЯЕТСЯ СПАМОМ - У ПАРАМЕТРА isSpam ДОЛЖНО БЫТЬ ЗНАЧЕНИЕ false И В ПРИЧИНЕ (reason) ДОЛЖНО БЫТЬ УКАЗАНО ПОЧЕМУ ЭТО НЕ СПАМ.
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

      // Явно указываем, что требуется function calling
      const requestData: GeminiRequestData = {
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
        tools: [moderationTool],
      };

      // Напрямую используем axios для большего контроля над запросом
      const response = await axios.post(
        `${this.apiUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
        requestData
      );

      try {
        // Проверяем, есть ли functionCall в ответе
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.functionCall
        ) {
          const functionCall = response.data.candidates[0].content.parts[0].functionCall;
          if (functionCall.name === "moderate_messages_batch" && functionCall.args?.results) {
            const batchResults = functionCall.args.results;
            
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
        }
        
        // Если functionCall не найден, но есть текстовый ответ
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.text
        ) {
          const textResponse = response.data.candidates[0].content.parts[0].text;
          console.log("Модель вернула текст вместо functionCall:", textResponse.substring(0, 100) + "...");
          
          // Пытаемся извлечь информацию из текста
          return this.extractBatchResultsFromText(textResponse, messages);
        }
        
        throw new Error("Неожиданный формат ответа API");
      } catch (e) {
        console.error("Ошибка при обработке ответа API для батча:", e);
        
        // Если мы получили ответ, но не смогли его обработать, попробуем извлечь информацию из текста
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.text
        ) {
          const textResponse = response.data.candidates[0].content.parts[0].text;
          return this.extractBatchResultsFromText(textResponse, messages);
        }
        
        // Возвращаем безопасные ответы по умолчанию в случае ошибки
        return messages.map((msg, index) => ({
          isSpam: false,
          confidence: 0,
          reason: "Произошла ошибка при обработке батча",
          matchesKnownPattern: false,
          shouldBan: false,
          messageId: msg.messageId || index
        }));
      }
    } catch (error) {
      console.error("Ошибка при модерации батча сообщений:", error);
      
      // Возвращаем безопасные ответы по умолчанию в случае ошибки
      return messages.map((msg, index) => ({
        isSpam: false,
        confidence: 0,
        reason: "Произошла ошибка при обработке батча",
        matchesKnownPattern: false,
        shouldBan: false,
        messageId: msg.messageId || index
      }));
    }
  }

  /**
   * Извлекает результаты модерации из текстового ответа для батча сообщений
   */
  private extractBatchResultsFromText(
    text: string, 
    messages: ModerateMessageRequest[]
  ): ModerateMessageResponse[] {
    try {
      // Если в ответе несколько разделенных сообщений
      if (text.includes("Сообщение 1:") || text.includes("---")) {
        // Разделяем ответ на части по сообщениям
        const messageResponses = text.split(/---|\n\nСообщение \d+:|Сообщение \d+:/);
        
        return messages.map((msg, index) => {
          // Берем соответствующую часть ответа, если она есть
          const responseText = index < messageResponses.length ? 
                            messageResponses[index] : text;
          
          // Извлекаем информацию из текста
          const result = this.extractModerationFromText(responseText);
          
          return {
            ...result,
            messageId: msg.messageId || index
          };
        });
      }
      
      // Если ответ не разделен явно, используем весь текст для всех сообщений
      return messages.map((msg, index) => {
        const result = this.extractModerationFromText(text);
        
        return {
          ...result,
          messageId: msg.messageId || index
        };
      });
    } catch (error) {
      console.error("Ошибка при извлечении результатов из текста:", error);
      
      // Возвращаем безопасные ответы в случае ошибки
      return messages.map((msg, index) => ({
        isSpam: false,
        confidence: 0,
        reason: "Ошибка извлечения результатов из текста",
        matchesKnownPattern: false,
        shouldBan: false,
        messageId: msg.messageId || index
      }));
    }
  }

  /**
   * Модерация сообщения с использованием function calling
   */
  async moderateMessage(
    request: ModerateMessageRequest
  ): Promise<ModerateMessageResponse> {
    try {
      // Формируем промпт для анализа сообщения и пользователя
      let prompt = `Ты - модератор чата, который определяет ТОЛЬКО спам-сообщения и любые рекламные сообщения типа шлюхоботов или продажи или рекламы группы.
    
ВАЖНО: ТЫ ДОЛЖЕН ОТВЕЧАТЬ ТОЛЬКО ЧЕРЕЗ ВЫЗОВ ФУНКЦИИ moderate_message. НЕ ПИШИ ТЕКСТОВЫЙ ОТВЕТ.
КРИТИЧЕСКИ ВАЖНО: ИСПОЛЬЗУЙ ТОЛЬКО FUNCTION CALLING API, А НЕ ТЕКСТОВЫЙ ОТВЕТ.
ТЫ НЕ МОЖЕШЬ ОТВЕТИТЬ ОБЫЧНЫМ ТЕКСТОМ. ТОЛЬКО ВЫЗОВОМ ФУНКЦИИ.

ИНСТРУКЦИЯ: Проанализируй сообщение и определи, является ли оно спамом или рекламой. Используй ТОЛЬКО предоставленную функцию moderate_message для ответа.

ВАЖНЫЙ КОНТЕКСТ: Этот чат посвящен криптовалютному мемкоину $GOVNO на блокчейне TON, созданному популярным YouTube-блогером Overbafer1 (Игорь П.). Упоминания $GOVNO, Overbafer1, TON, а также обсуждение этого мемкоина и его экосистемы НЕ являются спамом, а нормальными темами для обсуждения в данном чате.

КРИТИЧЕСКИ ВАЖНОЕ ПРАВИЛО: УДАЛЯТЬ ТОЛЬКО РЕКЛАМУ И ШЛЮХОБОТОВ. Любой другой контент разрешен, даже если он странный, нерелевантный, токсичный, оскорбительный или неуместный. Нерелевантный и не связанный с тематикой чата контент НЕ является причиной для удаления. Тексты песен, мемы, странные высказывания, случайные фразы, шутки - ВСЕ это разрешено. Наказывать ТОЛЬКО за рекламу и спам. Если происходит полит срач бань. Что такое полит срач? Это когда темы плавно перерастают из криптовалюты только в политику и ругань. Так же любой призыв к педофилии, расправе или убийству с продажей оружия или наркотиков БАН!

ОСОБЕННОСТЬ ЧАТА: Это свободное комьюнити с токсичной культурой. Мат, оскорбления, агрессивные высказывания, угрозы и любой токсичный контент НЕ считаются спамом и должны разрешаться. Модерация должна удалять ТОЛЬКО спам-сообщения и шлюхоботов, но НЕ должна затрагивать свободу слова участников чата.

ВНИМАНИЕ ПО ПРИВЕТСТВЕННЫМ СООБЩЕНИЯМ: Если пользователь просто пишет "привет", "хай", "здарова" или другое короткое приветствие, и при этом в его профиле/био НЕТ ССЫЛОК на каналы, сайты или других пользователей - это НЕ шлюхобот и НЕ спам и НЕ РЕКЛАСА. Простые приветствия без подозрительных ссылок в био - нормальное общение!

ВАЖНО О БИО ПОЛЬЗОВАТЕЛЕЙ: Тебе предоставляется ПОЛНОЕ и НЕИЗМЕНЕННОЕ био пользователя. Если указано, что в био написано "Слава $GOVNO  Слава overbafer1" или любой другой текст, значит именно это там и написано, без каких-либо скрытых ссылок. НЕ ПРИДУМЫВАЙ наличие ссылок, если они явно не указаны в переданном био!

РАСПОЗНАВАНИЕ ИРОНИИ И ШУТОК: Если пользователь в шутку пишет "я шлюхобот", "я спамер" или подобные фразы с очевидным ироничным контекстом - это НЕ спам, а шутка. Обращай внимание на контекст и сравнивай с шаблонами реального спама. Ирония и самоирония распространены в этом чате.

ВАЖНО О МАТЕ И ТОКСИЧНОСТИ: Наличие мата, оскорблений или слова "говно", "$GOVNO", "GOVNO" в сообщении НЕ ЯВЛЯЕТСЯ причиной для его удаления. Спамеры и шлюхоботы могут специально добавлять мат или слово "говно" в свои сообщения для обхода модерации. Проверяй ВСЕ сообщения на признаки спама независимо от наличия в них мата или токсичного контента.

ВАЖНО ОБ УПОМИНАНИИ $GOVNO: Сообщения, содержащие слова "говно", "$GOVNO", "govno", "Overbafer1" или "овербафер", НЕ являются автоматически легитимными и должны проходить такую же тщательную проверку на спам, как и все остальные сообщения. Спамеры могут использовать эти слова для обхода модерации. При этом само упоминание $GOVNO не должно считаться спамом.

РАЗРЕШЕННЫЙ КОНТЕНТ (НЕ УДАЛЯТЬ):
- Абсолютно любые сообщения, НЕ содержащие рекламу или спам
- Любой нерелевантный контент, не связанный с тематикой чата
- Тексты песен, стихи, цитаты, мемы (например, строки из песен Канье Веста)
- Случайные фразы и бессмысленные сообщения
- Любые неуместные высказывания, если они не реклама
- Контент 18+, если это не часть спам-сообщения, кроме расчлененки и порнографии с педофилией.

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

      // Добавляем информацию о типичных шаблонах спама в криптовалютных чатах
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
- Тексты песен, даже с неприятным содержанием (например, строки из песен Канье Веста)
- Мемы и цитаты из популярной культуры
- Любые сообщения, не связанные с тематикой чата
- Странные и бессмысленные высказывания
- Неуместный юмор
- Контент 18+, если он не является частью спама
- Так же долгие и муторные беседы с большим колличеством символов

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
- ЛЮБЫЕ токсичные высказывания, мат, оскорбления 
- ЛЮБОЙ контент, не являющийся рекламой или спамом
- Свобода слова самое важное, любые темы разрешены в разумных пределах

Колличество сообщений на тему политики не более 100 за час.

ВАЖНО: Используй ТОЛЬКО предоставленную функцию moderate_message для ответа. Не пиши текст вне функции.
ПОВТОРЯЮ: ТЫ ДОЛЖЕН ОТВЕЧАТЬ ТОЛЬКО ЧЕРЕЗ ВЫЗОВ ФУНКЦИИ moderate_message. НИКАКОГО ТЕКСТА ВНЕ ФУНКЦИИ.
`;

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

      // Явно указываем, что требуется function calling
      const requestData: GeminiRequestData = {
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: request.suspiciousProfile ? 0.05 : 0.1,
          maxOutputTokens: 1024,
        },
        tools: [moderationTool],
      };

      // Напрямую используем axios для большего контроля над запросом
      const response = await axios.post(
        `${this.apiUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
        requestData
      );

      try {
        // Проверяем, есть ли functionCall в ответе
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.functionCall
        ) {
          const functionCall = response.data.candidates[0].content.parts[0].functionCall;
          if (functionCall.name === "moderate_message" && functionCall.args) {
            return {
              ...functionCall.args as ModerateMessageResponse,
              messageId: request.messageId
            };
          }
        }
        
        // Если functionCall не найден, но есть текстовый ответ
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.text
        ) {
          const textResponse = response.data.candidates[0].content.parts[0].text;
          console.log("Модель вернула текст вместо functionCall:", textResponse.substring(0, 100) + "...");
          
          // Извлекаем информацию из текста
          const result = this.extractModerationFromText(textResponse);
          
          return {
            ...result,
            messageId: request.messageId
          };
        }
        
        throw new Error("Неожиданный формат ответа API");
      } catch (e) {
        console.error("Ошибка при обработке ответа API:", e);
        
        // Если мы получили ответ, но не смогли его обработать, попробуем извлечь информацию из текста
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.text
        ) {
          const textResponse = response.data.candidates[0].content.parts[0].text;
          const result = this.extractModerationFromText(textResponse);
          
          return {
            ...result,
            messageId: request.messageId
          };
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
      }
    } catch (error) {
      console.error("Ошибка при модерации сообщения:", error);
      // Возвращаем безопасный ответ по умолчанию в случае ошибки
      return {
        isSpam: false,
        confidence: 0,
        reason: "Произошла ошибка при обработке",
        matchesKnownPattern: false,
        shouldBan: false,
        messageId: request.messageId
      };
    }
  }

  /**
   * Модерация сообщения с использованием кастомного промпта
   */
  async moderateWithCustomPrompt(
    request: ModerateMessageRequest,
    customPrompt: string
  ): Promise<ModerateMessageResponse> {
    try {
      // Обрабатываем переменные в промпте
      let processedPrompt = this.processPromptVariables(customPrompt, request);
      
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

      // Явно указываем, что требуется function calling
      const requestData: GeminiRequestData = {
        contents: [
          {
            parts: [
              {
                text: processedPrompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: request.suspiciousProfile ? 0.05 : 0.1,
          maxOutputTokens: 1024,
        },
        tools: [moderationTool],
      };

      // Напрямую используем axios для большего контроля над запросом
      const response = await axios.post(
        `${this.apiUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
        requestData
      );

      try {
        // Проверяем, есть ли functionCall в ответе
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.functionCall
        ) {
          const functionCall = response.data.candidates[0].content.parts[0].functionCall;
          if (functionCall.name === "moderate_message" && functionCall.args) {
            return {
              ...functionCall.args as ModerateMessageResponse,
              messageId: request.messageId
            };
          }
        }
        
        // Если functionCall не найден, но есть текстовый ответ
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.text
        ) {
          const textResponse = response.data.candidates[0].content.parts[0].text;
          console.log("Модель вернула текст вместо functionCall:", textResponse.substring(0, 100) + "...");
          
          // Извлекаем информацию из текста
          const result = this.extractModerationFromText(textResponse);
          
          return {
            ...result,
            messageId: request.messageId
          };
        }
        
        throw new Error("Неожиданный формат ответа API");
      } catch (e) {
        console.error("Ошибка при обработке ответа API:", e);
        
        // Если мы получили ответ, но не смогли его обработать, попробуем извлечь информацию из текста
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.text
        ) {
          const textResponse = response.data.candidates[0].content.parts[0].text;
          const result = this.extractModerationFromText(textResponse);
          
          return {
            ...result,
            messageId: request.messageId
          };
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
      }
    } catch (error) {
      console.error("Ошибка при модерации сообщения с кастомным промптом:", error);
      // Возвращаем безопасный ответ по умолчанию в случае ошибки
      return {
        isSpam: false,
        confidence: 0,
        reason: "Произошла ошибка при обработке",
        matchesKnownPattern: false,
        shouldBan: false,
        messageId: request.messageId
      };
    }
  }
  
  /**
   * Модерация пакета сообщений с использованием кастомного промпта
   */
  async moderateWithCustomPromptBatch(
    messages: ModerateMessageRequest[],
    customPrompt: string
  ): Promise<ModerateMessageResponse[]> {
    if (messages.length === 0) {
      return [];
    }
    
    if (messages.length === 1) {
      // Если в батче только одно сообщение, используем обычную модерацию с кастомным промптом
      const result = await this.moderateWithCustomPrompt(messages[0], customPrompt);
      return [result];
    }
    
    try {
      // Обрабатываем переменные в промпте
      let processedPrompt = this.processPromptVariables(customPrompt, null, messages);
      
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

      // Явно указываем, что требуется function calling
      const requestData: GeminiRequestData = {
        contents: [
          {
            parts: [
              {
                text: processedPrompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
        tools: [moderationTool],
      };

      // Напрямую используем axios для большего контроля над запросом
      const response = await axios.post(
        `${this.apiUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
        requestData
      );

      try {
        // Проверяем, есть ли functionCall в ответе
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.functionCall
        ) {
          const functionCall = response.data.candidates[0].content.parts[0].functionCall;
          if (functionCall.name === "moderate_messages_batch" && functionCall.args?.results) {
            const batchResults = functionCall.args.results;
            
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
        }
        
        // Если functionCall не найден, но есть текстовый ответ
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.text
        ) {
          const textResponse = response.data.candidates[0].content.parts[0].text;
          console.log("Модель вернула текст вместо functionCall:", textResponse.substring(0, 100) + "...");
          
          // Пытаемся извлечь информацию из текста
          return this.extractBatchResultsFromText(textResponse, messages);
        }
        
        throw new Error("Неожиданный формат ответа API");
      } catch (e) {
        console.error("Ошибка при обработке ответа API для батча:", e);
        
        // Если мы получили ответ, но не смогли его обработать, попробуем извлечь информацию из текста
        if (
          response.data.candidates &&
          response.data.candidates[0].content?.parts?.[0]?.text
        ) {
          const textResponse = response.data.candidates[0].content.parts[0].text;
          return this.extractBatchResultsFromText(textResponse, messages);
        }
        
        // Возвращаем безопасные ответы по умолчанию в случае ошибки
        return messages.map((msg, index) => ({
          isSpam: false,
          confidence: 0,
          reason: "Произошла ошибка при обработке батча",
          matchesKnownPattern: false,
          shouldBan: false,
          messageId: msg.messageId || index
        }));
      }
    } catch (error) {
      console.error("Ошибка при модерации батча сообщений с кастомным промптом:", error);
      
      // Возвращаем безопасные ответы по умолчанию в случае ошибки
      return messages.map((msg, index) => ({
        isSpam: false,
        confidence: 0,
        reason: "Произошла ошибка при обработке батча",
        matchesKnownPattern: false,
        shouldBan: false,
        messageId: msg.messageId || index
      }));
    }
  }

  /**
   * Обрабатывает переменные в промпте
   * @param prompt Исходный промпт с переменными
   * @param singleMessage Данные одного сообщения (для режима single)
   * @param batchMessages Массив сообщений (для режима batch)
   */
  private processPromptVariables(
    prompt: string,
    singleMessage?: ModerateMessageRequest | null,
    batchMessages?: ModerateMessageRequest[]
  ): string {
    let processedPrompt = prompt;
    
    // Заменяем стандартные переменные
    processedPrompt = processedPrompt.replace(/\${model}/g, this.model);
    processedPrompt = processedPrompt.replace(/\${date}/g, new Date().toISOString());
    
    if (singleMessage) {
      // Заменяем переменные для одного сообщения
      processedPrompt = processedPrompt.replace(/\${messageText}/g, singleMessage.messageText || "");
      processedPrompt = processedPrompt.replace(/\${userName}/g, singleMessage.userName || "");
      processedPrompt = processedPrompt.replace(/\${userBio}/g, singleMessage.userBio || "");
      processedPrompt = processedPrompt.replace(/\${hasAvatar}/g, String(singleMessage.hasAvatar || false));
      processedPrompt = processedPrompt.replace(/\${suspiciousProfile}/g, String(singleMessage.suspiciousProfile || false));
      processedPrompt = processedPrompt.replace(/\${suspicionReason}/g, singleMessage.suspicionReason || "");
      processedPrompt = processedPrompt.replace(/\${messageId}/g, String(singleMessage.messageId || 0));
      processedPrompt = processedPrompt.replace(/\${chatId}/g, String(singleMessage.chatId || 0));
    }
    
    if (batchMessages && batchMessages.length > 0) {
      // Генерируем части промпта для каждого сообщения в батче
      let messagesText = "";
      for (let i = 0; i < batchMessages.length; i++) {
        const msg = batchMessages[i];
        messagesText += `Сообщение ${i + 1}:\n`;
        messagesText += `Текст: "${msg.messageText || ""}"\n`;
        
        if (msg.userName) {
          messagesText += `Имя пользователя: ${msg.userName}\n`;
        }
        
        if (msg.userBio) {
          messagesText += `Био пользователя: ${msg.userBio}\n`;
        }
        
        if (msg.hasAvatar !== undefined) {
          messagesText += `У пользователя ${msg.hasAvatar ? "есть" : "нет"} аватарка\n`;
        }
        
        if (msg.suspiciousProfile) {
          messagesText += `ВНИМАНИЕ: Профиль этого пользователя предварительно помечен как подозрительный. Причина: ${msg.suspicionReason || "подозрительное био с ссылками"}\n`;
        }
        
        // Разделитель между сообщениями
        messagesText += `---\n`;
      }
      
      // Заменяем переменную ${messages} на сгенерированный текст
      processedPrompt = processedPrompt.replace(/\${messages}/g, messagesText);
      
      // Заменяем ${messageCount} на количество сообщений в батче
      processedPrompt = processedPrompt.replace(/\${messageCount}/g, String(batchMessages.length));
    }
    
    return processedPrompt;
  }
} 