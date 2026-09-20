import { DEFAULT_PERSONAS, type Persona } from '@walden/contracts';
import {
  BookOpen,
  Compass,
  FlaskConical,
  GraduationCap,
  Lightbulb,
  Pencil,
  Swords,
  UserRound,
} from 'lucide-react';

export const PERSONA_ICONS = {
  compass: { label: 'Compass', component: Compass },
  swords: { label: 'Swords', component: Swords },
  'graduation-cap': { label: 'Graduation cap', component: GraduationCap },
  lightbulb: { label: 'Lightbulb', component: Lightbulb },
  book: { label: 'Book', component: BookOpen },
  flask: { label: 'Flask', component: FlaskConical },
  pencil: { label: 'Pencil', component: Pencil },
  user: { label: 'Person', component: UserRound },
} satisfies Record<NonNullable<Persona['icon']>, { label: string; component: typeof Compass }>;

export function personaIconKey(persona: Pick<Persona, 'id' | 'icon'>) {
  return persona.icon ?? DEFAULT_PERSONAS.find((p) => p.id === persona.id)?.icon ?? 'user';
}
export function PersonaIcon({
  persona,
  size = 15,
}: {
  persona: Pick<Persona, 'id' | 'icon'>;
  size?: number;
}) {
  const key = personaIconKey(persona);
  const Icon = PERSONA_ICONS[key]?.component ?? UserRound;
  return <Icon size={size} aria-hidden data-persona-icon={persona.id} data-icon={key} />;
}
