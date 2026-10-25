import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import type { LanguageSupport } from '@codemirror/language';
import type { StudioSourceLanguage } from '../../../studio/StudioNodeSource';

/** The bundled language packs; StudioSourceEditor loads this module on first use. */
export function studioSourceLanguage(name: StudioSourceLanguage): LanguageSupport {
  return name === 'javascript' ? javascript() : name === 'json' ? json() : name === 'markdown' ? markdown() : yaml();
}
