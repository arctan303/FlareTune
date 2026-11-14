// Compatibility labels #assistant / #lyrics-workbench identify export owners;
// the materializer reads their standard records without a new protocol.
export {
  DEFAULT_ASSISTANT_PERSONA,
  DEFAULT_ASSISTANT_RULES,
} from '../../../shared/plugins/.bridges/assistant/server/defaultPrompts.js';
export {
  DEFAULT_LYRIC_TRANSLATION_RULES,
} from '../../../shared/plugins/.bridges/lyrics-workbench/server/defaultPrompts.js';
