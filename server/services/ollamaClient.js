const crypto = require('crypto');
const axios = require('axios');
const config = require('../config/aiConfig');

/**
 * One place for how File Box asks the model to generate, by task. Callers name a task;
 * they don't pick temperatures. Every task uses the fixed seed and the explicit context window,
 * so the same request with the same files gives the same answer or plan.
 *
 *   temperature 0 for every task. A fixed seed alone did not make temperature 0.1 repeatable
 *   (long summaries drifted between identical runs), and the product goal is the same answer
 *   for the same request and files. Raise a prose task to at most 0.1 only with that tradeoff in mind.
 *   maxOutput       - reply budget in tokens; reserved before the prompt budget is computed
 *   timeoutMs       - interactive steps give up sooner, so chat can fall back instead of hanging
 */
const TASK_PROFILES = {
  classify: { temperature: 0, maxOutput: 600, timeoutMs: 90000 },
  // Understanding replies are ~60 tokens; a low cap stops runaway JSON whitespace from taking minutes.
  plan: { temperature: 0, maxOutput: 200, timeoutMs: 60000 },
  action: { temperature: 0, maxOutput: 400 },
  // Reading a file (profiles, key points) can take minutes on a busy laptop.
  extract: { temperature: 0, maxOutput: 900, timeoutMs: 300000 },
  organize: { temperature: 0, maxOutput: 1500 },
  rename: { temperature: 0, maxOutput: 200 },
  ocr: { temperature: 0, maxOutput: 2048 },
  summarize: { temperature: 0, maxOutput: 900 },
  answer: { temperature: 0, maxOutput: 1000 },
  describe: { temperature: 0, maxOutput: 400 },
};

// Conservative estimate (English averages ~4 characters per token for Llama 3).
const CHARS_PER_TOKEN = 3.2;
const SAFETY_TOKENS = 256;
const CONTEXT_SLOT = '{{CONTEXT}}';
const estimateTokens = (text = '') => Math.ceil(String(text).length / CHARS_PER_TOKEN);

/**
 * Same request, same files -> same answer. Temperature 0 with a fixed seed is repeatable on its own,
 * but other requests sharing the local Ollama (other apps, a different context size) can still make
 * long outputs drift. Exact repeats are answered from this small in-memory cache. Any change to the
 * request, the file text, the model or the settings is a different key.
 */
const RESPONSE_CACHE_LIMIT = 300;
const RESPONSE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const responseCache = new Map(); // key -> { value, at }

// When interactive work (chat, organize, file actions) last used the model; background work waits for quiet.
let lastForegroundAt = 0;
// Background requests in flight. Ollama answers one request at a time, so a question from the user
// cancels them instead of waiting behind them; the background job tries again later.
const backgroundRequests = new Set();
const yieldToForeground = () => {
  backgroundRequests.forEach(controller => controller.abort());
  backgroundRequests.clear();
};

const cacheKey = (payload) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
function cacheGet(key) {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RESPONSE_CACHE_TTL_MS) { responseCache.delete(key); return null; }
  responseCache.delete(key); // refresh recency
  responseCache.set(key, hit);
  return hit.value;
}
function cacheSet(key, value) {
  responseCache.set(key, { value, at: Date.now() });
  while (responseCache.size > RESPONSE_CACHE_LIMIT) responseCache.delete(responseCache.keys().next().value);
}

class PromptTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.status = 413;
    this.code = 'PROMPT_TOO_LARGE';
  }
}

/**
 * Fit a prompt into the context window. `system` (rules) and `content` (the request and its
 * instructions) are never trimmed. `context` (file text, retrieved passages) is trimmed first;
 * if the fixed parts alone don't fit, the request is refused instead of silently dropping rules.
 */
function fitPrompt({ system = '', content = '', context = '', contextWindow, maxOutput }) {
  const budget = contextWindow - maxOutput - SAFETY_TOKENS;
  const fixedTokens = estimateTokens(system) + estimateTokens(content);
  if (fixedTokens > budget) {
    throw new PromptTooLargeError('This request is too large for File Box AI to read at once. Try a shorter question or a smaller selection.');
  }
  const contextText = Array.isArray(context) ? context.filter(Boolean).join('\n\n') : String(context || '');
  // A prompt may mark where the context belongs with {{CONTEXT}}; otherwise it goes after the request.
  const place = (text) => (content.includes(CONTEXT_SLOT) ? content.replace(CONTEXT_SLOT, text) : `${content}\n\n${text}`.trim());
  if (!contextText) return { user: place(''), trimmed: false };

  const marker = '\n...[trimmed to fit File Box AI\'s reading limit]';
  const room = Math.floor((budget - fixedTokens) * CHARS_PER_TOKEN) - marker.length;
  const trimmed = contextText.length > room;
  const fitted = trimmed ? `${contextText.slice(0, Math.max(0, room))}${marker}` : contextText;
  return { user: place(fitted), trimmed };
}

class OllamaClient {
  getBaseUrl() {
    const baseUrl = (config.ollama.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    return baseUrl.endsWith('/api') ? baseUrl : `${baseUrl}/api`;
  }

  getHttpClient(timeout = config.ollama.timeoutMs) {
    return axios.create({
      baseURL: this.getBaseUrl(),
      timeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  isEnabled() {
    return config.ollama.enabled;
  }

  normalizeError(error) {
    if (error?.response?.data?.error) {
      return error.response.data.error;
    }
    if (error?.response?.data?.message) {
      return error.response.data.message;
    }
    if (error?.code === 'ECONNREFUSED') {
      return 'Could not connect to a running Ollama instance.';
    }
    return error?.message || 'Unknown Ollama error';
  }

  isModelAvailable(installedModels, modelName) {
    if (!modelName) {
      return false;
    }

    return installedModels.some((installed) => {
      if (installed === modelName) {
        return true;
      }

      const installedBase = installed.split(':')[0];
      const requestedBase = modelName.split(':')[0];

      return installedBase === requestedBase;
    });
  }

  async health() {
    const defaultResult = {
      enabled: this.isEnabled(),
      reachable: false,
      available: false,
      version: '',
      models: [],
      ocrModel: config.ollama.ocrModel,
      summaryModel: config.ollama.summaryModel,
      assistantModel: config.ollama.assistantModel,
      plannerModel: config.ollama.plannerModel,
      visionModel: config.ollama.visionModel,
      embeddingModel: config.ollama.embeddingModel,
      visionModelAvailable: false,
      embeddingModelAvailable: false,
      ocrModelAvailable: false,
      summaryModelAvailable: false,
      assistantModelAvailable: false,
      plannerModelAvailable: false,
      error: '',
    };

    if (!this.isEnabled()) {
      return {
        ...defaultResult,
        error: 'Ollama is disabled.',
      };
    }

    try {
      // Status checks must answer quickly so an unresponsive Ollama never stalls the UI.
      const client = this.getHttpClient(3000);
      const [versionResponse, tagsResponse] = await Promise.all([
        client.get('/version'),
        client.get('/tags'),
      ]);

      const installedModels = (tagsResponse.data?.models || []).map((model) => model.name);

      return {
        ...defaultResult,
        reachable: true,
        available: true,
        version: versionResponse.data?.version || '',
        models: installedModels,
        ocrModelAvailable: this.isModelAvailable(installedModels, config.ollama.ocrModel),
        summaryModelAvailable: this.isModelAvailable(installedModels, config.ollama.summaryModel),
        assistantModelAvailable: this.isModelAvailable(installedModels, config.ollama.assistantModel),
        plannerModelAvailable: this.isModelAvailable(installedModels, config.ollama.plannerModel),
        visionModelAvailable: this.isModelAvailable(installedModels, config.ollama.visionModel),
        embeddingModelAvailable: this.isModelAvailable(installedModels, config.ollama.embeddingModel),
      };
    } catch (error) {
      return {
        ...defaultResult,
        error: this.normalizeError(error),
      };
    }
  }

  /**
   * Generate with a task profile. `context` is optional trimmable material (file text, passages).
   * Returns { text, trimmed } so callers can tell the user when only part of a file was read.
   */
  /**
   * examples: [{ user, assistant }] shown to the model as earlier turns (small models follow these better).
   * onToken: called with each piece of the reply as it is written (the reply still resolves in full).
   */
  async generate({ background = false, task = 'answer', model, system, content, context, images, format, examples = [], onToken, keepAlive = '5m' }) {
    if (!this.isEnabled()) {
      throw new Error('Ollama is disabled.');
    }
    const profile = TASK_PROFILES[task];
    if (!profile) throw new Error(`Unknown File Box AI task "${task}".`);

    const contextWindow = config.ollama.contextWindow;
    const { user, trimmed } = fitPrompt({ system, content, context, contextWindow, maxOutput: profile.maxOutput });
    if (trimmed) console.log(`[Ollama] ${task}: context trimmed to fit ${contextWindow} tokens`);

    if (!background) {
      lastForegroundAt = Date.now();
      yieldToForeground();
    }
    const client = this.getHttpClient(profile.timeoutMs);
    const payload = {
      model,
      stream: false,
      keep_alive: keepAlive,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...examples.flatMap(example => [{ role: 'user', content: example.user }, { role: 'assistant', content: example.assistant }]),
        {
          role: 'user',
          content: user,
          ...(images && images.length > 0 ? { images } : {}),
        },
      ],
      options: {
        temperature: profile.temperature,
        seed: config.ollama.seed,
        num_ctx: contextWindow,
        num_predict: profile.maxOutput,
      },
    };

    if (format) {
      payload.format = format;
    }

    // Images are not cached (large, and descriptions/OCR are already deterministic at temperature 0).
    const key = images && images.length ? null : cacheKey({ task, ...payload, keep_alive: undefined });
    const cached = key && cacheGet(key);
    if (cached) {
      if (onToken) onToken(cached.text);
      return { ...cached, cached: true };
    }

    const controller = new AbortController();
    if (background) backgroundRequests.add(controller);
    try {
      let text = onToken
        ? await this.streamChat(client, { ...payload, stream: true }, onToken, controller.signal)
        : (await client.post('/chat', payload, { signal: controller.signal })).data?.message?.content || '';
      // Ollama occasionally returns an empty reply (for example right after loading a model): ask once more.
      if (!text.trim() && !onToken) {
        text = (await client.post('/chat', payload, { signal: controller.signal })).data?.message?.content || '';
      }
      if (key && text.trim()) cacheSet(key, { text, trimmed });
      return { text, trimmed };
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error('Paused for a request from the user.'), { code: 'YIELDED' });
      throw new Error(this.normalizeError(error));
    } finally {
      backgroundRequests.delete(controller);
    }
  }

  /** Read Ollama's streamed reply (one JSON object per line), passing each piece to onToken. */
  async streamChat(client, payload, onToken, signal) {
    const response = await client.post('/chat', payload, { responseType: 'stream', signal });
    let text = '';
    let buffer = '';
    for await (const chunk of response.data) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const part = JSON.parse(line);
        if (part.error) throw new Error(part.error);
        const piece = part.message?.content || '';
        if (piece) {
          text += piece;
          onToken(piece);
        }
      }
    }
    return text;
  }

  // Reply text only.
  async chat(args) {
    return (await this.generate(args)).text;
  }

  async chatText(args) {
    return this.chat(args);
  }

  async chatImage(args) {
    return this.chat({ task: 'describe', ...args });
  }
}

module.exports = new OllamaClient();
module.exports.TASK_PROFILES = TASK_PROFILES;
module.exports.fitPrompt = fitPrompt;
module.exports.estimateTokens = estimateTokens;
module.exports.clearResponseCache = () => responseCache.clear();

/**
 * Embed texts with the local embedding model. Returns one vector per text (same order).
 * Embeddings are deterministic, so they need no seed or cache.
 */
module.exports.embed = async (texts, { background = false } = {}) => {
  if (!texts.length) return [];
  if (!background) lastForegroundAt = Date.now();
  const client = module.exports.getHttpClient(60000);
  const vectors = [];
  for (let i = 0; i < texts.length; i += 32) {
    const response = await client.post('/embed', { model: config.ollama.embeddingModel, input: texts.slice(i, i + 32) });
    vectors.push(...(response.data?.embeddings || []));
  }
  if (vectors.length !== texts.length) throw new Error('The embedding model returned an unexpected result.');
  return vectors;
};
module.exports.lastForegroundAt = () => lastForegroundAt;
