import type { Persona } from '@walden/contracts';
import { ChevronDown, Compass, Search, UserRound } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../../components/ui/select';

export function effectivePersona(personas: Persona[], value: string) {
  return (
    personas.find((persona) => persona.id === value) ??
    personas.find((persona) => persona.id === 'thinking-partner') ??
    personas[0]
  );
}

function PersonaIcon({ id }: { id: string }) {
  const props = { size: 15, 'aria-hidden': true, 'data-persona-icon': id } as const;
  if (id === 'thinking-partner') return <Compass {...props} />;
  if (id === 'critical-reader') return <Search {...props} />;
  return <UserRound {...props} />;
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
          <PersonaIcon id={selected.id} />
          <span>{selected.name}</span>
          <ChevronDown size={14} aria-hidden />
        </SelectTrigger>
        <SelectContent aria-label="Personas">
          {personas.map((persona) => (
            <SelectItem key={persona.id} value={persona.id}>
              <span className="persona-option">
                <PersonaIcon id={persona.id} />
                <span>{persona.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
