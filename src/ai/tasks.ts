// AI tasks (AI-02 multi-provider): what each app feature needs from a model. Routing only offers
// provider/model pairs whose declared capabilities cover the task. `implemented` says whether the
// feature that runs the task exists yet; in AI-02 none does (routing is prepared, not used).
import type { AiCapability, AiTask } from './types.ts';

export interface AiTaskSpec {
  task: AiTask;
  /** i18n key of the task name. */
  labelKey: string;
  /** Capability the route's model must declare. */
  requires: AiCapability;
  /** The task asks for structured JSON output (needs text.json as well). */
  json: boolean;
  /** Feature exists in this build (false for every task in AI-02). */
  implemented: boolean;
  /** Later stage that implements it (AI roadmap). */
  stage: string;
}

export const AI_TASKS: AiTaskSpec[] = [
  { task: 'epg.enrich', labelKey: 'ai.task.epg.enrich', requires: 'text.generate', json: true, implemented: false, stage: 'AI-08' },
  { task: 'epg.summary', labelKey: 'ai.task.epg.summary', requires: 'text.generate', json: false, implemented: false, stage: 'AI-08' },
  { task: 'search', labelKey: 'ai.task.search', requires: 'text.generate', json: true, implemented: false, stage: 'AI-09' },
  { task: 'subtitle.translate', labelKey: 'ai.task.subtitle.translate', requires: 'text.generate', json: true, implemented: false, stage: 'AI-05' },
  { task: 'subtitle.generate', labelKey: 'ai.task.subtitle.generate', requires: 'audio.transcribe', json: false, implemented: false, stage: 'AI-03' },
  { task: 'speech.live', labelKey: 'ai.task.speech.live', requires: 'audio.transcribe.stream', json: false, implemented: false, stage: 'AI-04' },
  { task: 'audio.translate', labelKey: 'ai.task.audio.translate', requires: 'audio.translate', json: false, implemented: false, stage: 'AI-06' },
  { task: 'speech.tts', labelKey: 'ai.task.speech.tts', requires: 'speech.synthesize', json: false, implemented: false, stage: 'AI-07' },
  { task: 'audio.dub', labelKey: 'ai.task.audio.dub', requires: 'speech.synthesize', json: false, implemented: false, stage: 'AI-07' }
];

export function taskSpec(task: AiTask): AiTaskSpec | null {
  for (let i = 0; i < AI_TASKS.length; i++) { if (AI_TASKS[i].task === task) { return AI_TASKS[i]; } }
  return null;
}

export function isTask(x: unknown): x is AiTask {
  return typeof x === 'string' && taskSpec(x as AiTask) !== null;
}

/** True when a model's capabilities cover the task (JSON tasks also need text.json). */
export function modelServes(capabilities: AiCapability[], spec: AiTaskSpec): boolean {
  if (capabilities.indexOf(spec.requires) < 0) { return false; }
  return !spec.json || capabilities.indexOf('text.json') >= 0;
}
