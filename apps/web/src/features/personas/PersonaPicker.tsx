import type { Persona } from '@walden/contracts';
import { ChevronDown } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../../components/ui/select';
import { PersonaIcon } from './PersonaIcon';

export function effectivePersona(personas: Persona[], value: string) {
  return (
    personas.find((persona) => persona.id === value) ??
    personas.find((persona) => persona.id === 'thinking-partner') ??
    personas[0]
  );
}

export function PersonaPicker({
  personas,
  value,
  onChange,
}: {
  personas: Persona[];
  value: string;
  onChange(id: string): void;
}) {
  const selected = effectivePersona(personas, value);
  if (!selected) return null;
  return (
    <div className="persona-picker">
      <Select value={selected.id} onValueChange={onChange}>
        <SelectTrigger
          className="persona-trigger"
          aria-label="Change persona"
          title="Change persona"
        >
          <PersonaIcon persona={selected} />
          <span>{selected.name}</span>
          <ChevronDown size={14} aria-hidden />
        </SelectTrigger>
        <SelectContent aria-label="Personas">
          {personas.map((persona) => (
            <SelectItem key={persona.id} value={persona.id}>
              <span className="persona-option">
                <PersonaIcon persona={persona} />
                <span>{persona.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
