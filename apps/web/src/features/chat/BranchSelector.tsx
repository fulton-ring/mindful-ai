import type { ConversationBranch } from '@walden/contracts';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function BranchSelector({
  branches,
  selectedId,
  onSelect,
}: {
  branches: ConversationBranch[];
  selectedId: string;
  onSelect(id: string): void;
}) {
  if (branches.length < 2) return null;
  const selectedIndex = Math.max(
    0,
    branches.findIndex(({ id }) => id === selectedId),
  );
  return (
    <div className="branch-selector" role="group" aria-label="Response paths">
      <button
        type="button"
        className="icon-button"
        aria-label="Previous response path"
        disabled={selectedIndex === 0}
        onClick={() => onSelect(branches[selectedIndex - 1].id)}
      >
        <ChevronLeft size={16} aria-hidden />
      </button>
      <span
        aria-live="polite"
        aria-label={`Response path ${selectedIndex + 1} of ${branches.length}`}
      >
        {selectedIndex + 1} / {branches.length}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Next response path"
        disabled={selectedIndex === branches.length - 1}
        onClick={() => onSelect(branches[selectedIndex + 1].id)}
      >
        <ChevronRight size={16} aria-hidden />
      </button>
    </div>
  );
}
