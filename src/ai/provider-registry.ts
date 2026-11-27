// Provider and model registry (AI-02 multi-provider).
//   - Providers: every known provider type is registered with a descriptor. Implemented ones have
//     an adapter; planned ones are listed for Settings but are never selectable or callable.
//   - Models: never assumed. Each implemented provider's models come from the provider itself
//     (Gemini model list, EliteStream AI service catalogue) and are kept per provider with their
//     declared capabilities, formats and limits. A model id is validated against this list before a
//     request is sent; an unknown id gives 'model-not-found' without a request.
//   - Model lists are held in memory for the session (refreshed on demand, at most hourly).
import type { AiCapability, AiModelInfo, AiProviderAdapter, AiProviderDescriptor } from './types.ts';

/**
 * Planned providers: registered, shown as "Planned", never selectable. Their capabilities are what
 * the provider type is expected to offer once implemented (to be verified then), not a claim about
 * any model. For distribution they are meant to be reached through the EliteStream AI service.
 */
export const PLANNED_PROVIDERS: AiProviderDescriptor[] = [
  { id: 'openai', name: 'OpenAI', dataGroup: 'openai', auth: 'api-key', status: 'planned', capabilities: ['text.generate', 'text.json', 'audio.transcribe', 'speech.synthesize'], distributionSafe: false, noteKey: 'ai.prov.note.planned' },
  { id: 'anthropic', name: 'Anthropic Claude', dataGroup: 'anthropic', auth: 'api-key', status: 'planned', capabilities: ['text.generate', 'text.json'], distributionSafe: false, noteKey: 'ai.prov.note.planned' },
  { id: 'azure', name: 'Azure AI', dataGroup: 'microsoft', auth: 'api-key', status: 'planned', capabilities: ['text.generate', 'audio.transcribe', 'audio.transcribe.stream', 'speech.synthesize'], distributionSafe: false, noteKey: 'ai.prov.note.planned' },
  { id: 'elevenlabs', name: 'ElevenLabs', dataGroup: 'elevenlabs', auth: 'api-key', status: 'planned', capabilities: ['audio.transcribe', 'audio.transcribe.stream', 'speech.synthesize'], distributionSafe: false, noteKey: 'ai.prov.note.planned' },
  { id: 'openai-compatible', name: 'OpenAI-compatible API', dataGroup: 'custom', auth: 'api-key', status: 'planned', capabilities: ['text.generate'], distributionSafe: false, noteKey: 'ai.prov.note.planned' },
  { id: 'self-hosted', name: 'Self-hosted model', dataGroup: 'self-hosted', auth: 'none', status: 'planned', capabilities: ['text.generate', 'audio.transcribe'], distributionSafe: false, noteKey: 'ai.prov.note.planned' }
];

export interface ProviderRegistry {
  /** All providers, implemented first, then planned. */
  descriptors(): AiProviderDescriptor[];
  descriptor(id: string): AiProviderDescriptor | null;
  /** Adapter of an implemented provider (null for planned / unknown ids). */
  adapter(id: string): AiProviderAdapter | null;
  /** Models known for a provider (from its last successful listing), or null when never listed. */
  models(provider: string): AiModelInfo[] | null;
  setModels(provider: string, models: AiModelInfo[], at: number): void;
  /** When the provider's models were last listed (0 = never). */
  listedAt(provider: string): number;
  /** The listed model, or null when unknown (never sent). */
  model(provider: string, id: string): AiModelInfo | null;
  /** Listed models of a provider that declare the capability (and text.json when json). */
  modelsFor(provider: string, capability: AiCapability, json: boolean): AiModelInfo[];
  clearModels(): void;
}

export function createProviderRegistry(adapters: AiProviderAdapter[], planned?: AiProviderDescriptor[]): ProviderRegistry {
  const byId: Record<string, AiProviderAdapter> = {};
  const order: AiProviderDescriptor[] = [];
  for (let i = 0; i < adapters.length; i++) {
    const d = adapters[i].descriptor;
    if (byId[d.id]) { throw new Error('duplicate AI provider ' + d.id); }
    if (d.status !== 'implemented') { throw new Error('adapter for a provider that is not implemented: ' + d.id); }
    byId[d.id] = adapters[i];
    order.push(d);
  }
  const plannedList = planned || PLANNED_PROVIDERS;
  for (let i = 0; i < plannedList.length; i++) {
    if (byId[plannedList[i].id]) { continue; }
    order.push(plannedList[i]);
  }
  let models: Record<string, { at: number; list: AiModelInfo[] }> = {};

  function covers(m: AiModelInfo, capability: AiCapability, json: boolean): boolean {
    return m.available && m.capabilities.indexOf(capability) >= 0 && (!json || m.capabilities.indexOf('text.json') >= 0);
  }

  return {
    descriptors: function () { return order.slice(); },
    descriptor: function (id: string) {
      for (let i = 0; i < order.length; i++) { if (order[i].id === id) { return order[i]; } }
      return null;
    },
    adapter: function (id: string) { return Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null; },
    models: function (provider: string) { return models[provider] ? models[provider].list.slice() : null; },
    setModels: function (provider: string, list: AiModelInfo[], at: number) {
      const own: AiModelInfo[] = [];
      for (let i = 0; i < list.length; i++) { if (list[i].provider === provider) { own.push(list[i]); } }
      models[provider] = { at: at, list: own };
    },
    listedAt: function (provider: string) { return models[provider] ? models[provider].at : 0; },
    model: function (provider: string, id: string) {
      const e = models[provider];
      if (!e) { return null; }
      for (let i = 0; i < e.list.length; i++) { if (e.list[i].id === id) { return e.list[i]; } }
      return null;
    },
    modelsFor: function (provider: string, capability: AiCapability, json: boolean) {
      const e = models[provider];
      const out: AiModelInfo[] = [];
      if (!e) { return out; }
      for (let i = 0; i < e.list.length; i++) { if (covers(e.list[i], capability, json)) { out.push(e.list[i]); } }
      return out;
    },
    clearModels: function () { models = {}; }
  };
}
