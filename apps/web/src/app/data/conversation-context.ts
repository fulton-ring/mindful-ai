import type { useConversationComposition } from './use-conversation-composition';

type Composition = ReturnType<typeof useConversationComposition>;
type Parts = [
  Composition['route'],
  Composition['panel'],
  Composition['themeState'],
  Composition['editor'],
  Composition['sidebar'],
  Composition['query'],
  Composition['navigation'],
];

type KeysOf<T> = T extends object ? keyof T : never;
type OverlappingKeys<T extends object[]> = T extends [infer Head, ...infer Rest extends object[]]
  ? (keyof Head & KeysOf<Rest[number]>) | OverlappingKeys<Rest>
  : never;
type Expect<T extends true> = T;
/**
 * The action context flattens the composition parts, so a key defined by two parts would be
 * silently shadowed by whichever is spread last. This fails to compile if any key is shared.
 */
export type ConversationContextPartsAreDisjoint = Expect<
  [OverlappingKeys<Parts>] extends [never] ? true : false
>;

export type ConversationContext = Parts[0] &
  Parts[1] &
  Parts[2] &
  Parts[3] &
  Parts[4] &
  Parts[5] &
  Parts[6] & { identity?: string };

export function conversationContext({
  identity,
  route,
  panel,
  themeState,
  editor,
  sidebar,
  query,
  navigation,
}: Composition): ConversationContext {
  return {
    identity,
    ...route,
    ...panel,
    ...themeState,
    ...editor,
    ...sidebar,
    ...query,
    ...navigation,
  };
}
