import type { WaldenUIMessage } from '@walden/contracts';
import { CircleDashedIcon, XCircleIcon } from 'lucide-react';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '../../components/ai-elements/chain-of-thought';
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from '../../components/ai-elements/sources';
import { type ActivitySource, activityTools, sourcesOf } from './message-parts';

type Parts = WaldenUIMessage['parts'];

function toolLabel(name: string) {
  if (name === 'readWebPage') return 'Read page';
  if (name === 'searchSources') return 'Search sources';
  if (name === 'searchWeb') return 'Search web';
  // Replies saved before workspace tools were renamed still carry the framework prefix.
  const words = name
    .replace(/^mastra_workspace_/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Tool';
}

function safeSource(source: ActivitySource): (ActivitySource & { domain: string }) | null {
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return { ...source, url: url.toString(), domain: url.hostname.replace(/^www\./, '') };
  } catch {
    return null;
  }
}

export function ResponseActivity({
  parts,
  live = false,
  interrupted = false,
}: {
  parts: Parts;
  live?: boolean;
  interrupted?: boolean;
}) {
  const sources = sourcesOf(parts);
  const visibleTools = activityTools(parts, interrupted).filter(
    ({ name }) => name !== 'proposeAsk' && name !== 'proposeLearningCheck',
  );
  if (!visibleTools.length && !sources.length) return null;
  const assigned = new Set(
    visibleTools.flatMap((tool) => tool.sources ?? []).map((source) => source.url),
  );
  const unassigned = sources.filter((source) => !assigned.has(source.url));

  // While the turn is still running this panel is the only progress the reader
  // gets, so it starts open. Collapsed, a multi-second tool call looks like the
  // app has stalled and then answered all at once. Finished turns stay folded
  // away, since by then the answer is what matters.
  return (
    <ChainOfThought className="mt-1" aria-label="Response activity" defaultOpen={live}>
      <ChainOfThoughtHeader>Activity</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {visibleTools.map((tool) => (
          <ChainOfThoughtStep
            key={tool.id}
            // A running step is the only thing on screen during a multi-second
            // tool call, and a static icon there reads as a stall.
            className={tool.state === 'running' ? 'activity-step-running' : ''}
            label={
              <>
                {toolLabel(tool.name)}
                <span className="sr-only">
                  {' '}
                  {tool.state === 'running'
                    ? 'Running'
                    : tool.state === 'error'
                      ? 'Failed'
                      : 'Completed'}
                </span>
              </>
            }
            description={tool.query ? `“${tool.query}”` : tool.summary}
            status={tool.state === 'running' ? 'active' : 'complete'}
            icon={
              tool.state === 'running'
                ? CircleDashedIcon
                : tool.state === 'error'
                  ? XCircleIcon
                  : undefined
            }
          >
            {tool.query && tool.state === 'error' && <p>{tool.summary}</p>}
            {tool.sources && <SearchResultLinks sources={tool.sources} />}
          </ChainOfThoughtStep>
        ))}
        {unassigned.length > 0 && (
          <div>
            <p className="text-xs text-[var(--muted)]">Retrieved sources</p>
            <SearchResultLinks sources={unassigned} />
          </div>
        )}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

function SearchResultLinks({ sources }: { sources: ActivitySource[] }) {
  const unique = new Map<string, ActivitySource & { domain: string }>();
  for (const source of sources) {
    const result = safeSource(source);
    if (result && !unique.has(result.url)) unique.set(result.url, result);
  }
  const safe = [...unique.values()];
  if (!safe.length) return <p className="text-xs text-[var(--muted)]">No sources returned.</p>;
  return (
    <ul className="research-results">
      {safe.map((source) => (
        <li key={source.url}>
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            {source.title || source.domain}
          </a>
          <span>{source.domain}</span>
        </li>
      ))}
    </ul>
  );
}

export function ResponseSources({ parts }: { parts: Parts }) {
  const uniqueSources = Array.from(
    sourcesOf(parts).reduce((result, source) => {
      const safe = safeSource(source);
      if (safe && !result.has(safe.url)) result.set(safe.url, safe);
      return result;
    }, new Map<string, ActivitySource & { domain: string }>()),
    ([, source]) => source,
  );
  if (!uniqueSources.length) return null;

  return (
    <Sources className="mt-2" aria-label="Response sources">
      <SourcesTrigger count={uniqueSources.length} />
      <SourcesContent>
        {uniqueSources.map((source) => (
          <Source key={source.url} href={source.url} title={source.title?.trim() || source.url}>
            {source.title?.trim() || source.domain}
          </Source>
        ))}
      </SourcesContent>
    </Sources>
  );
}
