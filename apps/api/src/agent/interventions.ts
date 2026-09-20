import type { Annotation, Intervention } from '@walden/contracts';

export class TurnProposals {
  #intervention?: Intervention;
  #annotations: Annotation[] = [];

  propose(intervention: Intervention): { accepted: boolean; reason?: string } {
    if (this.#intervention)
      return { accepted: false, reason: 'One intervention is already pending for this turn.' };
    this.#intervention = intervention;
    return { accepted: true };
  }

  annotate(annotation: Annotation, sourceText: string): { accepted: boolean; reason?: string } {
    if (!annotation.quote || !sourceText.includes(annotation.quote))
      return { accepted: false, reason: 'Annotation quote must match source text exactly.' };
    this.#annotations.push(annotation);
    return { accepted: true };
  }

  drain(): { intervention?: Intervention; annotations: Annotation[] } {
    return { intervention: this.#intervention, annotations: [...this.#annotations] };
  }
}

export function stableId(prefix: string, ...parts: string[]): string {
  let hash = 2166136261;
  for (const char of parts.join('\u001f')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${prefix}_${(hash >>> 0).toString(36)}`;
}
