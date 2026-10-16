const axios = require('axios');
const config = require('../config/aiConfig');

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
      };
    } catch (error) {
      return {
        ...defaultResult,
        error: this.normalizeError(error),
      };
    }
  }

  async chat({ model, system, content, images, options = {}, format, keepAlive = '5m' }) {
    if (!this.isEnabled()) {
      throw new Error('Ollama is disabled.');
    }

    const client = this.getHttpClient();
    const payload = {
      model,
      stream: false,
      keep_alive: keepAlive,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        {
          role: 'user',
          content,
          ...(images && images.length > 0 ? { images } : {}),
        },
      ],
      options,
    };

    if (format) {
      payload.format = format;
    }

    try {
      const response = await client.post('/chat', payload);
      return response.data?.message?.content || '';
    } catch (error) {
      throw new Error(this.normalizeError(error));
    }
  }

  async chatText({ model, system, content, options, format, keepAlive }) {
    return this.chat({
      model,
      system,
      content,
      options,
      format,
      keepAlive,
    });
  }

  async chatImage({ model, system, content, images, options, format, keepAlive }) {
    return this.chat({
      model,
      system,
      content,
      images,
      options,
      format,
      keepAlive,
    });
  }
}

module.exports = new OllamaClient();
