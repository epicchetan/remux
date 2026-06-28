class JsonRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = Number.isInteger(code) ? code : -32603;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

function parseJsonRpcFrame(frame) {
  try {
    const message = JSON.parse(Buffer.isBuffer(frame) ? frame.toString('utf8') : String(frame));
    if (!isRecord(message)) {
      return {
        error: new JsonRpcError(-32600, 'Invalid request'),
        id: null,
        message: null,
      };
    }

    return {
      error: null,
      id: jsonRpcIdOrNull(message.id),
      message,
    };
  } catch {
    return {
      error: new JsonRpcError(-32700, 'Parse error'),
      id: null,
      message: null,
    };
  }
}

function isJsonRpcRequest(message) {
  return (
    isRecord(message) &&
    typeof message.method === 'string' &&
    isJsonRpcId(message.id)
  );
}

function isJsonRpcResponse(message) {
  return (
    isRecord(message) &&
    isJsonRpcId(message.id) &&
    typeof message.method !== 'string' &&
    ('result' in message || 'error' in message)
  );
}

function responseMessage(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function errorMessage(id, error) {
  const normalized = toJsonRpcError(error);
  const payload = {
    code: normalized.code,
    message: normalized.message,
  };

  if (normalized.data !== undefined) {
    payload.data = normalized.data;
  }

  return {
    jsonrpc: '2.0',
    id,
    error: payload,
  };
}

function toJsonRpcError(error) {
  if (error instanceof JsonRpcError) {
    return error;
  }

  if (isRecord(error)) {
    return new JsonRpcError(
      typeof error.code === 'number' ? error.code : -32603,
      typeof error.message === 'string' ? error.message : 'Internal error',
      error.data,
    );
  }

  return new JsonRpcError(
    -32603,
    error instanceof Error ? error.message : 'Internal error',
  );
}

function withJsonRpcVersion(message) {
  if (!isRecord(message) || message.jsonrpc === '2.0') {
    return message;
  }

  return {
    jsonrpc: '2.0',
    ...message,
  };
}

function isJsonRpcId(value) {
  return typeof value === 'string' || typeof value === 'number';
}

function jsonRpcIdOrNull(value) {
  return isJsonRpcId(value) ? value : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  JsonRpcError,
  errorMessage,
  isJsonRpcId,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseJsonRpcFrame,
  responseMessage,
  toJsonRpcError,
  withJsonRpcVersion,
};
