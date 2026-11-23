'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class ProviderError extends AppError {
  constructor(provider, message, status = 502, details) {
    super(status, 'PROVIDER_ERROR', message, { provider, ...details });
    this.provider = provider;
  }
}

module.exports = { AppError, ProviderError };
