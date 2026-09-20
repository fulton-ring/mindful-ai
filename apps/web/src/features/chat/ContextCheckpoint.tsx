import { Checkpoint, CheckpointIcon } from '../../components/ai-elements/checkpoint';

export function ContextCheckpoint() {
  return (
    <Checkpoint aria-label="Context compacted">
      <CheckpointIcon aria-hidden />
      <span className="shrink-0 px-1 text-xs">Context compacted</span>
    </Checkpoint>
  );
}
