import { createJsonEventStreamParser } from './aiJsonEventStream.js';

export const AI_STREAM_IDLE_TIMEOUT_MS = 12_000;

export function isTerminalGeminiFinishReason(value) {
  const reason = String(value || '').trim().toUpperCase();
  return Boolean(reason && reason !== 'FINISH_REASON_UNSPECIFIED');
}

export function createAiStreamIdleTimeoutError() {
  const error = new Error('AI_STREAM_IDLE_TIMEOUT');
  error.code = 'AI_STREAM_IDLE_TIMEOUT';
  return error;
}

export async function readStreamChunkWithIdleTimeout(reader, timeoutMs = AI_STREAM_IDLE_TIMEOUT_MS) {
  const delay = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : AI_STREAM_IDLE_TIMEOUT_MS;
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createAiStreamIdleTimeoutError()), delay);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      contents.push({
        role: 'model',
        parts: message.tool_calls.map((toolCall) => {
          const fn = toolCall.function;
          let args = fn.arguments || {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args || '{}'); } catch { args = {}; }
          }
          return {
            functionCall: {
              ...(toolCall.id ? { id: toolCall.id } : {}),
              name: fn.name,
              args,
            },
            ...(toolCall.thought_signature ? { thoughtSignature: toolCall.thought_signature } : {}),
          };
        }),
      });
      continue;
    }
    if (message.role === 'tool') {
      let response = message.content;
      if (typeof response === 'string') {
        try { response = JSON.parse(response); } catch { response = { result: response }; }
      }
      const part = {
        functionResponse: {
          ...(message.tool_call_id ? { id: message.tool_call_id } : {}),
          name: message.name,
          response: response && typeof response === 'object' ? response : { result: response },
        },
      };
      const previous = contents[contents.length - 1];
      if (previous?.role === 'user' && previous.parts.every((item) => item.functionResponse)) {
        previous.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }],
    });
  }
  return contents;
}

export function parseGeminiCandidateParts(parts = [], fallbackScope = crypto.randomUUID()) {
  const functionCalls = [];
  let textContent = '';
  for (const part of parts) {
    if (part.functionCall) {
      functionCalls.push({
        id: part.functionCall.id || `call_gemini_${fallbackScope}_${functionCalls.length}_${part.functionCall.name}`,
        name: part.functionCall.name,
        args: part.functionCall.args || {},
        thoughtSignature: part.thoughtSignature,
      });
    } else if (part.text) {
      textContent += part.text;
    }
  }
  return functionCalls.length > 0
    ? { type: 'function_calls', functionCalls }
    : { type: 'content', content: textContent };
}

export async function askGemini(messages, model, apiKey, temperature, signal) {
  if (!apiKey) throw new Error('AI_MISSING_KEY');
  const systemMessage = messages.find(({ role }) => role === 'system');
  const contents = messages
    .filter(({ role }) => role !== 'system')
    .map(({ role, content }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof content === 'string' ? content : JSON.stringify(content) }],
    }));
  const isJsonSchema = messages.some((message) => (
    typeof message.content === 'string' && (message.content.includes('unitId')
      || message.content.includes('songLanguage') || message.content.includes('discardLineIndices'))
  ));
  const requestedFields = messages.filter(({ role }) => role === 'system')
    .map(({ content }) => String(content || '')).join('\n');
  const payload = {
    contents,
    generationConfig: { temperature: temperature ?? 0.2 },
  };
  if (isJsonSchema) {
    payload.generationConfig.responseMimeType = 'application/json';
    payload.generationConfig.responseSchema = {
      type: 'OBJECT',
      properties: {
        notNeeded: { type: 'BOOLEAN' },
        ...(requestedFields.includes('songLanguage') ? { songLanguage: { type: 'STRING' } } : {}),
        ...(requestedFields.includes('discardLineIndices')
          ? { discardLineIndices: { type: 'ARRAY', items: { type: 'INTEGER' } } } : {}),
        translations: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              unitId: { type: 'INTEGER' },
              text: { type: 'STRING' },
            },
            required: ['unitId', 'text'],
          },
        },
      },
    };
  }
  if (systemMessage) payload.systemInstruction = { parts: [{ text: systemMessage.content }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) throw new Error(`AI_UPSTREAM_${response.status}`);
  const data = await response.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI_EMPTY_RESPONSE');
  return content;
}

export async function chatGemini(
  messages,
  tools,
  config,
  env,
  signal,
  onContentDelta,
  onStreamEvent,
  streamIdleTimeoutMs = AI_STREAM_IDLE_TIMEOUT_MS,
  onThoughtDelta,
) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('AI_MISSING_KEY');

  const systemContent = messages
    .filter(({ role }) => role === 'system')
    .map(({ content }) => content)
    .filter((content) => typeof content === 'string' && content.trim())
    .join('\n\n');
  const payload = {
    contents: buildGeminiContents(messages),
    generationConfig: { temperature: config.temperature ?? 0.7 },
  };
  if (config.enableThinking === false) payload.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (systemContent) payload.systemInstruction = { parts: [{ text: systemContent }] };
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = [{
      functionDeclarations: tools.map((tool) => {
        const fn = tool.function;
        return {
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
        };
      }),
    }];
  }

  const model = config.model || 'gemini-3.1-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) throw new Error('AI_TIMEOUT');
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (response.ok) break;

    const errText = await response.text();
    if ((response.status === 503 || response.status === 429) && attempt === 0 && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }
    throw new Error(`AI_UPSTREAM_${response.status}: ${errText}`);
  }
  if (!response?.body) throw new Error('AI_EMPTY_RESPONSE');

  const reader = response.body.getReader();
  const candidateParts = [];
  let accumulatedText = '';
  let firstChunkSeen = false;
  let terminalFinishReason = '';
  let streamReachedEof = false;

  const processChunk = async (raw) => {
    try {
      const parsed = JSON.parse(raw);
      const candidate = parsed.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        candidateParts.push(part);
        if (part.thought && part.text) {
          if (onThoughtDelta) await onThoughtDelta(part.text);
        } else if (part.text && !part.thought) {
          accumulatedText += part.text;
          if (onContentDelta) await onContentDelta(part.text);
        }
      }
      const finishReason = String(candidate?.finishReason || '').trim();
      if (!terminalFinishReason && isTerminalGeminiFinishReason(finishReason)) {
        terminalFinishReason = finishReason;
        onStreamEvent?.({ type: 'finish_reason', finishReason });
      }
    } catch {}
  };
  const streamParser = createJsonEventStreamParser(processChunk);

  try {
    while (!terminalFinishReason) {
      let readResult;
      try {
        readResult = await readStreamChunkWithIdleTimeout(reader, streamIdleTimeoutMs);
      } catch (error) {
        if (String(error?.message || '').includes('AI_STREAM_IDLE_TIMEOUT')) {
          onStreamEvent?.({ type: 'idle_timeout' });
        }
        throw error;
      }
      const { done, value } = readResult;
      if (done) {
        streamReachedEof = true;
        onStreamEvent?.({ type: 'eof' });
        break;
      }
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        onStreamEvent?.({ type: 'first_chunk' });
      }
      await streamParser.push(value);
    }
    await streamParser.flushJsonTail();
  } finally {
    if (terminalFinishReason || !streamReachedEof) {
      try {
        await reader.cancel(
          terminalFinishReason
            ? `Gemini stream finished: ${terminalFinishReason}`
            : 'Gemini stream cancelled before EOF',
        );
      } catch {}
    }
    reader.releaseLock();
  }

  const parsedParts = parseGeminiCandidateParts(candidateParts);
  return {
    ...parsedParts,
    content: accumulatedText || parsedParts.content || '',
    rawMessage: { role: 'model', parts: candidateParts },
  };
}
