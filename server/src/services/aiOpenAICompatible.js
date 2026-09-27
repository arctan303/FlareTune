import { createJsonEventStreamParser } from './aiJsonEventStream.js';

const resolveEndpoint = (baseUrl) => `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

const readAssistantContent = async (response) => {
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI_EMPTY_RESPONSE');
  return content;
};

export async function askDeepSeek(messages, model, apiKey, temperature, signal, env = {}, enableThinking) {
  const key = apiKey || env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('AI_MISSING_KEY');
  const endpoint = resolveEndpoint(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');

  const isJsonSchema = messages.some((message) => (
    typeof message.content === 'string'
    && (message.content.includes('translations') || message.content.toLowerCase().includes('json'))
  ));
  const finalMessages = isJsonSchema
    ? messages.map((message, index) => (
      index === 0 && message.role === 'system' && !message.content.toLowerCase().includes('json')
        ? { ...message, content: `${message.content}\nPlease output in valid json format.` }
        : message
    ))
    : messages;
  const body = {
    model: model || 'deepseek-chat',
    messages: finalMessages,
    temperature: temperature ?? 0.2,
    ...(isJsonSchema ? { response_format: { type: 'json_object' } } : {}),
    ...(enableThinking !== undefined ? { thinking: { type: enableThinking ? 'enabled' : 'disabled' } } : {}),
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`DeepSeek API Error [${response.status}]:`, errText);
    throw new Error(`AI_UPSTREAM_${response.status}: ${errText}`);
  }
  return readAssistantContent(response);
}

export async function askOpenAI(messages, model, apiKey, temperature, signal, env = {}) {
  const key = apiKey || env.OPENAI_API_KEY;
  if (!key) throw new Error('AI_MISSING_KEY');
  const endpoint = resolveEndpoint(env.OPENAI_BASE_URL || 'https://api.openai.com/v1');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages,
      temperature: temperature ?? 0.2,
    }),
    signal,
  });

  if (!response.ok) throw new Error(`AI_UPSTREAM_${response.status}`);
  return readAssistantContent(response);
}

const buildChatMessages = (messages) => messages.map((message) => {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id || `call_${message.name}`,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    };
  }
  if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return {
      role: 'assistant',
      content: message.content || '',
      ...(typeof message.reasoning_content === 'string'
        ? { reasoning_content: message.reasoning_content } : {}),
      tool_calls: message.tool_calls,
    };
  }
  return {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    ...(message.role === 'assistant' && typeof message.reasoning_content === 'string'
      ? { reasoning_content: message.reasoning_content } : {}),
  };
});

const buildChatTools = (tools) => tools.map((tool) => {
  const fn = tool.function;
  return {
    type: 'function',
    function: {
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    },
  };
});

const parseToolCalls = (toolCallsMap) => {
  const functionCalls = Array.from(toolCallsMap.values()).map((toolCall, index) => {
    const rawArguments = toolCall.arguments || '{}';
    let args;
    try { args = JSON.parse(rawArguments); }
    // Preserve malformed provider output so the route's allowlist validator
    // rejects it. Replacing it with {} would execute a default tool action.
    catch { args = rawArguments; }
    return {
      id: toolCall.id || `call_${index}_${crypto.randomUUID()}`,
      name: toolCall.name,
      args,
    };
  });
  const rawToolCalls = Array.from(toolCallsMap.values()).map((toolCall, index) => ({
    id: toolCall.id || `call_${index}_${crypto.randomUUID()}`,
    type: 'function',
    function: { name: toolCall.name, arguments: toolCall.arguments },
  }));
  return { functionCalls, rawToolCalls };
};

export async function chatOpenAICompatible(
  messages,
  tools,
  config,
  env,
  signal,
  onContentDelta,
  onThoughtDelta,
) {
  const isDeepSeek = config.provider === 'deepseek';
  const apiKey = isDeepSeek ? env.DEEPSEEK_API_KEY : env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('AI_MISSING_KEY');

  const defaultBaseUrl = isDeepSeek ? 'https://api.deepseek.com' : 'https://api.openai.com/v1';
  const baseUrl = (isDeepSeek ? env.DEEPSEEK_BASE_URL : env.OPENAI_BASE_URL) || defaultBaseUrl;
  const configuredModel = config.model || (isDeepSeek ? 'deepseek-flash' : 'gpt-4o-mini');
  const payload = {
    model: isDeepSeek && !config.exactModel && ['deepseek-chat', 'deepseek-reasoner'].includes(configuredModel)
      ? 'deepseek-flash' : configuredModel,
    stream: true,
    messages: buildChatMessages(messages),
    temperature: config.temperature ?? 0.7,
  };
  if (isDeepSeek && config.enableThinking !== undefined) {
    payload.thinking = { type: config.enableThinking ? 'enabled' : 'disabled' };
  }
  if (Array.isArray(tools) && tools.length > 0) payload.tools = buildChatTools(tools);

  const response = await fetch(resolveEndpoint(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI_UPSTREAM_${response.status}: ${errText}`);
  }
  if (!response.body) throw new Error('AI_EMPTY_RESPONSE');

  const reader = response.body.getReader();
  const toolCallsMap = new Map();
  let accumulatedText = '';
  let accumulatedThought = '';

  const processChunk = async (raw) => {
    try {
      const parsed = JSON.parse(raw);
      const choice = parsed.choices?.[0];
      const message = choice?.message;
      if (message?.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const index = toolCallsMap.size;
          toolCallsMap.set(index, {
            id: toolCall.id || '',
            name: toolCall.function?.name || '',
            arguments: typeof toolCall.function?.arguments === 'string'
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function?.arguments || {}),
          });
        }
      }
      if (message?.content) {
        accumulatedText += message.content;
        if (onContentDelta) await onContentDelta(message.content);
      }
      const delta = choice?.delta;
      const thoughtDelta = delta?.reasoning_content || delta?.reasoning || message?.reasoning_content;
      if (typeof thoughtDelta === 'string' && thoughtDelta) {
        accumulatedThought += thoughtDelta;
        if (onThoughtDelta) await onThoughtDelta(thoughtDelta);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          const index = Number.isInteger(toolCall.index) ? toolCall.index : toolCallsMap.size;
          const current = toolCallsMap.get(index) || { id: '', name: '', arguments: '' };
          if (toolCall.id) current.id += toolCall.id;
          if (toolCall.function?.name) current.name += toolCall.function.name;
          if (toolCall.function?.arguments) current.arguments += toolCall.function.arguments;
          toolCallsMap.set(index, current);
        }
      }
      if (typeof delta?.content === 'string' && delta.content) {
        accumulatedText += delta.content;
        if (onContentDelta) await onContentDelta(delta.content);
      }
    } catch {}
  };
  const streamParser = createJsonEventStreamParser(processChunk);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await streamParser.push(value);
    }
    await streamParser.flushJsonTail();
  } finally {
    reader.releaseLock();
  }

  if (toolCallsMap.size > 0) {
    const { functionCalls, rawToolCalls } = parseToolCalls(toolCallsMap);
    return {
      type: 'function_calls',
      functionCalls,
      content: accumulatedText,
      reasoningContent: accumulatedThought,
      rawMessage: { role: 'assistant', content: accumulatedText || '',
        ...(accumulatedThought ? { reasoning_content: accumulatedThought } : {}),
        tool_calls: rawToolCalls },
    };
  }
  return {
    type: 'content',
    content: accumulatedText,
    rawMessage: { role: 'assistant', content: accumulatedText },
  };
}
